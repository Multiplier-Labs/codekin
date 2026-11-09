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
  GRANT_ACTION, MAX_GRANT_LIFETIME_MS, PASSKEY_ANY, actionNeedsStepUp, grantIssuedAt, grantNeedsStepUp, grantPayload, grantRevokedBy, intentChallengeInput, channelOpenPayload, channelSessionAfter, frameAction, frameNeedsStepUp, framePayload, frameSession,
  frameStepUpReason, isExemptFrame, requestAction, requestNeedsStepUp, requestPayload, requestSession, requestStepUpReason, standingRouteReason,
} from './intent-actions.js'
import type { GrantBody, IntentBody, IntentRefusal, SignedGrant, SignedIntent } from './intent-actions.js'
import { keyIdForSpki, parseP256Spki } from './machine-identity.js'
import { fromB64url, SIGNATURE_BYTES, transcript, verifyP1363 } from './enrolment-crypto.js'
import { MAX_PASSKEY_WINDOW_MINUTES, mutateTrustStore, passkeyWindowMinutes, readTrustStore } from './trust-store.js'
import type { BrowserCredential, IntentPolicy, PasskeyCredential, TrustedCredential, TrustStore } from './trust-store.js'
import { verifyPasskeyAssertion } from './webauthn-verify.js'
import type { IntentLog, IntentVerdict } from './intent-log.js'
import type { RelayPrincipal } from './relay-protocol.js'
import { IntentReplayStore } from './intent-replay.js'
export { REPLAY_TTL_MS, REPLAY_CACHE_MAX } from './intent-replay.js'

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
  /** On `intent_step_up_required`: the signer's passkeys this machine accepts, so the browser knows which to use. */
  stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>
}

/**
 * How a privileged action was confirmed (spec §6.6), recorded in the intent
 * log: a passkey, the browser key within a recent passkey step-up's window
 * (§6.6b), or the browser key alone (no passkey enrolled here).
 */
export type StepUp = 'passkey' | 'passkey-recent' | 'browser-key'

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
  /** The device-list key that signed the open; null when it went through unsigned. */
  signerKeyId?: string | null
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
  /** A privileged action (§6.2): needs a passkey when the signer has one here. */
  privileged?: boolean
  /**
   * A privileged session action a recent passkey step-up may cover (§6.6b),
   * as the machine classifies it: bypass or pre-approved tools, or an
   * "always allow" answer. Standing authority (orchestrator trust, scheduled
   * or triggered automations), device changes and anything unclassifiable
   * always need the passkey itself.
   */
  windowEligible?: boolean
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
  if (v.keyId.length === 0 || v.keyId.length > 64) return null
  if (v.browserKeyId !== undefined && (typeof v.browserKeyId !== 'string' || v.browserKeyId.length === 0 || v.browserKeyId.length > 64)) return null
  if (v.seq !== undefined && !(Number.isSafeInteger(v.seq) && v.seq > 0)) return null
  return v as IntentBody
}

/** Largest grant text accepted (a grant names at most a few keys). */
const MAX_GRANT_CHARS = 8192

/** A grant's JSON, read strictly: every field present, keys well formed. Null otherwise. */
/**
 * A grant's shape, without importing its keys (the costly part, which
 * grantKeysValid does once the owner's signature has checked out).
 */
function parseGrant(text: string): GrantBody | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Partial<GrantBody>
  if (typeof v.grantId !== 'string' || !v.grantId || typeof v.sessionId !== 'string' || !v.sessionId) return null
  if (typeof v.granteeUserId !== 'string' || !v.granteeUserId || typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null
  if (!Array.isArray(v.permissions) || !v.permissions.every(p => typeof p === 'string')) return null
  if (!Array.isArray(v.granteeKeys) || v.granteeKeys.length > 20) return null
  return v as GrantBody
}

/** Every key a grant names is a P-256 key under its own id. */
function grantKeysValid(grant: GrantBody): boolean {
  return grant.granteeKeys.every(k => {
    const spki = parseP256Spki((k as { spki?: unknown } | null)?.spki)
    return !!spki && (k as { keyId?: unknown }).keyId === keyIdForSpki(spki)
  })
}

