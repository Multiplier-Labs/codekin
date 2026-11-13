/**
 * Shared REST helper for the Codekin server API clients in src/lib.
 *
 * Every request goes through the active transport (src/lib/transport), so it
 * works the same in local mode (the /cc proxy) and hosted mode (the relay).
 * The transport binding is read per call, so a hosted machine switch is
 * picked up without re-importing anything.
 *
 * Each call site keeps its own error message: `error` names the fallback,
 * `serverMessage` says which error-body fields may override it, and
 * `unreadable` covers an error body that is not JSON.
 */

import { transport } from './transport'

/** How the request is built and sent. */
export interface SendOptions {
  method?: string
  /** Sent as `Authorization: Bearer <token>`. Omitted when undefined. */
  token?: string
  /** JSON-serialised request body. Implies `Content-Type: application/json`. */
  body?: unknown
  /** Body sent as-is (e.g. FormData uploads). No Content-Type is added. */
  rawBody?: BodyInit
  /** Send `Content-Type: application/json` even without a body. Defaults to whether `body` is set. */
  jsonHeader?: boolean
  /**
   * Use `transport.authFetch`, which detects an expired hosting-environment
   * session (Authelia locally, the control plane when hosted), redirects to
   * login and rejects with `Error('Session expired')`. Default: plain fetch.
   */
  authFetch?: boolean
}

/** How a non-ok response becomes an Error. */
export interface ErrorOptions {
  /**
   * Message when the server gives none. A string is a prefix and becomes
   * `${error}: ${status}`; a function gets the status and returns the message.
   */
  error: string | ((status: number) => string)
  /**
   * Error-body fields that carry the server's own message, tried in order.
   * The first non-empty string wins. Default: the body is not read.
   */
  serverMessage?: ReadonlyArray<'error' | 'message'>
  /** Message when the error body cannot be parsed as JSON. Default: the `error` message. */
  unreadable?: string
}

/** How a successful response is read. */
export type ParseMode = 'json' | 'text' | 'none'

export interface RequestOptions extends SendOptions, ErrorOptions {
  /** `json` (default), `text`, or `none` (body ignored, resolves undefined). */
  parse?: ParseMode
}

/** Build the RequestInit for a call. Only keys that are set are included. */
export function buildInit(opts: SendOptions = {}): RequestInit {
  const headers: Record<string, string> = {}
  if (opts.jsonHeader ?? opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`
  const init: RequestInit = {}
  if (opts.method) init.method = opts.method
  init.headers = headers
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  else if (opts.rawBody !== undefined) init.body = opts.rawBody
  return init
}

/** Send a request through the active transport and return the raw Response. */
export function send(path: string, opts: SendOptions = {}): Promise<Response> {
  const init = buildInit(opts)
  return opts.authFetch ? transport.authFetch(path, init) : transport.fetch(path, init)
}

/** Read a response body as JSON. The single unavoidable `unknown` → `T` assertion. */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** The Error a non-ok response should reject with, per the call site's options. */
export async function failure(res: Response, opts: ErrorOptions): Promise<Error> {
  const fallback = typeof opts.error === 'string' ? `${opts.error}: ${res.status}` : opts.error(res.status)
  if (!opts.serverMessage?.length) return new Error(fallback)
  let body: Record<string, unknown>
  try {
    body = (await readJson<Record<string, unknown> | null>(res)) ?? {}
  } catch {
    return new Error(opts.unreadable ?? fallback)
  }
  for (const field of opts.serverMessage) {
    const value = body[field]
    if (typeof value === 'string' && value) return new Error(value)
  }
  return new Error(fallback)
}

/**
 * Send a request, reject with the call site's message on a non-ok status,
 * and read the body per `parse`.
 */
export async function request<T = unknown>(path: string, opts: RequestOptions): Promise<T> {
  const res = await send(path, opts)
  if (!res.ok) throw await failure(res, opts)
  switch (opts.parse ?? 'json') {
    case 'none': return undefined as T
    case 'text': return (await res.text()) as T
    default: return readJson<T>(res)
  }
}

/**
 * Agent Joe endpoints (/api/orchestrator/tasks, /maintenance, /sessions):
 * plain transport fetch, rejecting with the server's `error` text or
 * `Request failed (<status>)`. Shared by tasksApi, maintenanceApi and joeApi.
 */
export function joeRequest<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(path, {
    method: init.method ?? 'GET',
    token,
    body: init.body,
    serverMessage: ['error'],
    error: status => `Request failed (${status})`,
  })
}
