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
 * Paths the hosted UI may reach, matched as prefixes against the path (query
 * string excluded). Read-only endpoints only for now; mutating routes join
 * the list as the hosted UI grows to need them.
 */
export const ALLOWED_GET_PREFIXES = [
  '/api/health',
  '/api/sessions/list',
  '/api/sessions/archived',
  '/api/repos',
  '/api/claude/models',
  '/api/codex/models',
  '/api/opencode/models',
  '/api/orchestrator/status',
  '/api/orchestrator/sessions',
  '/api/orchestrator/dashboard',
] as const

/** Methods that may be proxied at all. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])

/** Response headers worth forwarding; the rest are connector-local noise. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag']

export interface ProxyDecision {
  allowed: boolean
  error?: RelayError
}

/** Decide whether a proxied request may proceed to the local server. */
export function checkProxyRequest(req: ProxyRequest): ProxyDecision {
  const method = (req.method || '').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
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
  const allowed = ALLOWED_GET_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
  if (!allowed) {
    return {
      allowed: false,
      error: { code: RELAY_ERROR.pathNotAllowed, message: `Path ${pathname} is not proxied` },
    }
  }

  return { allowed: true }
}

export interface LocalServerTarget {
  /** Origin of the local Codekin server, e.g. http://127.0.0.1:32352 */
  origin: string
  /** Bearer token for the local server, when one is configured. */
  authToken: string
}

const DEFAULT_LOCAL_PORT = 32352

/**
 * Locate the local Codekin server and its auth token, using the same
 * sources as `codekin start`: env first, then ~/.config/codekin/token.
 */
export function resolveLocalTarget(env: NodeJS.ProcessEnv = process.env): LocalServerTarget {
  const port = parseInt(env.PORT || String(DEFAULT_LOCAL_PORT), 10)
  const origin = env.CODEKIN_LOCAL_URL || `http://127.0.0.1:${port}`

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

  return { origin, authToken }
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

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, opts.timeoutMs ?? 20_000)

  try {
    const res = await fetchImpl(`${opts.target.origin}${req.path}`, {
      method: req.method.toUpperCase(),
      headers,
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