/**
 * Signed grants looked at per request. The relay presents them, so it could
 * send any number: past this they are ignored rather than verified. Far more
 * sessions than one member is likely to have shared on one machine.
 */
export const MAX_SIGNED_GRANTS = 64

/** Grants looked at per session (renewals and a narrowing can overlap briefly). */
const MAX_GRANTS_PER_SESSION = 4

function asSignedIntent(value: unknown): SignedIntent | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<SignedIntent>
  if (typeof v.body !== 'string' || v.body.length > MAX_INTENT_BODY_CHARS) return null
  if (v.sig !== undefined && typeof v.sig !== 'string') return null
  if (v.webauthn !== undefined) {
    const w = v.webauthn as Partial<NonNullable<SignedIntent['webauthn']>> | null
    if (!w || typeof w.credentialId !== 'string' || typeof w.authenticatorData !== 'string'
      || typeof w.clientDataJSON !== 'string' || typeof w.signature !== 'string') return null
  }
  return v as SignedIntent
}

/** The session a presented grant names, read without verifying anything, or null. */
function grantSessionOf(value: unknown): string | null {
  const signed = value as Partial<SignedGrant> | null
  if (!signed || typeof signed.grant !== 'string' || signed.grant.length > MAX_GRANT_CHARS) return null
  return parseGrant(signed.grant)?.sessionId ?? null
}

export class IntentVerifier {
  private store: TrustStore | null = null
  private storeSignature: string | null = null
  private lastPolicy: IntentPolicy = 'off'
  private readonly replay: IntentReplayStore
  private lastUsed = new Map<string, number>()
  private lastFlush = 0
  private flushScheduled = false
  /** Grant checks are cached briefly; the key includes the device list's signature, so a revoked signer counts at once. */
  private grantCache = new Map<string, { verified: { grant: GrantBody; signedAt: number } | null; until: number }>()
  /** The workspace's "Privileged actions need a passkey" (§6.6), as the relay reports it. */
  private requirePasskey = false
  private lastReadWarning = -Infinity
  /**
   * §6.6b: until when each browser (by `${userId}:${keyId}`) may confirm
   * privileged session actions with its own key, opened by a passkey
   * step-up that named it. In memory: a restart just asks again.
   */
  private stepUpWindows = new Map<string, { openedAt: number; passkeyKeyId: string }>()
  private readonly now: () => number

