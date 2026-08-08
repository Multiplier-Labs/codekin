/**
 * Relay wire protocol (spec §7): JSON envelopes over WebSocket, shared by
 * the hub and the connector. Browser-side stream kinds (stream_open etc.)
 * are declared for forward compatibility but unused until the REST/WS proxy
 * phases.
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

export interface RelayError {
  code: string
  message: string
}

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
