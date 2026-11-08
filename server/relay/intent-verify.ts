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
  GRANT_ACTION, MAX_GRANT_LIFETIME_MS, PASSKEY_ANY, actionNeedsStepUp, grantNeedsStepUp, grantPayload, intentChallengeInput, channelOpenPayload, channelSessionAfter, frameAction, frameNeedsStepUp, framePayload, frameSession,
  isExemptFrame, requestAction, requestNeedsStepUp, requestPayload, requestSession,
} from './intent-actions.js'
import type { GrantBody, IntentBody, IntentRefusal, SignedGrant, SignedIntent } from './intent-actions.js'
import { keyIdForSpki, parseP256Spki } from './machine-identity.js'
import { fromB64url, SIGNATURE_BYTES, transcript, verifyP1363 } from './enrolment-crypto.js'
import { mutateTrustStore, readTrustStore } from './trust-store.js'
import type { BrowserCredential, IntentPolicy, PasskeyCredential, TrustedCredential, TrustStore } from './trust-store.js'
import { verifyPasskeyAssertion } from './webauthn-verify.js'
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
  /** On `intent_step_up_required`: the signer's passkeys this machine accepts, so the browser knows which to use. */
  stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>
}

/** How a privileged action was confirmed (spec §6.6), recorded in the intent log. */
export type StepUp = 'passkey' | 'browser-key'

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
  /** A privileged action (§6.2): needs a passkey when the signer has one here. */
  privileged?: boolean
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
  if (v.seq !== undefined && !(Number.isSafeInteger(v.seq) && v.seq > 0)) return null
  return v as IntentBody
}

/** Largest grant text accepted (a grant names at most a few keys). */
const MAX_GRANT_CHARS = 8192

/** A grant's JSON, read strictly: every field present, keys well formed. Null otherwise. */
function parseGrant(text: string): GrantBody | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const v = parsed as Partial<GrantBody>
  if (typeof v.grantId !== 'string' || !v.grantId || typeof v.sessionId !== 'string' || !v.sessionId) return null
  if (typeof v.granteeUserId !== 'string' || !v.granteeUserId || typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null
  if (!Array.isArray(v.permissions) || !v.permissions.every(p => typeof p === 'string')) return null
  if (!Array.isArray(v.granteeKeys) || v.granteeKeys.length > 20) return null
  for (const k of v.granteeKeys) {
    const spki = parseP256Spki((k as { spki?: unknown } | null)?.spki)
    if (!spki || (k as { keyId?: unknown }).keyId !== keyIdForSpki(spki)) return null
  }
  return v as GrantBody
}

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

export class IntentVerifier {
  private store: TrustStore | null = null
  private storeSignature: string | null = null
  private lastPolicy: IntentPolicy = 'off'
  /** `${keyId}:${nonce}` → time until which it counts as used. */
  private replay = new Map<string, number>()
  private lastUsed = new Map<string, number>()
  private lastFlush = 0
  private flushScheduled = false
  /** Grant checks are cached briefly; the key includes the device list's signature, so a revoked signer counts at once. */
  private grantCache = new Map<string, { verified: { grant: GrantBody; signedAt: number } | null; until: number }>()
  /** The workspace's "Privileged actions need a passkey" (§6.6), as the relay reports it. */
  private requirePasskey = false
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

  /**
   * Set from the relay's hello_ack. The relay can only make this stricter
   * for itself by lying: claiming false just leaves the machine-side rule
   * (a passkey enrolled here is always required) in force.
   */
  setRequirePasskey(value: boolean): void {
    this.requirePasskey = value
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
      privileged: frameNeedsStepUp(frame),
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
    const outcome = this.verify(store, principal, intent, body, expected)
    const refusal = typeof outcome === 'string' ? outcome : null
    const accepted = typeof outcome === 'object' ? outcome : null
    const decision = this.finish(policy, principal, expected, intent, body, refusal, accepted?.stepUp, accepted?.keyId)
    if (refusal === 'intent_step_up_required' && store && principal) {
      decision.stepUpPasskeys = store.credentials
        .filter((c): c is PasskeyCredential => c.kind === 'passkey' && c.userId === principal.userId)
        .map(c => ({ credentialId: c.credentialId, keyId: c.keyId }))
    }
    return { decision, body }
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
    let stepUp: StepUp | undefined
    if (ownerCredential && (expected.privileged || actionNeedsStepUp(expected.action))) {
      const refusal = this.stepUpRefusal(store, ownerCredential)
      if (refusal) return refusal
      stepUp = ownerCredential.kind === 'passkey' ? 'passkey' : 'browser-key'
    }

    const replay = this.remember(signerKeyId, body.nonce)
    if (replay) return replay
    if (ownerCredential) this.noteUsed(signerKeyId)
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
  private stepUpRefusal(store: TrustStore, credential: TrustedCredential): IntentRefusal | null {
    const hasPasskey = store.credentials.some(c => c.kind === 'passkey' && c.userId === credential.userId)
    return credential.kind !== 'passkey' && (hasPasskey || this.requirePasskey) ? 'intent_step_up_required' : null
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
    for (const signed of principal.signedGrants.slice(0, 200)) {
      const verified = this.verifyGrant(store, principal.userId, signed)
      if (!verified) continue
      // One grant per session: the most recently signed one, so a narrowed
      // grant replaces a broader one (the owner also revokes the old id).
      const current = best.get(verified.grant.sessionId)
      if (!current || current.signedAt < verified.signedAt) best.set(verified.grant.sessionId, verified)
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
    if (grantNeedsStepUp(grant.permissions) && this.stepUpRefusal(store, credential)) return null
    if (body.ts > now + INTENT_MAX_SKEW_MS) return null
    if (grant.expiresAt <= now || grant.expiresAt - body.ts > MAX_GRANT_LIFETIME_MS + INTENT_MAX_SKEW_MS) return null
    if (typeof grant.notAfter === 'number' && grant.expiresAt > grant.notAfter) return null
    // Revoking X also revokes every X:… — a share's id covers all the grants
    // signed for it, whichever ones the relay chooses to present.
    if (store.revokedGrants.some(r => r.grantId === grant.grantId || grant.grantId.startsWith(`${r.grantId}:`))) return null
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
      action: expected.action,
      sessionId: expected.sessionId,
      userId: principal?.userId ?? null,
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