  constructor(private readonly opts: IntentVerifierOptions) {
    this.now = opts.now ?? Date.now
    this.replay = new IntentReplayStore(`${opts.devicesFile}.replay.sqlite`, opts.machineId)
    // Failures are retried by consume(), which refuses until a durable
    // commit is possible. Never seed security state from an audit tail.
    this.replay.initialize(this.now())
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

  /**
   * The workspace's "Privileged actions need a passkey", from the relay's
   * hello_ack and policy events. Turning it on is recorded on the machine
   * (relay-devices.json → requirePasskeyStepUp), where only a local surface
   * turns it off again: the relay can raise the requirement, never drop it.
   */
  setRequirePasskey(value: boolean): void {
    this.requirePasskey = value
    if (!value) return
    const store = this.currentStore()
    if (!store || store.requirePasskeyStepUp === true) return
    try {
      // No waiting for the lock: this runs on the connector's message path.
      mutateTrustStore(this.opts.devicesFile, this.opts.machineId, s => { s.requirePasskeyStepUp = true }, this.now(), 0)
      this.storeSignature = null
    } catch {
      // Not recorded this time (lock busy, file unreadable): it still holds
      // in memory, and the relay says it again at the next connect.
    }
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
      privileged: requestNeedsStepUp(req.method, req.path, body),
      windowEligible: requestStepUpReason(req.method, req.path, body) !== null && standingRouteReason(req.method, req.path) === null,
    }).decision
  }

  /**
   * Check a device intent (device_certify, device_revoke) carried by an
   * enrol_* frame. Always privileged. Returns the credential that signed it
   * when it verified, whatever the policy: device changes are never let
   * through unverified.
   */
  checkDeviceIntent(
    principal: RelayPrincipal | undefined,
    intent: unknown,
    action: string,
    payload: Uint8Array,
    /** Device changes are; revoking a grant (the safe direction) isn't. */
    privileged = true,
  ): { decision: IntentDecision; signer: TrustedCredential | null } {
    const { decision, body } = this.check(principal, intent, { action, sessionId: null, payload, privileged })
    if (decision.verdict !== 'accepted' || !body) return { decision, signer: null }
    const store = this.currentStore()
    const signer = this.signerOf(store, body, asSignedIntent(intent))
    return { decision, signer }
  }

  /** Check a channel open; the returned channel goes with every frame on it. */
  checkChannelOpen(principal: RelayPrincipal | undefined, intent: unknown): { decision: IntentDecision; channel: IntentChannel } {
    const { decision, body, signerKeyId } = this.check(principal, intent, {
      action: CHANNEL_OPEN_ACTION, sessionId: null, payload: channelOpenPayload(), opensChannel: true,
    })
    const accepted = decision.verdict === 'accepted'
    const token = accepted && body?.channel ? body.channel : null
    return { decision, channel: { token, lastSeq: 0, session: null, signerKeyId: accepted ? signerKeyId : null } }
  }

  /**
   * Why an owner's open channel may no longer carry session output, or null
   * while it may: the device that opened it was removed from the device
   * list, the list can't be read, or the policy now requires a confirmed
   * device and the channel was opened unsigned. (Grantee channels are
   * re-checked against their grants on every frame.)
   */
  ownerChannelEnded(channel: IntentChannel): string | null {
    const store = this.currentStore()
    const policy = store?.policy ?? this.lastPolicy
    if (!channel.signerKeyId) return policy === 'required' ? 'This computer now accepts only confirmed devices' : null
    if (!store) return "This computer can't read its device list"
    return store.credentials.some(c => c.keyId === channel.signerKeyId) ? null : 'This device was removed from this computer'
  }

  /** Check a client frame against its channel, and advance the channel when it goes through. */
  checkFrame(principal: RelayPrincipal | undefined, frame: string, intent: unknown, channel: IntentChannel): IntentDecision {
    if (isExemptFrame(frame)) return EXEMPT
    const { decision, body } = this.check(principal, intent, {
      action: frameAction(frame),
      sessionId: frameSession(frame, channel.session),
      payload: framePayload(frame),
      channel,
      privileged: frameNeedsStepUp(frame),
      windowEligible: frameStepUpReason(frame) !== null,
    })
    if (decision.verdict === 'accepted' && body?.seq !== undefined) channel.lastSeq = body.seq
    // What reaches the local server moves the session, signed or not.
    if (decision.forward) channel.session = channelSessionAfter(frame, channel.session, body?.seq)
    return decision
  }

  private check(principal: RelayPrincipal | undefined, rawIntent: unknown, expected: Expected): { decision: IntentDecision; body: IntentBody | null; signerKeyId?: string | null } {
    const store = this.currentStore()
    const policy = store?.policy ?? this.lastPolicy

    if (rawIntent === undefined || rawIntent === null) {
      if (policy === 'off') return { decision: { forward: true, verdict: 'unsigned' }, body: null }
      return { decision: this.finish(policy, principal, expected, null, null, 'intent_required'), body: null }
    }
    const intent = asSignedIntent(rawIntent)
    const body = intent ? parseBody(intent.body) : null
    if (!intent || !body) return { decision: this.finish(policy, principal, expected, intent, null, 'intent_malformed'), body: null }
    const outcome = this.verify(store, principal, intent, body, expected)
    const refusal = typeof outcome === 'string' ? outcome : null
    const accepted = typeof outcome === 'object' ? outcome : null
    const decision = this.finish(policy, principal, expected, intent, body, refusal, accepted?.stepUp, accepted?.keyId)
    if (refusal === 'intent_step_up_required' && store && principal) {
      decision.stepUpPasskeys = store.credentials
        .filter((c): c is PasskeyCredential => c.kind === 'passkey' && c.userId === principal.userId)
        .map(c => ({ credentialId: c.credentialId, keyId: c.keyId }))
    }
    return { decision, body, signerKeyId: accepted?.keyId ?? null }
  }

  /** The device-list credential an intent names: a browser key by keyId, or a passkey by keyId or credential id. */
  private signerOf(store: TrustStore | null, body: IntentBody, intent: SignedIntent | null): TrustedCredential | null {
    if (!store || !intent) return null
    if (intent.webauthn) {
      const credentialId = intent.webauthn.credentialId
      return store.credentials.find((c): c is PasskeyCredential =>
        c.kind === 'passkey' && c.credentialId === credentialId && (body.keyId === PASSKEY_ANY || c.keyId === body.keyId)) ?? null
    }
    return store.credentials.find((c): c is BrowserCredential => c.kind === 'browser' && c.keyId === body.keyId) ?? null
  }

  private verify(
    store: TrustStore | null,
    principal: RelayPrincipal | undefined,
    intent: SignedIntent,
    body: IntentBody,
    expected: Expected,
  ): IntentRefusal | { stepUp?: StepUp; keyId: string } {
    if (intent.webauthn === undefined && intent.sig === undefined) return 'intent_malformed'
    if (!store) return 'intent_unknown_key'

    // Who signed: an owner credential from the device list, or, for a
    // grantee, a key named in a verified owner-signed grant (§6.7).
    let signerKeyId: string
    let ownerCredential: TrustedCredential | null = null
    if (principal?.role === 'grantee') {
      if (intent.webauthn || !intent.sig) return 'intent_unsupported'
      const key = this.granteeKey(principal, expected.sessionId, body.keyId)
      if (!key) return 'intent_unknown_key'
      const sig = fromB64url(intent.sig, SIGNATURE_BYTES)
      const spki = fromB64url(key.spki)
      if (!sig || !spki || !verifyP1363(spki, Buffer.from(intent.body, 'utf-8'), sig)) return 'intent_bad_signature'
      signerKeyId = key.keyId
    } else {
      const credential = this.signerOf(store, body, intent)
      if (!credential) return 'intent_unknown_key'
      // The signature proves the device; the principal must be the same person,
      // and only the recorded owner's devices act as owner.
      if (!principal || principal.userId !== credential.userId) return 'intent_wrong_signer'
      if (principal.role !== 'owner' || store.ownerUserId === null || credential.userId !== store.ownerUserId) return 'intent_wrong_signer'
      const bad = this.checkSignature(store, credential, intent)
      if (bad) return bad
      ownerCredential = credential
      signerKeyId = credential.keyId
    }

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

    // Step-up (§6.6): a privileged action needs a passkey when the signer has
    // one enrolled here, or when the workspace requires it. Grantees can't
    // take privileged actions at all; the channel policy refuses them.
    // Device changes always need the passkey itself; privileged session
    // actions may use a recent step-up's window (§6.6b).
    let stepUp: StepUp | undefined
    const deviceChange = actionNeedsStepUp(expected.action)
    if (ownerCredential && (expected.privileged || deviceChange)) {
      const recent = !deviceChange && expected.windowEligible === true && ownerCredential.kind === 'browser' && this.withinStepUpWindow(store, ownerCredential)
      if (!recent) {
        const refusal = this.stepUpRefusal(store, ownerCredential)
        if (refusal) return refusal
      }
      stepUp = ownerCredential.kind === 'passkey' ? 'passkey' : recent ? 'passkey-recent' : 'browser-key'
    }

    const replay = this.replay.consume(principal.userId, body.nonce, this.now())
    if (replay) return replay
    if (ownerCredential) this.noteUsed(signerKeyId)
    if (stepUp === 'passkey' && !deviceChange && ownerCredential) this.openStepUpWindow(store, ownerCredential, body.browserKeyId, body.ts)
    return { keyId: signerKeyId, ...(stepUp ? { stepUp } : {}) }
  }

  /** A browser key's P1363 signature, or a passkey assertion over T("ck-intent-v1", body). */
  private checkSignature(store: TrustStore, credential: TrustedCredential, intent: SignedIntent): IntentRefusal | null {
    if (credential.kind === 'browser') {
      const sig = fromB64url(intent.sig, SIGNATURE_BYTES)
      const spki = fromB64url(credential.spki)
      return sig && spki && verifyP1363(spki, Buffer.from(intent.body, 'utf-8'), sig) ? null : 'intent_bad_signature'
    }
    // A passkey signs with user verification, for this relay's origin and the passkey's RP ID.
    if (!intent.webauthn) return 'intent_bad_signature'
    let origin: string
    try { origin = new URL(store.relayOrigin).origin } catch { return 'intent_bad_signature' }
    const failure = verifyPasskeyAssertion(intent.webauthn, {
      challenge: createHash('sha256').update(intentChallengeInput(intent.body)).digest(),
      origin,
      rpId: credential.rpId,
      cosePublicKey: credential.cosePublicKey,
    })
    return failure ? 'intent_bad_signature' : null
  }

  /** Why a privileged action by this owner credential needs more, or null. */
  /** Whether this browser key is inside a passkey step-up's window (§6.6b). */
  private withinStepUpWindow(store: TrustStore, credential: TrustedCredential): boolean {
    const minutes = passkeyWindowMinutes(store)
    if (minutes === 0) return false
    const window = this.stepUpWindows.get(`${credential.userId}:${credential.keyId}`)
    if (!window) return false
    // The passkey that opened it must still be on the machine.
    if (!store.credentials.some(c => c.kind === 'passkey' && c.keyId === window.passkeyKeyId)) return false
    const t = this.now()
    // Measured from when the passkey was used, against today's setting (a
    // lowered window takes effect at once); a clock that went back ends it.
    return t >= window.openedAt - INTENT_MAX_SKEW_MS && t < window.openedAt + minutes * 60_000
  }

  /**
   * A passkey step-up named the browser that asked for it: let that browser,
   * if it is one of the same user's confirmed browsers here, confirm
   * privileged session actions with its own key for the machine's window.
   */
  private openStepUpWindow(store: TrustStore, passkey: TrustedCredential, browserKeyId: string | undefined, signedAt: number): void {
    const minutes = passkeyWindowMinutes(store)
    if (!browserKeyId || minutes === 0) return
    const userId = passkey.userId
    const browser = store.credentials.find(c => c.kind === 'browser' && c.keyId === browserKeyId && c.userId === userId)
    if (!browser) return
    const t = this.now()
    for (const [k, w] of this.stepUpWindows) if (w.openedAt + MAX_PASSKEY_WINDOW_MINUTES * 60_000 <= t) this.stepUpWindows.delete(k)
    // From when the passkey signed, not when the relay chose to deliver it.
    this.stepUpWindows.set(`${userId}:${browserKeyId}`, { openedAt: Math.min(t, signedAt), passkeyKeyId: passkey.keyId })
  }

  private stepUpRefusal(store: TrustStore, credential: TrustedCredential): IntentRefusal | null {
    const hasPasskey = store.credentials.some(c => c.kind === 'passkey' && c.userId === credential.userId)
    const required = hasPasskey || this.requirePasskey || store.requirePasskeyStepUp === true
    return credential.kind !== 'passkey' && required ? 'intent_step_up_required' : null
  }

  // --- Grants (§6.7) -------------------------------------------------------

  /**
   * The grantee's grants that verify: signed by an owner credential still in
   * the device list (so revoking that key drops them at once), for this
   * machine and this grantee, unexpired, not revoked here, at most 30 days
   * long, and stepped up when they include approve_shell.
   */
  verifiedGrants(principal: RelayPrincipal | undefined): Map<string, GrantBody> {
    const best = new Map<string, { grant: GrantBody; signedAt: number }>()
    const store = this.currentStore()
    if (!store || principal?.role !== 'grantee' || !Array.isArray(principal.signedGrants)) return new Map()
    // Cheap checks first, so a relay can't make the machine verify signatures
    // at will: only grants for sessions the relay itself says are shared
    // count (the machine uses the intersection anyway), a few per session.
    const perSession = new Map<string, number>()
    let looked = 0
    for (const signed of principal.signedGrants) {
      if (looked >= MAX_SIGNED_GRANTS) break
      const sessionId = grantSessionOf(signed)
      if (sessionId === null || !Object.hasOwn(principal.grants, sessionId)) continue
      const n = perSession.get(sessionId) ?? 0
      if (n >= MAX_GRANTS_PER_SESSION) continue
      perSession.set(sessionId, n + 1)
      looked += 1
      const verified = this.verifyGrant(store, principal.userId, signed)
      if (!verified) continue
      // One grant per session: the most recently issued one (renewal keeps
      // a grant's id and so its place), then the most recently signed, so a
      // narrowed grant replaces a broader one however often the broader one
      // is renewed. The owner also supersedes the old grants on the machine.
      const current = best.get(verified.grant.sessionId)
      if (!current || isNewerGrant(verified, current)) best.set(verified.grant.sessionId, verified)
    }
    return new Map([...best].map(([sessionId, v]) => [sessionId, v.grant]))
  }

  /** Changes whenever the device list (and so any revocation or signer) changes. */
  grantsVersion(): string {
    this.currentStore()
    return this.storeSignature ?? ''
  }

  /** `value` comes from the relay: anything at all. */
  private verifyGrant(store: TrustStore, granteeUserId: string, value: unknown): { grant: GrantBody; signedAt: number } | null {
    const signed = value as Partial<SignedGrant> | null
    if (!signed || typeof signed.grant !== 'string' || signed.grant.length > MAX_GRANT_CHARS) return null
    const cacheKey = `${this.storeSignature ?? ''}|${granteeUserId}|${signed.grant}|${JSON.stringify(signed.intent)}`
    const cached = this.grantCache.get(cacheKey)
    const now = this.now()
    if (cached && cached.until > now) return cached.verified && cached.verified.grant.expiresAt > now ? cached.verified : null

    const verified = this.checkGrant(store, granteeUserId, { grant: signed.grant, intent: signed.intent as SignedIntent }, now)
    if (this.grantCache.size > 1000) this.grantCache.clear()
    this.grantCache.set(cacheKey, { verified, until: now + 60_000 })
    return verified
  }

  private checkGrant(store: TrustStore, granteeUserId: string, signed: SignedGrant, now: number): { grant: GrantBody; signedAt: number } | null {
    const intent = asSignedIntent(signed.intent)
    const body = intent ? parseBody(intent.body) : null
    const grant = parseGrant(signed.grant)
    if (!intent || !body || !grant) return null
    if (body.action !== GRANT_ACTION || body.machineId !== this.opts.machineId || body.sessionId !== grant.sessionId) return null
    if (body.payloadHash !== sha256b64url(grantPayload(signed.grant))) return null
    if (grant.granteeUserId !== granteeUserId) return null
    // Only an owner credential still on this machine vouches for a grant.
    const credential = this.signerOf(store, body, intent)
    if (!credential || store.ownerUserId === null || credential.userId !== store.ownerUserId) return null
    if (this.checkSignature(store, credential, intent)) return null
    if (!grantKeysValid(grant)) return null
    if (grantNeedsStepUp(grant.permissions) && this.stepUpRefusal(store, credential)) return null
    if (body.ts > now + INTENT_MAX_SKEW_MS) return null
    // The id's issue time orders a share's grants and decides supersedes, so
    // it may not run ahead of when the grant was signed (renewal only moves
    // the signing time on).
    if (issuedAt({ grant, signedAt: body.ts }) > body.ts + INTENT_MAX_SKEW_MS) return null
    if (grant.expiresAt <= now || grant.expiresAt - body.ts > MAX_GRANT_LIFETIME_MS + INTENT_MAX_SKEW_MS) return null
    if (typeof grant.notAfter === 'number' && grant.expiresAt > grant.notAfter) return null
    // Revoking X also revokes every X:… (a share's id covers all the grants
    // signed for it, whichever ones the relay chooses to present); a
    // supersede of X revokes every X:… issued up to the one it keeps.
    if (store.revokedGrants.some(r => grantRevokedBy(grant.grantId, r))) return null
    return { grant, signedAt: body.ts }
  }

  /** The grantee key that may sign for `sessionId` (any verified grant's, for machine-level actions). */
  private granteeKey(principal: RelayPrincipal, sessionId: string | null, keyId: string): { keyId: string; spki: string } | null {
    const grants = this.verifiedGrants(principal)
    const forSession = sessionId !== null && !sessionId.startsWith('@') ? grants.get(sessionId) : undefined
    const candidates = sessionId !== null && !sessionId.startsWith('@')
      ? (forSession ? [forSession] : [])
      : [...grants.values()]
    for (const grant of candidates) {
      const key = grant.granteeKeys.find(k => k.keyId === keyId)
      if (key) return key
    }
    return null
  }

  /**
   * The principal the existing policy should see. For a grantee on a
   * `required` machine, that is the relay's grants intersected with the
   * owner-signed ones; elsewhere the relay's word still stands (warn/off).
   */
  effectivePrincipal(principal: RelayPrincipal | undefined): RelayPrincipal | undefined {
    if (principal?.role !== 'grantee' || this.policy() !== 'required') return principal
    const verified = this.verifiedGrants(principal)
    const grants: Record<string, string[]> = {}
    for (const [sessionId, relayPermissions] of Object.entries(principal.grants)) {
      const signed = verified.get(sessionId)
      if (!signed) continue
      const both = relayPermissions.filter(p => signed.permissions.includes(p))
      if (both.length > 0) grants[sessionId] = both
    }
    return { ...principal, grants }
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
    stepUp?: StepUp,
    /** The credential that signed it, once known (a passkey intent may say keyId "*"). */
    signerKeyId?: string,
  ): IntentDecision {
    const verdict: IntentVerdict = refusal === null ? 'accepted' : refusal === 'intent_required' ? 'unsigned' : 'rejected'
    const forward = refusal === null || policy !== 'required'
    this.opts.log?.append({
      verdict,
      ...(refusal ? { reason: refusal } : {}),
      forwarded: forward,
      action: expected.action.slice(0, 256),
      sessionId: expected.sessionId?.slice(0, 200) ?? null,
      userId: typeof principal?.userId === 'string' ? principal.userId.slice(0, 200) : null,
      keyId: signerKeyId ?? body?.keyId ?? null,
      payloadHash: sha256b64url(expected.payload),
      ...(stepUp ? { stepUp } : {}),
      // Only an accepted intent is evidence worth keeping; anything else may
      // be whatever the relay chose to send, so it isn't stored.
      ...(verdict === 'accepted' && intent ? { intent: {
        body: intent.body, ...(intent.sig ? { sig: intent.sig } : {}), ...(intent.webauthn ? { webauthn: intent.webauthn } : {}),
      } } : {}),
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

/** When a grant was issued: from its id (`<share>:<issued>`), else its signing time. */
function issuedAt(v: { grant: GrantBody; signedAt: number }): number {
  const colon = v.grant.grantId.lastIndexOf(':')
  return (colon > 0 ? grantIssuedAt(v.grant.grantId, v.grant.grantId.slice(0, colon)) : null) ?? v.signedAt
}

/** Of two grants for one session, whether `a` should win: issued later, or renewed later. */
function isNewerGrant(a: { grant: GrantBody; signedAt: number }, b: { grant: GrantBody; signedAt: number }): boolean {
  const ia = issuedAt(a)
  const ib = issuedAt(b)
  return ia !== ib ? ia > ib : a.signedAt > b.signedAt
}
