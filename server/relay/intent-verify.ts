/**
 * Verification of signed intents at the connector's relay boundary
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §6.4). Runs before the existing
 * channel and REST policy, for every proxied request, channel open and
 * client stream frame.
 *
 * What it decides depends on the machine's intent policy (relay-devices.json,
 * local only):
 *   off       verify whatever is signed and log it; forward everything
 *   warn      as off, and log unsigned messages too
 *   required  forward only messages that verify
 *
 * Stream frames are also bound to their channel (a token fixed by the signed
 * `channel:open`) and to their order (a strictly increasing `seq`), so a relay
 * can drop frames but not reorder them or move them to another channel.
 *
 * Browser keys only for now: passkey-signed intents (step-up) come with
 * slice 5, grantee keys with signed grants in slice 6. Until then a grantee
 * on a `required` machine is refused.
 */

import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import {
  CHANNEL_OPEN_ACTION, CHANNEL_TOKEN_CHARS, INTENT_MAX_SKEW_MS, INTENT_VERSION, MACHINE_TIME_LABEL, MAX_INTENT_BODY_CHARS,
  channelOpenPayload, channelSessionAfter, frameAction, framePayload, frameSession, isExemptFrame, requestAction, requestPayload,
  requestSession,
} from './intent-actions.js'
import type { IntentBody, IntentRefusal, SignedIntent } from './intent-actions.js'
import { fromB64url, SIGNATURE_BYTES, transcript, verifyP1363 } from './enrolment-crypto.js'
import { mutateTrustStore, readTrustStore } from './trust-store.js'
import type { BrowserCredential, IntentPolicy, TrustStore } from './trust-store.js'
import type { IntentLog, IntentVerdict } from './intent-log.js'
import type { RelayPrincipal } from './relay-protocol.js'

/** How long a (keyId, nonce) pair is remembered: past the latest time its timestamp could still pass. */
export const REPLAY_TTL_MS = 2 * INTENT_MAX_SKEW_MS
export const REPLAY_CACHE_MAX = 50_000
/** How often a device's lastUsedAt is written back to the device list. */
const LAST_USED_FLUSH_MS = 10 * 60_000

export interface IntentDecision {
  /** Whether the message goes on to the local server. */
  forward: boolean
  verdict: IntentVerdict | 'exempt'
  reason?: IntentRefusal
  /** The intent's nonce, so the browser can match a refusal to what it sent. */
  nonce?: string
  /** Set on `intent_stale`, so the browser can correct its clock (§6.5). */
  machineTime?: number
  /** sign_kM over (nonce, machineTime): lets the browser trust machineTime and not the relay. */
  machineTimeSig?: string
}

/**
 * One stream channel as the verifier tracks it. Created by checkChannelOpen;
 * checkFrame reads and advances it.
 */
export interface IntentChannel {
  /** The token the browser's signed `channel:open` fixed; null when the open wasn't verified. */
  token: string | null
  /** Highest frame `seq` accepted on this channel. */
  lastSeq: number
  /** The session frames on this channel act on (intent-actions channelSessionAfter). */
  session: string | null
}

/** What a message claims to do, worked out from the message itself. */
interface Expected {
  action: string
  sessionId: string | null
  payload: Uint8Array
  /** Frames only: the channel the frame arrived on. */
  channel?: IntentChannel
  /** Channel opens: the token must be present and well formed. */
  opensChannel?: boolean
}

export interface IntentVerifierOptions {
  machineId: string
  devicesFile: string
  log?: IntentLog | null
  now?: () => number
  warn?: Pick<Console, 'warn'>
  /** Signs with the machine identity key (base64url P1363), or null when it can't. */
  signWithMachineKey?: (data: Uint8Array) => string | null
}

const EXEMPT: IntentDecision = { forward: true, verdict: 'exempt' }

function sha256b64url(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url')
}

function parseBody(text: string): IntentBody | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Partial<IntentBody>
  if (v.v !== INTENT_VERSION || typeof v.machineId !== 'string' || typeof v.action !== 'string') return null
  if (v.sessionId !== null && typeof v.sessionId !== 'string') return null
  if (typeof v.payloadHash !== 'string' || typeof v.nonce !== 'string' || typeof v.keyId !== 'string') return null
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null
  if (v.nonce.length < 16 || v.nonce.length > 64) return null
  if (v.channel !== undefined && typeof v.channel !== 'string') return null
  if (v.seq !== undefined && !(Number.isSafeInteger(v.seq) && v.seq > 0)) return null
  return v as IntentBody
}

function asSignedIntent(value: unknown): SignedIntent | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<SignedIntent>
  if (typeof v.body !== 'string' || v.body.length > MAX_INTENT_BODY_CHARS) return null
  if (v.sig !== undefined && typeof v.sig !== 'string') return null
  return v as SignedIntent
}

