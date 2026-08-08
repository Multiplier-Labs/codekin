/**
 * Connector-side REST proxy: turns a relay `request` envelope into a call
 * against the local Codekin server on 127.0.0.1, injecting the local bearer
 * token so the machine credential — not the browser — is what authorizes
 * access to the local API.
 *
 * Everything not on the allowlist is refused here, on the machine. The relay
 * is not trusted to scope requests (spec §5.2): even a fully compromised hub
 * can only reach the paths below.
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  MAX_PROXY_BODY_BYTES,
  RELAY_ERROR,
} from './relay-protocol.js'
import type { ProxyRequest, ProxyResponse, RelayError } from './relay-protocol.js'

/**
 * Paths the hosted UI may read, matched as prefixes against the path (query
 * string excluded).
 */
export const ALLOWED_GET_PREFIXES = [
  '/auth-verify',
  '/api/health',
  '/api/sessions',
  '/api/repos',
  '/api/claude/models',
  '/api/codex/models',
  '/api/opencode/models',
  '/api/opencode/commands',
  '/api/settings',
  '/api/approvals',
  '/api/docs',
  '/api/browse-dirs',
  '/api/orchestrator',
] as const

/**
 * Paths the hosted UI may change. Kept separate from the read list so that
 * widening reads never silently widens writes — running a session needs
 * these, browsing does not.
 */
export const ALLOWED_MUTATION_PREFIXES = [
  '/auth-verify',
  '/api/sessions',
  '/api/settings',
  '/api/approvals',
  '/api/upload',
  '/api/orchestrator',
] as const

/** Methods that may be proxied at all. */
const READ_METHODS = new Set(['GET', 'HEAD'])
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Response headers worth forwarding; the rest are connector-local noise. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag']

export interface ProxyDecision {
  allowed: boolean
  error?: RelayError
}

/** Decide whether a proxied request may proceed to the local server. */
export function checkProxyRequest(req: ProxyRequest): ProxyDecision {
  const method = (req.method || '').toUpperCase()
  const isRead = READ_METHODS.has(method)
  if (!isRead && !MUTATION_METHODS.has(method)) {
    return {
      allowed: false,
      error: { code: RELAY_ERROR.pathNotAllowed, message: `Method ${method || '(none)'} is not proxied` },
    }
  }

  if (typeof req.path !== 'string' || !req.path.startsWith('/')) {
    return { allowed: false, error: { code: RELAY_ERROR.badRequest, message: 'Path must start with /' } }
  }
  // Reject anything that could escape the prefix check or address another host.
  if (req.path.startsWith('//') || req.path.includes('..') || req.path.includes('\\')) {
    return { allowed: false, error: { code: RELAY_ERROR.badRequest, message: 'Malformed path' } }
  }

  const pathname = req.path.split('?')[0]
  const prefixes: readonly string[] = isRead ? ALLOWED_GET_PREFIXES : ALLOWED_MUTATION_PREFIXES
  const allowed = prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
  if (!allowed) {
    return {
      allowed: false,
      error: { code: RELAY_ERROR.pathNotAllowed, message: `${method} ${pathname} is not proxied` },
    }
  }

  return { allowed: true }
}

export interface LocalServerTarget {
  /** Origin of the local Codekin server, e.g. http://127.0.0.1:32352 */
  origin: string
  /** Bearer token for the local server, when one is configured. */
  authToken: string
  /**
   * Origin header to present on the local WebSocket. A production local
   * server only accepts `Origin === CORS_ORIGIN` (cross-site hijacking
   * defense); the connector is not a browser, so it has to be told which
   * origin to claim. Left undefined in dev, where a missing Origin is fine.
   */
  browserOrigin?: string
}

const DEFAULT_LOCAL_PORT = 32352

/**
 * Locate the local Codekin server and its auth token, using the same
 * sources as `codekin start`: env first, then ~/.config/codekin/token.
 *
 * `RELAY_LOCAL_ORIGIN` overrides the Origin presented on the local
 * WebSocket; otherwise the server's own `CORS_ORIGIN` is used when the
 * connector shares its environment.
 */
export function resolveLocalTarget(env: NodeJS.ProcessEnv = process.env): LocalServerTarget {
  const port = parseInt(env.PORT || String(DEFAULT_LOCAL_PORT), 10)
  const origin = env.CODEKIN_LOCAL_URL || `http://127.0.0.1:${port}`
  const browserOrigin = env.RELAY_LOCAL_ORIGIN || env.CORS_ORIGIN || undefined

  let authToken = env.AUTH_TOKEN ?? ''
  if (!authToken) {
    const tokenFile = env.AUTH_TOKEN_FILE || join(homedir(), '.config', 'codekin', 'token')
    if (existsSync(tokenFile)) {
      try {
        authToken = readFileSync(tokenFile, 'utf-8').trim()
      } catch {
        // Unreadable token file: proceed unauthenticated and let the local
        // server answer 401 rather than failing the whole connector.
      }
    }
  }

  return { origin, authToken, browserOrigin }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface ProxyExecutionOptions {
  target: LocalServerTarget
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** Result of a proxy attempt: either a response to relay back, or an error. */
export type ProxyOutcome = { response: ProxyResponse } | { error: RelayError }

/**
 * Execute an allowlisted request against the local server and package the
 * result for the relay. Local failures become relay errors rather than
 * synthetic HTTP statuses, so the browser can tell "your machine is
 * unreachable" from "your machine said 502".
 */
export async function executeProxyRequest(
  req: ProxyRequest,
  opts: ProxyExecutionOptions,
): Promise<ProxyOutcome> {
  const decision = checkProxyRequest(req)
  if (!decision.allowed) return { error: decision.error! }

  const fetchImpl = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.target.authToken) {
    headers.Authorization = `Bearer ${opts.target.authToken}`
  }
  if (req.contentType) {
    headers['Content-Type'] = req.contentType
  }

  let body: Buffer | undefined
  if (req.body) {
    body = Buffer.from(req.body, 'base64')
    if (body.byteLength > MAX_PROXY_BODY_BYTES) {
      return {
        error: {
          code: RELAY_ERROR.bodyTooLarge,
          message: `Request of ${body.byteLength} bytes exceeds the relay limit`,
        },
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, opts.timeoutMs ?? 20_000)

  try {
    const res = await fetchImpl(`${opts.target.origin}${req.path}`, {
      method: req.method.toUpperCase(),
      headers,
      body: body as unknown as BodyInit | undefined,
      signal: controller.signal,
    })

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > MAX_PROXY_BODY_BYTES) {
      return {
        error: {
          code: RELAY_ERROR.bodyTooLarge,
          message: `Response of ${buffer.byteLength} bytes exceeds the relay limit`,
        },
      }
    }

    const responseHeaders: Record<string, string> = {}
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = res.headers.get(name)
      if (value !== null) responseHeaders[name] = value
    }

    return {
      response: {
        status: res.status,
        headers: responseHeaders,
        body: buffer.byteLength > 0 ? buffer.toString('base64') : undefined,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      error: {
        code: RELAY_ERROR.localUnreachable,
        message: `Local Codekin server did not answer: ${message}`,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
