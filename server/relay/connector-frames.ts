/**
 * Shape checks for what the relay sends the connector. Payloads arrive as
 * parsed JSON and the relay may be compromised (signed-intents spec §2), so
 * nothing is trusted to match the protocol types: a frame that doesn't is
 * refused or ignored, never allowed to throw inside the socket handler.
 */

import type { ProxyRequest, RelayPrincipal, StreamClose, StreamData, StreamOpen } from './relay-protocol.js'
import { STREAM_CLOSE } from './relay-protocol.js'

/** WebSocket close reasons are capped at 123 bytes of UTF-8. */
const MAX_CLOSE_REASON_BYTES = 123

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(v => typeof v === 'string')
}

/** A principal as the hub attaches it, or null when it isn't one. */
export function asPrincipal(value: unknown): RelayPrincipal | null {
  if (!isRecord(value)) return null
  if (typeof value.userId !== 'string') return null
  if (value.role !== 'owner' && value.role !== 'grantee' && value.role !== 'webhook') return null
  if (!isRecord(value.grants)) return null
  for (const perms of Object.values(value.grants)) {
    if (!Array.isArray(perms) || !perms.every(p => typeof p === 'string')) return null
  }
  if (value.signedGrants !== undefined && !Array.isArray(value.signedGrants)) return null
  return value as unknown as RelayPrincipal
}

/** A proxied request, or null when its fields aren't the protocol's types. */
export function asProxyRequest(value: unknown): ProxyRequest | null {
  if (!isRecord(value)) return null
  if (typeof value.method !== 'string' || typeof value.path !== 'string') return null
  if (!optionalString(value.contentType) || !optionalString(value.body)) return null
  if (value.headers !== undefined && !isStringRecord(value.headers)) return null
  // Absent stays absent (refused downstream as a legacy frame); malformed is refused here.
  if (value.principal !== undefined && !asPrincipal(value.principal)) return null
  return value as unknown as ProxyRequest
}

/** A channel open. A malformed principal is dropped, so the open is refused for carrying none. */
export function asStreamOpen(value: unknown): StreamOpen {
  if (!isRecord(value)) return {}
  return { principal: asPrincipal(value.principal) ?? undefined, intent: value.intent as StreamOpen['intent'] }
}

/** A channel frame, or null when it carries no text. */
export function asStreamData(value: unknown): StreamData | null {
  if (!isRecord(value) || typeof value.data !== 'string') return null
  return { data: value.data, intent: value.intent as StreamData['intent'] }
}

/** A close code `ws` will accept from an application. */
export function safeCloseCode(code: unknown): number {
  return typeof code === 'number' && Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999))
    ? code
    : STREAM_CLOSE.normal
}

/** A close reason trimmed to what fits in a close frame (a split surrogate is encoded as U+FFFD, still valid). */
export function safeCloseReason(reason: unknown, fallback: string): string {
  let text = (typeof reason === 'string' ? reason : fallback).slice(0, MAX_CLOSE_REASON_BYTES)
  while (Buffer.byteLength(text, 'utf-8') > MAX_CLOSE_REASON_BYTES) text = text.slice(0, -1)
  return text
}

/** A channel close with its code and reason made safe to pass to `ws.close`. */
export function asStreamClose(value: unknown, fallbackReason: string): Required<StreamClose> {
  const close = isRecord(value) ? value : {}
  return { code: safeCloseCode(close.code), reason: safeCloseReason(close.reason, fallbackReason) }
}