export class IntentVerifier {
  private store: TrustStore | null = null
  private storeSignature: string | null = null
  private lastPolicy: IntentPolicy = 'off'
  /** `${keyId}:${nonce}` → time until which it counts as used. */
  private replay = new Map<string, number>()
  private lastUsed = new Map<string, number>()
  private lastFlush = 0
  private flushScheduled = false
  private lastReadWarning = -Infinity
  private readonly now: () => number

  constructor(private readonly opts: IntentVerifierOptions) {
    this.now = opts.now ?? Date.now
    // A restart must not reopen the replay window: nonces accepted in the
    // last few minutes are still in the log.
    for (const { keyId, nonce, at } of opts.log?.recentAcceptedNonces(this.now() - REPLAY_TTL_MS) ?? []) {
      this.replay.set(`${keyId}:${nonce}`, at + REPLAY_TTL_MS)
    }
  }

  /** The device list, re-read only when the file changed (it is checked on every message). */
  private currentStore(): TrustStore | null {
    let signature: string | null
    try {
      const st = statSync(this.opts.devicesFile)
      signature = `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      signature = null
    }
    if (signature !== this.storeSignature) {
      try {
        const store = signature ? readTrustStore(this.opts.devicesFile) : null
        this.store = store && store.machineId === this.opts.machineId ? store : null
        if (this.store) this.lastPolicy = this.store.policy
        // Only a successful read is cached; a failed one is tried again next time.
        this.storeSignature = signature
      } catch (err) {
        // A device list that exists but can't be read may be the one that
        // said `required`: fail closed until it reads again.
        if (existsSync(this.opts.devicesFile)) this.lastPolicy = 'required'
        if (this.now() - this.lastReadWarning > 60_000) {
          this.lastReadWarning = this.now()
          this.opts.warn?.warn(`[relay] Can't read the device list; treating the policy as "${this.lastPolicy}": ${err instanceof Error ? err.message : String(err)}`)
        }
        this.store = null
      }
    }
    return this.store
  }

  /** The machine's intent policy right now. */
  policy(): IntentPolicy {
    return this.currentStore()?.policy ?? this.lastPolicy
  }

  checkRequest(req: { method: string; path: string; contentType?: string; body?: string; principal?: RelayPrincipal; intent?: unknown }): IntentDecision {
    // A forwarded GitHub delivery carries GitHub's HMAC, not a device's intent;
    // checkProxyRequest pins it to the one webhook route.
    if (req.principal?.role === 'webhook') return EXEMPT
    const body = req.body ? Buffer.from(req.body, 'base64') : null
    return this.check(req.principal, req.intent, {
      action: requestAction(req.method, req.path),
      sessionId: requestSession(req.path),
      payload: requestPayload(req.method, req.path, req.contentType, body),
    }).decision
  }

  /** Check a channel open; the returned channel goes with every frame on it. */
  checkChannelOpen(principal: RelayPrincipal | undefined, intent: unknown): { decision: IntentDecision; channel: IntentChannel } {
    const { decision, body } = this.check(principal, intent, {
      action: CHANNEL_OPEN_ACTION, sessionId: null, payload: channelOpenPayload(), opensChannel: true,
    })
    const token = decision.verdict === 'accepted' && body?.channel ? body.channel : null
    return { decision, channel: { token, lastSeq: 0, session: null } }
  }

  /** Check a client frame against its channel, and advance the channel when it goes through. */
  checkFrame(principal: RelayPrincipal | undefined, frame: string, intent: unknown, channel: IntentChannel): IntentDecision {
    if (isExemptFrame(frame)) return EXEMPT
    const { decision, body } = this.check(principal, intent, {
      action: frameAction(frame),
      sessionId: frameSession(frame, channel.session),
      payload: framePayload(frame),
      channel,
    })
    if (decision.verdict === 'accepted' && body?.seq !== undefined) channel.lastSeq = body.seq
    // What reaches the local server moves the session, signed or not.
    if (decision.forward) channel.session = channelSessionAfter(frame, channel.session, body?.seq)
    return decision
  }

  private check(principal: RelayPrincipal | undefined, rawIntent: unknown, expected: Expected): { decision: IntentDecision; body: IntentBody | null } {
    const store = this.currentStore()
    const policy = store?.policy ?? this.lastPolicy

    if (rawIntent === undefined || rawIntent === null) {
      if (policy === 'off') return { decision: { forward: true, verdict: 'unsigned' }, body: null }
      return { decision: this.finish(policy, principal, expected, null, null, 'intent_required'), body: null }
    }
    const intent = asSignedIntent(rawIntent)
    const body = intent ? parseBody(intent.body) : null
    if (!intent || !body) return { decision: this.finish(policy, principal, expected, intent, null, 'intent_malformed'), body: null }
    const refusal = this.verify(store, principal, intent, body, expected)
    return { decision: this.finish(policy, principal, expected, intent, body, refusal), body }
  }

  private verify(
    store: TrustStore | null,
    principal: RelayPrincipal | undefined,
    intent: SignedIntent,
    body: IntentBody,
    expected: Expected,
  ): IntentRefusal | null {
    // Passkey-signed intents arrive with step-up (slice 5).
    if (intent.webauthn !== undefined || intent.sig === undefined) return 'intent_unsupported'
    const credential = store?.credentials.find((c): c is BrowserCredential => c.kind === 'browser' && c.keyId === body.keyId)
    if (!store || !credential) return 'intent_unknown_key'
    // The signature proves the device; the principal must be the same person,
    // and only the recorded owner's devices act as owner.
    if (!principal || principal.userId !== credential.userId) return 'intent_wrong_signer'
    if (principal.role !== 'owner' || store.ownerUserId === null || credential.userId !== store.ownerUserId) return 'intent_wrong_signer'

    const sig = fromB64url(intent.sig, SIGNATURE_BYTES)
    const spki = fromB64url(credential.spki)
    if (!sig || !spki || !verifyP1363(spki, Buffer.from(intent.body, 'utf-8'), sig)) return 'intent_bad_signature'

    if (body.machineId !== this.opts.machineId) return 'intent_wrong_machine'
    if (body.action !== expected.action) return 'intent_wrong_action'
    if (body.payloadHash !== sha256b64url(expected.payload)) return 'intent_wrong_payload'
    if (body.sessionId !== expected.sessionId) return 'intent_wrong_session'
    if (expected.opensChannel && (typeof body.channel !== 'string' || body.channel.length !== CHANNEL_TOKEN_CHARS)) return 'intent_wrong_channel'
    if (expected.channel) {
      if (expected.channel.token === null || body.channel !== expected.channel.token) return 'intent_wrong_channel'
      if (body.seq === undefined || body.seq <= expected.channel.lastSeq) return 'intent_out_of_order'
    }
    if (Math.abs(body.ts - this.now()) > INTENT_MAX_SKEW_MS) return 'intent_stale'
    const replay = this.remember(body.keyId, body.nonce)
    if (replay) return replay
    this.noteUsed(body.keyId)
    return null
  }

  /** Record (keyId, nonce); refuse one already seen in the window, or when the cache is full. */
  private remember(keyId: string, nonce: string): IntentRefusal | null {
    const now = this.now()
    const key = `${keyId}:${nonce}`
    const until = this.replay.get(key)
    if (until !== undefined && until >= now) return 'intent_replayed'
    // Entries expire in insertion order (the TTL is fixed).
    for (const [k, expiry] of this.replay) {
      if (expiry >= now) break
      this.replay.delete(k)
    }
    // Never evict a live entry: that would reopen a replay. A device sending
    // this much (~80 a second for 10 minutes) waits instead.
    if (this.replay.size >= REPLAY_CACHE_MAX) return 'intent_rate_limited'
    this.replay.set(key, now + REPLAY_TTL_MS)
    return null
  }

  /** Remember when each device was used; written back off the request path, at most every 10 minutes. */
  private noteUsed(keyId: string): void {
    const now = this.now()
    this.lastUsed.set(keyId, now)
    if (now - this.lastFlush < LAST_USED_FLUSH_MS || this.flushScheduled) return
    this.lastFlush = now
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      const used = new Map(this.lastUsed)
      try {
        mutateTrustStore(this.opts.devicesFile, this.opts.machineId, store => {
          for (const c of store.credentials) {
            const at = used.get(c.keyId)
            if (at !== undefined) c.lastUsedAt = new Date(at).toISOString()
          }
        }, this.now(), 0)
      } catch { /* lock busy or file unreadable: retried at the next flush */ }
    })
  }

  private finish(
    policy: IntentPolicy,
    principal: RelayPrincipal | undefined,
    expected: Expected,
    intent: SignedIntent | null,
    body: IntentBody | null,
    refusal: IntentRefusal | null,
  ): IntentDecision {
    const verdict: IntentVerdict = refusal === null ? 'accepted' : refusal === 'intent_required' ? 'unsigned' : 'rejected'
    const forward = refusal === null || policy !== 'required'
    this.opts.log?.append({
      verdict,
      ...(refusal ? { reason: refusal } : {}),
      forwarded: forward,
      action: expected.action,
      sessionId: expected.sessionId,
      userId: principal?.userId ?? null,
      keyId: body?.keyId ?? null,
      payloadHash: sha256b64url(expected.payload),
      // Only an accepted intent is evidence worth keeping; anything else may
      // be whatever the relay chose to send, so it isn't stored.
      ...(verdict === 'accepted' && intent ? { intent: { body: intent.body, ...(intent.sig ? { sig: intent.sig } : {}) } } : {}),
    })
    return {
      forward,
      verdict,
      ...(refusal ? { reason: refusal } : {}),
      ...(body ? { nonce: body.nonce } : {}),
      ...(refusal === 'intent_stale' && body ? this.signedTime(body.nonce) : {}),
    }
  }

  private signedTime(nonce: string): { machineTime: number; machineTimeSig?: string } {
    const machineTime = this.now()
    const sig = this.opts.signWithMachineKey?.(transcript(MACHINE_TIME_LABEL, nonce, String(machineTime)))
    return { machineTime, ...(sig ? { machineTimeSig: sig } : {}) }
  }
}
