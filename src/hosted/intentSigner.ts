/**
 * Signs what this browser sends to a machine
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §6.1–6.3, §6.5).
 *
 * A browser signs only for machines it has been confirmed on (a pinned
 * machine key, deviceTrust.ts); elsewhere it sends unsigned, which machines
 * accept until they require confirmed devices. What is signed — the action,
 * the session and the bytes — is worked out by the shared rules in
 * server/relay/intent-actions.ts, which the machine applies to verify.
 */

import { INTENT_VERSION, MACHINE_TIME_LABEL, MAX_CLOCK_OFFSET_MS, PASSKEY_ANY, STEP_UP_WINDOW_MS, intentChallengeInput } from '../../server/relay/intent-actions'
import type { IntentBody, SignedIntent, StepUpReason } from '../../server/relay/intent-actions'
import {
  DEVICE_TRUST_CHANGED, currentUserId, fromB64url, getOrCreateBrowserKey, toB64url, transcript, trustStorage, type MachinePin, type TrustStorage,
} from './deviceTrust'

export type { SignedIntent }

export interface IntentToSign {
  action: string
  sessionId: string | null
  /** The exact bytes the machine will hash (intent-actions payload helpers). */
  payload: Uint8Array
  /** Channel opens and frames: the channel's token. */
  channel?: string
  /** Frames: position on the channel, from 1. */
  seq?: number
  /** Reuse a nonce: a retry of the same request must not be able to run twice. */
  nonce?: string
  /** A privileged action (§6.6): signed with the passkey the machine trusts, when there is one. */
  stepUp?: boolean
  /**
   * Why: a privileged *session* action (bypass permissions, pre-approved
   * tools, an "always allow" rule). Shown to the user before the passkey
   * prompt, and only these may use a recent step-up's window (§6.6b).
   * Without it (grants, device changes) the passkey is asked every time.
   */
  stepUpReason?: StepUpReason
  /**
   * Standing authority (orchestrator trust, automations): the machine never
   * lets a step-up window cover it, so the passkey is asked every time and
   * no window is opened or used.
   */
  standing?: boolean
  /**
   * The time to sign (ms), when the caller has one it trusts more than this
   * signer's clock: share grants, dated by a machine-signed time (§6.7).
   */
  ts?: number
}

export interface IntentSigner {
  /** The signed intent, or null when this browser isn't confirmed on the machine. */
  sign(intent: IntentToSign): Promise<SignedIntent | null>
  /** Adopt a clock correction (bounded to ±1 h, §6.5). */
  setClockOffset(ms: number): void
  /** Whether the pinned machine key signed this time for this nonce (MACHINE_TIME_LABEL). */
  verifyMachineTime(nonce: string, machineTime: number, sig: string): Promise<boolean>
  /** Remember which of this user's passkeys the machine trusts (from a step-up refusal). */
  learnPasskeys(passkeys: Array<{ credentialId: string; keyId: string }>, refusedReason?: StepUpReason | null): Promise<void>
  /**
   * The user's standing on the machine, from the relay's hello_ack. A
   * grantee signs with their browser key without being confirmed on the
   * machine: the owner's signed grant names that key (§6.7).
   */
  setRole(role: 'owner' | 'grantee'): void
}

const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
const utf8 = new TextEncoder()

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, ms))
}

interface SigningKey {
  privateKey: CryptoKey
  keyId: string
  userId: string
  passkeys: Array<{ credentialId: string; keyId: string }>
  passkeyStepUpAt?: number
  passkeyForBypass?: boolean
}

/**
 * Raised around a passkey prompt for a privileged action, so the app can say
 * why it is asking (PasskeyStepUpNotice): `detail` is PasskeyStepUpDetail.
 */
export const PASSKEY_STEP_UP_EVENT = 'codekin:passkey-step-up'
export interface PasskeyStepUpDetail {
  active: boolean
  reason: StepUpReason | null
}

function announceStepUp(detail: PasskeyStepUpDetail): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent<PasskeyStepUpDetail>(PASSKEY_STEP_UP_EVENT, { detail }))
}

/**
 * Stop using the window this long before the machine would: its clock and
 * ours differ a little, and a refused frame closes its channel.
 */
const STEP_UP_WINDOW_MARGIN_MS = 60_000

