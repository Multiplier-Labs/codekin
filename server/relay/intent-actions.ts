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

/**
 * Domain label for the machine's answer to a clock probe (enrol_time):
 * sign_kM(T(label, nonce, String(machineTime))). The owner's browser dates
 * share grants by it (§6.7).
 */
export const MACHINE_CLOCK_LABEL = 'ck-machine-clock-v1'

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
  /**
   * A passkey assertion whose challenge is SHA-256(UTF-8(body)) (§6.4 step 3).
   * `credentialId` names the passkey; the body's keyId is its key id, or
   * PASSKEY_ANY when the browser let the user pick (device_certify).
   */
  webauthn?: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }
}

/** keyId of a passkey intent signed by whichever enrolled passkey the user chose. */
export const PASSKEY_ANY = '*'

/**
 * Passkey challenges are domain-separated, so an assertion made for one
 * purpose can never count for another:
 *   machine intent     SHA-256(T("ck-intent-v1", UTF-8(body)))
 *   enrolment proof    SHA-256(T(PASSKEY_PROOF_LABEL, SPKI(kB), nonceB))
 *   relay sign-in/MFA  SHA-256(T("ck-relay-auth-v1", relay challenge))
 * The last one matters most: the relay picks its own challenges, and if the
 * browser passed them to the authenticator raw, a relay could ask for a
 * "sign-in" whose challenge is the hash of an intent it wrote.
 */
export const INTENT_CHALLENGE_LABEL = 'ck-intent-v1'
export const RELAY_AUTH_LABEL = 'ck-relay-auth-v1'

/** T(label, ...parts): length-prefixed, like the enrolment transcripts. */
export function domainSeparated(label: string, ...parts: Uint8Array[]): Uint8Array {
  return framed([encoder.encode(label), ...parts])
}

/** The bytes whose SHA-256 is a passkey intent's WebAuthn challenge. */
export function intentChallengeInput(body: string): Uint8Array {
  return domainSeparated(INTENT_CHALLENGE_LABEL, encoder.encode(body))
}

/** The passkey proofs as the enrolment's proof-of-possession signature covers them. */
export function encodePasskeyProofs(proofs: ReadonlyArray<{ credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }>): string {
  return JSON.stringify(proofs.map(p => [p.credentialId, p.authenticatorData, p.clientDataJSON, p.signature]))
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
  | 'intent_step_up_required'
  | 'intent_local_only'

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
  return framed([encoder.encode(method.toUpperCase()), encoder.encode(path), encoder.encode(contentType ?? ''), body ?? new Uint8Array(0)])
}

function framed(fields: Uint8Array[]): Uint8Array {
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

// --- Device intents (§5.4, §5.6) ---------------------------------------------

export const DEVICE_CERTIFY_ACTION = 'device_certify'
export const DEVICE_REVOKE_ACTION = 'device_revoke'

/** What a device_certify intent covers: the browser key being added and its label. */
export function certifyPayload(spki: string, label: string): Uint8Array {
  return framed([encoder.encode(spki), encoder.encode(label)])
}

/** What a device_revoke intent covers: the key id being removed. */
export function revokePayload(keyId: string): Uint8Array {
  return framed([encoder.encode(keyId)])
}

/**
 * Domain label for the passkey proof in an enrolment (§5.2 as built): the
 * browser asserts with challenge SHA-256(T(label, SPKI(kB), nonceB)) before it
 * commits, so a passkey public key the relay slipped into the list can't be
 * enrolled — the user's authenticator can't sign for it.
 */
export const PASSKEY_PROOF_LABEL = 'ck-enrol-passkey-v1'

// --- Step-up (§6.2, §6.6) ------------------------------------------------------

/** Prompt answers that save a standing approval rule. */
const STANDING_ANSWERS = new Set(['always_allow', 'approve_pattern'])

/** Permission modes that stop asking before tools run. */
const AUTO_APPROVE_MODES = new Set(['bypassPermissions', 'dangerouslySkipPermissions'])

/** Pre-approved tools (`--allowedTools`) are a standing rule too: `["Bash"]` approves every command. */
const preApprovesTools = (value: unknown) => Array.isArray(value) && value.length > 0

const answersStanding = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).some(v => typeof v === 'string' && STANDING_ANSWERS.has(v))

