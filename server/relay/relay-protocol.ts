/**
 * Relay wire protocol (spec §7): JSON envelopes over WebSocket, shared by
 * the hub, the connector, and the browser client. Stream kinds
 * (stream_open etc.) are declared for forward compatibility but unused
 * until the session-streaming phase.
 */

export const RELAY_PROTOCOL_VERSION = 1

export type RelayEnvelopeKind =
  | 'hello'
  | 'hello_ack'
  | 'request'
  | 'response'
  | 'stream_open'
  | 'stream_data'
  | 'stream_close'
  | 'event'
  | 'error'
  | 'ping'
  | 'pong'

export interface RelayEnvelope<T = unknown> {
  version: typeof RELAY_PROTOCOL_VERSION
  /** Correlates request/response pairs. */
  id?: string
  /** Identifies long-lived streams (proxied Codekin WebSocket sessions). */
  channelId?: string
  kind: RelayEnvelopeKind
  payload: T
}

/** Connector → hub, first message on the socket. */
export interface ConnectorHello {
  machineId: string
  machineSecret: string
  connectorVersion: string
  localCodekinVersion?: string
  capabilities: {
    restProxy: boolean
    wsProxy: boolean
    fileUpload: boolean
    providers: string[]
  }
}

/** Hub → connector on successful auth. */
export interface ConnectorHelloAck {
  machineId: string
  displayName: string
}

/** Browser → hub, first message on a /relay/browser socket. */
export interface BrowserHello {
  /** Machine whose local Codekin server this socket proxies to. */
  machineId: string
  clientVersion?: string
}

/** Hub → browser on successful auth + ACL check. */
export interface BrowserHelloAck {
  machineId: string
  displayName: string
  online: boolean
}

/**
 * A proxied REST call. Travels browser → hub → connector; the hub fills in
 * `machineId` from the socket's binding, so a client cannot retarget a
 * request at another machine mid-connection.
 */
export interface ProxyRequest {
  method: string
  /** Local server path including query string, e.g. '/api/sessions/list?x=1'. */
  path: string
  headers?: Record<string, string>
  /** base64-encoded request body, omitted when there is none. */
  body?: string
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  /** base64-encoded response body, omitted when empty. */
  body?: string
}

export interface RelayError {
  code: string
  message: string
}

/** Error codes used on the request/response path (spec §7.4). */
export const RELAY_ERROR = {
  machineOffline: 'machine_offline',
  forbidden: 'forbidden',
  pathNotAllowed: 'path_not_allowed',
  timeout: 'timeout',
  bodyTooLarge: 'body_too_large',
  badRequest: 'bad_request',
  localUnreachable: 'local_unreachable',
} as const

/** Max size of a proxied request or response body, before base64 expansion. */
export const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024

/** A proxied request unanswered for this long is failed with `timeout`. */
export const PROXY_REQUEST_TIMEOUT_MS = 30_000

export function envelope<T>(kind: RelayEnvelopeKind, payload: T, extra?: Partial<RelayEnvelope<T>>): RelayEnvelope<T> {
  return { version: RELAY_PROTOCOL_VERSION, kind, payload, ...extra }
}

/** Parse an incoming frame; returns null on malformed input. */
export function parseEnvelope(data: unknown): RelayEnvelope | null {
  try {
    const raw = typeof data === 'string' ? data : String(data)
    const msg = JSON.parse(raw) as { version?: unknown; kind?: unknown }
    if (msg.version !== (RELAY_PROTOCOL_VERSION as number) || typeof msg.kind !== 'string') return null
    return msg as RelayEnvelope
  } catch {
    return null
  }
}
