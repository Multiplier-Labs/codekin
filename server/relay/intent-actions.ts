/**
 * What a signed intent says, worked out the same way by the browser (which
 * signs) and the connector (which verifies) —
 * docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §6.1–6.2, §6.4.
 *
 * Imported by both sides, so it must stay free of Node and DOM imports. Every
 * rule here is applied identically on both ends; a difference would make
 * honest intents fail verification.
 */

export const INTENT_VERSION = 1

/** Max size of an intent body; real ones are ~300 bytes. */
export const MAX_INTENT_BODY_CHARS = 4096

/** How far an intent's timestamp may be from the machine's clock (§6.4 step 6). */
export const INTENT_MAX_SKEW_MS = 5 * 60_000

/**
 * Domain label for the machine's signature over its clock on an
 * `intent_stale` refusal: sign_kM(T(label, nonce, String(machineTime))). The
 * browser adopts the time only if it verifies against the pinned machine key,
 * so a relay can't shift the browser's clock.
 */
export const MACHINE_TIME_LABEL = 'ck-intent-time-v1'

/** How large a clock offset the browser will apply after a stale refusal (§6.5). */
export const MAX_CLOCK_OFFSET_MS = 60 * 60_000

export interface IntentBody {
  v: 1
  machineId: string
  /** Session the action targets; null for machine-level actions. */
  sessionId: string | null
  /** 'ws:<frame type>' | 'rest:<METHOD> <pathname>' | 'channel:open' */
  action: string
  /** base64url SHA-256 of payloadBytes(...) for this message. */
  payloadHash: string
  /** 16 random bytes, base64url. */
  nonce: string
  /** Browser clock (with any offset applied), ms since epoch. */
  ts: number
  keyId: string
  /**
   * Stream frames and channel opens: a random token the browser picks for the
   * channel, fixed by its signed `channel:open`. Frames for another channel
   * are refused.
   */
  channel?: string
  /** Stream frames: 1, 2, 3… per channel. The machine refuses any that go backwards. */
  seq?: number
}

export interface SignedIntent {
  /** JSON.stringify(IntentBody), signed exactly as these bytes. */
  body: string
  /** base64url P1363 ECDSA P-256/SHA-256 over UTF-8(body). */
  sig?: string
  /** Passkey-signed intents (step-up, slice 5). */
  webauthn?: { authenticatorData: string; clientDataJSON: string; signature: string }
}

/** Why a connector refused (or, in warn mode, would have refused) an intent. */
export type IntentRefusal =
  | 'intent_required'
  | 'intent_malformed'
  | 'intent_unknown_key'
  | 'intent_wrong_signer'
  | 'intent_bad_signature'
  | 'intent_wrong_machine'
  | 'intent_wrong_action'
  | 'intent_wrong_payload'
  | 'intent_wrong_session'
  | 'intent_stale'
  | 'intent_replayed'
  | 'intent_unsupported'
  | 'intent_wrong_channel'
  | 'intent_out_of_order'
  | 'intent_rate_limited'

/**
 * Stream frames that carry nothing and need no intent (§2.2). `auth` is
 * answered by the connector from its cached handshake and never reaches the
 * local server.
 */
export const EXEMPT_FRAME_TYPES: ReadonlySet<string> = new Set(['ping', 'resize', 'auth'])

const encoder = new TextEncoder()

/** The `type` of a local protocol frame, or null. */
export function frameType(frame: string): string | null {
  try {
    const parsed = JSON.parse(frame) as { type?: unknown } | null
    return typeof parsed?.type === 'string' ? parsed.type : null
  } catch {
    return null
  }
}

function frameSessionId(frame: string): string | null | undefined {
  try {
    const parsed = JSON.parse(frame) as { sessionId?: unknown } | null
    if (parsed && 'sessionId' in parsed) return typeof parsed.sessionId === 'string' ? parsed.sessionId : null
  } catch { /* fall through */ }
  return undefined
}

export function isExemptFrame(frame: string): boolean {
  const type = frameType(frame)
  return type !== null && EXEMPT_FRAME_TYPES.has(type)
}

/** 'ws:<type>'; 'ws:?' for a frame without one (which the policy refuses anyway). */
export function frameAction(frame: string): string {
  return `ws:${frameType(frame) ?? '?'}`
}

/**
 * The session a stream frame acts on: its own `sessionId` when it names one
 * (`join_session` always does), otherwise the session the channel joined.
 */
export function frameSession(frame: string, channelSession: string | null): string | null {
  const own = frameSessionId(frame)
  return typeof own === 'string' ? own : channelSession
}

/** The session marker after `create_session` (frame `seq`), see channelSessionAfter. */
export function createdSessionMarker(seq: number | undefined): string {
  return `@created:${seq ?? '?'}`
}

/**
 * The channel's session after this frame, tracked from client frames only, so
 * both ends agree without trusting anything the relay relays back.
 * `create_session` joins the socket to the new session on the machine, whose
 * id neither end knows yet, so the channel moves to a marker naming that
 * create frame: later frames are bound to "the session created by frame N",
 * which is what they act on.
 */
export function channelSessionAfter(frame: string, channelSession: string | null, seq?: number): string | null {
  const type = frameType(frame)
  if (type === 'join_session') return frameSession(frame, null)
  if (type === 'leave_session') return null
  if (type === 'create_session') return createdSessionMarker(seq)
  return channelSession
}

/** Length of a channel token in characters (16 random bytes, base64url). */
export const CHANNEL_TOKEN_CHARS = 22

/** 'rest:<METHOD> <pathname>'; the query string is covered by the payload hash. */
export function requestAction(method: string, path: string): string {
  const q = path.indexOf('?')
  return `rest:${method.toUpperCase()} ${q === -1 ? path : path.slice(0, q)}`
}

const SESSION_COLLECTION_ROUTES = new Set(['list', 'create', 'archived'])

/** The session a REST path names, if any: /api/sessions/<id>[/…] and /api/sessions/archived/<id>. */
export function requestSession(path: string): string | null {
  const q = path.indexOf('?')
  const segments = (q === -1 ? path : path.slice(0, q)).split('/')
  if (segments[1] !== 'api' || segments[2] !== 'sessions' || !segments[3]) return null
  if (segments[3] === 'archived') return segments[4] || null
  return SESSION_COLLECTION_ROUTES.has(segments[3]) ? null : segments[3]
}

export const CHANNEL_OPEN_ACTION = 'channel:open'

/** The bytes a stream frame's payloadHash covers: the frame exactly as forwarded. */
export function framePayload(frame: string): Uint8Array {
  return encoder.encode(frame)
}

/**
 * The bytes a REST request's payloadHash covers: method, path with query,
 * content type and body, each as a 4-byte big-endian length then its bytes,
 * so no field can bleed into the next.
 */
export function requestPayload(method: string, path: string, contentType: string | undefined, body: Uint8Array | null): Uint8Array {
  const fields = [encoder.encode(method.toUpperCase()), encoder.encode(path), encoder.encode(contentType ?? ''), body ?? new Uint8Array(0)]
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0))
  const view = new DataView(out.buffer)
  let offset = 0
  for (const f of fields) {
    view.setUint32(offset, f.length)
    out.set(f, offset + 4)
    offset += 4 + f.length
  }
  return out
}

/** A channel open covers no bytes. */
export function channelOpenPayload(): Uint8Array {
  return new Uint8Array(0)
}
