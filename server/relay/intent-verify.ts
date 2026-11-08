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
 * Browser keys only for now: passkey-signed intents (step-up) come with
 * slice 5, grantee keys with signed grants in slice 6. Until then a grantee
 * on a `required` machine is refused.
 */

import { createHash } from 'crypto'
import { statSync } from 'fs'
import {
  CHANNEL_OPEN_ACTION, INTENT_MAX_SKEW_MS, INTENT_VERSION, MAX_INTENT_BODY_CHARS,
  channelOpenPayload, frameAction, framePayload, frameSession, isExemptFrame, requestAction, requestPayload, requestSession,
} from './intent-actions.js'
import type { IntentBody, IntentRefusal, SignedIntent } from './intent-actions.js'
import { fromB64url, SIGNATURE_BYTES, verifyP1363 } from './enrolment-crypto.js'
import { mutateTrustStore, readTrustStore } from './trust-store.js'
import type { BrowserCredential, IntentPolicy, TrustStore } from './trust-store.js'
import type { IntentLog, IntentVerdict } from './intent-log.js'
import type { RelayPrincipal } from './relay-protocol.js'

/** How long a (keyId, nonce) pair is remembered; longer than the skew window on both sides. */
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
}

/** What a message claims to do, worked out from the message itself. */
interface Expected {
  action: string
  sessionId: string | null
  payload: Uint8Array
}

export interface IntentVerifierOptions {
  machineId: string
  devicesFile: string
  log?: IntentLog | null
  now?: () => number
  warn?: Pick<Console, 'warn'>
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
  private replay = new Map<string, number>()
  private lastUsed = new Map<string, number>()
  private lastFlush = 0
  private readonly now: () => number

  constructor(private readonly opts: IntentVerifierOptions) {
    this.now = opts.now ?? Date.now
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
      this.storeSignature = signature
      try {
        const store = signature ? readTrustStore(this.opts.devicesFile) : null
        this.store = store && store.machineId === this.opts.machineId ? store : null
        if (this.store) this.lastPolicy = this.store.policy
      } catch (err) {
        // Keep the last policy we knew rather than dropping to `off`.
        this.opts.warn?.warn(`[relay] Can't read the device list; keeping policy "${this.lastPolicy}": ${err instanceof Error ? err.message : String(err)}`)
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
    // A forwarded GitHub delivery carries GitHub's HMAC, not a device's intent.
    if (req.principal?.role === 'webhook') return EXEMPT
    const body = req.body ? Buffer.from(req.body, 'base64') : null
    return this.check(req.principal, req.intent, {
      action: requestAction(req.method, req.path),
      sessionId: requestSession(req.path),
      payload: requestPayload(req.method, req.path, req.contentType, body),
    })
  }

  checkChannelOpen(principal: RelayPrincipal | undefined, intent: unknown): IntentDecision {
    return this.check(principal, intent, { action: CHANNEL_OPEN_ACTION, sessionId: null, payload: channelOpenPayload() })
  }

  /** `channelSession` is the session the channel had joined before this frame. */
  checkFrame(principal: RelayPrincipal | undefined, frame: string, intent: unknown, channelSession: string | null): IntentDecision {
    if (isExemptFrame(frame)) return EXEMPT
    return this.check(principal, intent, {
      action: frameAction(frame),
      sessionId: frameSession(frame, channelSession),
      payload: framePayload(frame),
    })
  }

  private check(principal: RelayPrincipal | undefined, rawIntent: unknown, expected: Expected): IntentDecision {
    const store = this.currentStore()
    const policy = store?.policy ?? this.lastPolicy

    if (rawIntent === undefined || rawIntent === null) {
      if (policy === 'off') return { forward: true, verdict: 'unsigned' }
      return this.finish(policy, principal, expected, null, null, 'intent_required')
    }
    const intent = asSignedIntent(rawIntent)
    const body = intent ? parseBody(intent.body) : null
    if (!intent || !body) return this.finish(policy, principal, expected, intent, null, 'intent_malformed')
    const refusal = this.verify(store, principal, intent, body, expected)
    return this.finish(policy, principal, expected, intent, body, refusal)
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
    if (Math.abs(body.ts - this.now()) > INTENT_MAX_SKEW_MS) return 'intent_stale'
    if (!this.remember(body.keyId, body.nonce)) return 'intent_replayed'
    this.noteUsed(body.keyId)
    return null
  }

  /** False when this (keyId, nonce) was already seen inside the window. */
  private remember(keyId: string, nonce: string): boolean {
    const now = this.now()
    const key = `${keyId}:${nonce}`
    const seen = this.replay.get(key)
    if (seen !== undefined && seen > now) return false
    // Expired entries go first; past the cap, the oldest go regardless.
    for (const [k, expiry] of this.replay) {
      if (expiry > now && this.replay.size < REPLAY_CACHE_MAX) break
      this.replay.delete(k)
    }
    this.replay.set(key, now + REPLAY_TTL_MS)
    return true
  }

  private noteUsed(keyId: string): void {
    const now = this.now()
    this.lastUsed.set(keyId, now)
    if (now - this.lastFlush < LAST_USED_FLUSH_MS) return
    this.lastFlush = now
    const used = new Map(this.lastUsed)
    try {
      mutateTrustStore(this.opts.devicesFile, this.opts.machineId, store => {
        for (const c of store.credentials) {
          const at = used.get(c.keyId)
          if (at !== undefined) c.lastUsedAt = new Date(at).toISOString()
        }
      }, now)
    } catch { /* best effort; retried at the next flush */ }
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
      ...(intent ? { intent: { body: intent.body, ...(intent.sig ? { sig: intent.sig } : {}) } } : {}),
    })
    return {
      forward,
      verdict,
      ...(refusal ? { reason: refusal } : {}),
      ...(body ? { nonce: body.nonce } : {}),
      ...(refusal === 'intent_stale' ? { machineTime: this.now() } : {}),
    }
  }
}