/** Route identity as Express matches it: case-insensitive, trailing slash ignored. */
function routeOf(path: string): string {
  const q = path.indexOf('?')
  const pathname = (q === -1 ? path : path.slice(0, q)).replace(/\/+$/, '')
  return (pathname || '/').toLowerCase()
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Whether a stream frame is a privileged action (§6.2): a standing approval
 * rule, or anything that turns on bypass permissions. Those need a passkey
 * when the signer has one on the machine.
 */
export function frameNeedsStepUp(frame: string): boolean {
  const msg = parsed(frame)
  if (!msg) return false
  switch (msg.type) {
    case 'prompt_response':
      return answersStanding(msg.value)
    case 'create_session':
      return (typeof msg.permissionMode === 'string' && AUTO_APPROVE_MODES.has(msg.permissionMode)) || preApprovesTools(msg.allowedTools)
    case 'set_permission_mode':
      return typeof msg.permissionMode === 'string' && AUTO_APPROVE_MODES.has(msg.permissionMode)
    default:
      return false
  }
}

/**
 * Whether a REST request is a privileged action (§6.2): creating a session
 * in an auto-approve mode, or answering a prompt with a standing rule through
 * the orchestrator. Routes match the way Express does. A body that doesn't
 * read as UTF-8 JSON counts as privileged: the local server might parse it
 * (another charset) where this can't.
 */
export function requestNeedsStepUp(method: string, path: string, body: Uint8Array | null): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const route = routeOf(path)
  // Creating a session, or an orchestrator child session, in an auto-approve
  // mode or with pre-approved tools.
  const isCreate = route === '/api/sessions/create' || route === '/api/orchestrator/children'
  const isRespond = /^\/api\/orchestrator\/sessions\/[^/]+\/respond$/.test(route)
  if (!isCreate && !isRespond) return false
  if (!body || body.length === 0) return false
  let msg: Record<string, unknown> | null
  try {
    msg = parsed(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return true
  }
  if (!msg) return true
  return isCreate
    ? (typeof msg.permissionMode === 'string' && AUTO_APPROVE_MODES.has(msg.permissionMode)) || preApprovesTools(msg.allowedTools)
    : answersStanding(msg.value)
}

// --- Share grants (§6.7) --------------------------------------------------------

export const GRANT_ACTION = 'grant'
export const GRANT_REVOKE_ACTION = 'grant_revoke'

/** The longest a signed grant lives, whatever the share says (D3). */
export const MAX_GRANT_LIFETIME_MS = 30 * 24 * 60 * 60_000

/** What an owner signs to let one person act on one session of one machine. */
export interface GrantBody {
  /** `<share id>:<issued>`: the relay's share id, then when this grant was first signed (grantIssuedAt). */
  grantId: string
  sessionId: string
  granteeUserId: string
  permissions: string[]
  /** The grantee's browser keys allowed to act under this grant. */
  granteeKeys: Array<{ keyId: string; spki: string }>
  /** ms since epoch; at most 30 days after signing, never past the share's expiry. */
  expiresAt: number
  /**
   * The share's own end as the owner chose it (ms), or null for none. Signed,
   * so renewal can never carry a grant past it, whatever the relay lists.
   */
  notAfter?: number | null
}

/** Domain label for the machine's confirmation that it recorded a grant revocation. */
export const GRANT_REVOKED_LABEL = 'ck-grant-revoked-v1'

/**
 * A grant as it travels: the grant JSON text exactly as signed, and the
 * owner's `grant` intent whose payloadHash is SHA-256 of that text.
 */
export interface SignedGrant {
  grant: string
  intent: SignedIntent
}

/** The bytes a grant intent's payloadHash covers: the grant text itself. */
export function grantPayload(grantText: string): Uint8Array {
  return encoder.encode(grantText)
}

/**
 * What a grant_revoke intent covers: the grant id, and for a supersede the
 * one grant that survives it.
 */
export function grantRevokePayload(grantId: string, keep?: string): Uint8Array {
  return framed(keep === undefined ? [encoder.encode(grantId)] : [encoder.encode(grantId), encoder.encode(keep)])
}

/**
 * The parts the machine signs to confirm a revocation; a supersede has its
 * kept grant as a third part.
 */
export function grantRevokedParts(grantId: string, keep?: string): [label: string, ...parts: string[]] {
  return keep === undefined ? [GRANT_REVOKED_LABEL, grantId] : [GRANT_REVOKED_LABEL, grantId, keep]
}

/**
 * When a grant for a share was first signed: the owner's browser names each
 * new grant `<share>:<ms base 36><8 hex>` (renewal keeps the id), so this
 * orders a share's grants by issue, never by renewal. Null for an id of any
 * other shape.
 */
export function grantIssuedAt(grantId: string, shareId: string): number | null {
  if (!grantId.startsWith(`${shareId}:`)) return null
  const m = /^([0-9a-z]{1,11})[0-9a-f]{8}$/.exec(grantId.slice(shareId.length + 1))
  if (!m) return null
  const t = parseInt(m[1], 36)
  return Number.isSafeInteger(t) ? t : null
}

/**
 * A revocation recorded on the machine. Without `keep` it covers the id and
 * every `<id>:…` grant. With `keep` it is a supersede: it covers the id and
 * every `<id>:…` grant issued no later than `keep`, other than `keep` itself,
 * so grants signed after it (by any of the owner's browsers) still stand.
 */
export interface GrantRevocation {
  grantId: string
  keep?: string
}

export function grantRevokedBy(grantId: string, r: GrantRevocation): boolean {
  if (grantId === r.grantId) return true
  if (!grantId.startsWith(`${r.grantId}:`)) return false
  if (r.keep === undefined) return true
  if (grantId === r.keep) return false
  const kept = grantIssuedAt(r.keep, r.grantId)
  const issued = grantIssuedAt(grantId, r.grantId)
  // Anything not datable is revoked: only a later grant survives a supersede.
  return kept === null || issued === null || issued <= kept
}

/** A grant that lets someone approve shell commands is privileged (§6.2). */
export function grantNeedsStepUp(permissions: readonly string[]): boolean {
  return permissions.includes('approve_shell')
}

/**
 * A remote policy change (§6.8): it may only raise the machine's policy
 * (off → warn → required); lowering is for local surfaces only. Raising is
 * the safe direction, so it needs no step-up.
 */
export const POLICY_ACTION = 'device_policy'

/** What a device_policy intent covers: the policy asked for. */
export function policyPayload(policy: string): Uint8Array {
  return framed([encoder.encode(policy)])
}

/** Device changes always count as privileged. */
export function actionNeedsStepUp(action: string): boolean {
  return action === DEVICE_CERTIFY_ACTION || action === DEVICE_REVOKE_ACTION
}

/** A channel open covers no bytes. */
export function channelOpenPayload(): Uint8Array {
  return new Uint8Array(0)
}