export function createIntentSigner(machineId: string, storage: TrustStorage = trustStorage(), now: () => number = Date.now): IntentSigner {
  let offset = 0
  let key: Promise<SigningKey | null> | null = null
  let role: 'owner' | 'grantee' = 'owner'

  const load = async (): Promise<SigningKey | null> => {
    const userId = await currentUserId()
    if (!userId) return null
    if (role === 'grantee') {
      // A grantee's authority is the owner's grant, which names this key.
      const own = await getOrCreateBrowserKey(userId, storage)
      return { privateKey: own.keyPair.privateKey, keyId: own.keyId, userId, passkeys: [] }
    }
    const [browserKey, pin] = await Promise.all([storage.getKey(userId), storage.getPin(userId, machineId)])
    // Sign only where the machine confirmed this very key.
    if (!browserKey || !pin || pin.keyId !== browserKey.keyId) return null
    return {
      privateKey: browserKey.keyPair.privateKey, keyId: browserKey.keyId, userId, passkeys: pin.passkeys ?? [],
      ...(pin.passkeyStepUpAt !== undefined ? { passkeyStepUpAt: pin.passkeyStepUpAt } : {}),
      ...(pin.passkeyForBypass ? { passkeyForBypass: true } : {}),
    }
  }

  /** A passkey intent for a privileged action, or null to fall back to the browser key. */
  const withPasskey = async (signing: SigningKey, body: IntentBody, reason: StepUpReason | undefined, standing = false): Promise<SignedIntent | null> => {
    // Only a session action names this browser and so opens its window (§6.6b).
    const opensWindow = reason !== undefined && !standing
    if (signing.passkeys.length === 0 || typeof window === 'undefined') return null
    let announced = false
    try {
      const { assertWithPasskey, passkeysSupported } = await import('./passkeys')
      if (!passkeysSupported()) return null
      // Offer every passkey we know the machine trusts and let the user's
      // authenticator answer with the one it has (keyId "*"): a wrong hint
      // first in the list can't then block step-up. A session action names
      // this browser, so the machine can open its window for it (§6.6b).
      const text = JSON.stringify({ ...body, keyId: PASSKEY_ANY, ...(opensWindow ? { browserKeyId: signing.keyId } : {}) })
      const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', intentChallengeInput(text) as BufferSource))
      announceStepUp({ active: true, reason: reason ?? null })
      announced = true
      const assertion = await assertWithPasskey(challenge, signing.passkeys.map(p => p.credentialId))
      if (opensWindow) {
        signing.passkeyStepUpAt = now()
        await rememberStepUp(signing.userId, signing.passkeyStepUpAt)
      }
      return { body: text, webauthn: assertion }
    } catch {
      // Cancelled or unavailable: the machine decides whether the browser key will do.
      return null
    } finally {
      if (announced) announceStepUp({ active: false, reason: reason ?? null })
    }
  }

  /** Record this browser's last passkey step-up on the machine. */
  const rememberStepUp = async (userId: string, at: number) => {
    const pin = await storage.getPin(userId, machineId)
    if (pin) await storage.putPin({ ...pin, passkeyStepUpAt: at })
  }

  /** Within a recent step-up's window (§6.6b): the browser key will do. */
  const inStepUpWindow = (signing: SigningKey) => {
    const at = signing.passkeyStepUpAt
    const t = now()
    return at !== undefined && t >= at && t - at < STEP_UP_WINDOW_MS - STEP_UP_WINDOW_MARGIN_MS
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener(DEVICE_TRUST_CHANGED, () => { key = null })
  }

  return {
    async sign(intent) {
      key ??= load().catch(() => null)
      const signing = await key
      if (!signing) return null
      const payloadHash = toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', intent.payload as BufferSource)))
      const body: IntentBody = {
        v: INTENT_VERSION,
        machineId,
        sessionId: intent.sessionId,
        action: intent.action,
        payloadHash,
        nonce: intent.nonce ?? toB64url(crypto.getRandomValues(new Uint8Array(16))),
        ts: intent.ts ?? now() + offset,
        keyId: signing.keyId,
        ...(intent.channel !== undefined ? { channel: intent.channel } : {}),
        ...(intent.seq !== undefined ? { seq: intent.seq } : {}),
      }
      // Bypass alone needs no passkey unless this machine said it does (§6.2).
      const bypassOnly = intent.stepUpReason === 'bypass' && !signing.passkeyForBypass
      const windowCovers = intent.stepUpReason !== undefined && !intent.standing && inStepUpWindow(signing)
      if (intent.stepUp && !bypassOnly && !windowCovers) {
        const stepped = await withPasskey(signing, body, intent.stepUpReason, intent.standing === true)
        if (stepped) return stepped
      }
      const text = JSON.stringify(body)
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN, signing.privateKey, utf8.encode(text) as BufferSource))
      return { body: text, sig: toB64url(sig) }
    },
    async learnPasskeys(passkeys, refusedReason) {
      // A hint from the relay path: add to what we know, never wipe it.
      if (passkeys.length === 0) return
      const signing = await (key ??= load().catch(() => null))
      if (!signing) return
      const pin = await storage.getPin(signing.userId, machineId)
      if (!pin) return
      const known = pin.passkeys ?? []
      const merged = [...passkeys, ...known.filter(k => !passkeys.some(p => p.credentialId === k.credentialId))].slice(0, 10)
      // A step-up refusal also means the machine's window (§6.6b) is over,
      // or shorter than ours: ask for the passkey next time.
      const next: MachinePin = { ...pin, passkeys: merged }
      delete next.passkeyStepUpAt
      // A bypass refused for want of a passkey: this machine asks for one there.
      if (refusedReason === 'bypass') next.passkeyForBypass = true
      await storage.putPin(next)
      key = null
    },
    setClockOffset(ms) {
      offset = clampOffset(ms)
    },
    setRole(next) {
      if (next !== role) key = null
      role = next
    },
    async verifyMachineTime(nonce, machineTime, sig) {
      try {
        const userId = await currentUserId()
        const pin = userId ? await storage.getPin(userId, machineId) : undefined
        // A key taken on first use (device_certify) isn't proof the relay
        // didn't supply it, so it doesn't vouch for the clock.
        if (!pin || pin.via === 'passkey') return false
        const key = await crypto.subtle.importKey('spki', fromB64url(pin.machineKey) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        const data = transcript(MACHINE_TIME_LABEL, nonce, String(machineTime))
        return await crypto.subtle.verify(SIGN, key, fromB64url(sig) as BufferSource, data as BufferSource)
      } catch {
        return false
      }
    },
  }
}
