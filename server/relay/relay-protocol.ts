/**
 * Relay wire protocol (spec §7): JSON envelopes over WebSocket, shared by
 * the hub, the connector, and the browser client.
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

/**
 * A machine's live session counts, re-advertised on every (re)connect so the
 * hub's view survives a relay restart without waiting for a browser to ask
 * (spec §11.3).
 */
export interface LocalSessionSummary {
  total: number
  active: number
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
  /** Omitted when the local server could not be reached at connect time. */
  sessions?: LocalSessionSummary
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
 * The caller's standing on a machine, attached by the hub to everything it
 * forwards. The connector re-checks against this rather than trusting that
 * the hub filtered correctly (spec §5.2).
 */
export interface RelayPrincipal {
  userId: string
  role: 'owner' | 'grantee'
  /** Session id → permissions. Empty for owners. */
  grants: Record<string, string[]>
}

/**
 * A proxied REST call. Travels browser → hub → connector; the hub attaches
 * the principal from the socket's binding, so a client cannot claim
 * permissions it was not granted.
 */
export interface ProxyRequest {
  method: string
  /** Local server path including query string, e.g. '/api/sessions/list?x=1'. */
  path: string
  /** Who is asking. Absent only from legacy frames, which are refused. */
  principal?: RelayPrincipal
  /**
   * Content type of `body`. This is the only browser-supplied header that
   * crosses the relay — everything else (notably Authorization) is the
   * connector's to set, so a browser cannot forge local credentials.
   */
  contentType?: string
  /** base64-encoded request body, omitted when there is none. */
  body?: string
}

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  /** base64-encoded response body, omitted when empty. */
  body?: string
}

/**
 * Open a proxied session-stream channel: the connector opens the local
 * Codekin WebSocket, performs the local `auth` handshake with its own
 * token, and pipes frames opaquely from then on.
 *
 * Channel ids are scoped to the socket that created them; the hub maps a
 * browser's id onto a hub-generated id before it reaches a connector, so
 * ids from one browser can never name another's channel.
 */
export interface StreamOpen {
  /** Who the channel belongs to, so the connector can police its frames. */
  principal?: RelayPrincipal
}

/** Connector → browser once the local socket is open and authenticated. */
export interface StreamReady {
  status: 'open'
}

/** One frame in either direction, passed through without interpretation. */
export interface StreamData {
  /** The local Codekin protocol frame, verbatim JSON text. */
  data: string
}

export interface StreamClose {
  code?: number
  reason?: string
}

export interface RelayError {
  code: string
  message: string
}

/** Error codes used on the request/response and stream paths (spec §7.4). */
export const RELAY_ERROR = {
  machineOffline: 'machine_offline',
  forbidden: 'forbidden',
  pathNotAllowed: 'path_not_allowed',
  timeout: 'timeout',
  bodyTooLarge: 'body_too_large',
  badRequest: 'bad_request',
  localUnreachable: 'local_unreachable',
  tooManyChannels: 'too_many_channels',
  unknownChannel: 'unknown_channel',
  notPermitted: 'not_permitted',
} as const

/** Close codes on proxied stream channels, mirroring the local server's conventions. */
export const STREAM_CLOSE = {
  /** The local server rejected the connector's credential. */
  localAuthFailed: 4001,
  /** The machine went offline while the channel was open. */
  machineGone: 4002,
  normal: 1000,
} as const

/** Channels a single browser socket may hold open at once. */
export const MAX_CHANNELS_PER_CLIENT = 4

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
