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

import { INTENT_VERSION, MACHINE_TIME_LABEL, MAX_CLOCK_OFFSET_MS } from '../../server/relay/intent-actions'
import type { IntentBody, SignedIntent } from '../../server/relay/intent-actions'
import { DEVICE_TRUST_CHANGED, currentUserId, fromB64url, toB64url, transcript, trustStorage, type TrustStorage } from './deviceTrust'

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
}

export interface IntentSigner {
  /** The signed intent, or null when this browser isn't confirmed on the machine. */
  sign(intent: IntentToSign): Promise<SignedIntent | null>
  /** Adopt a clock correction (bounded to ±1 h, §6.5). */
  setClockOffset(ms: number): void
  /** Whether the pinned machine key signed this time for this nonce (MACHINE_TIME_LABEL). */
  verifyMachineTime(nonce: string, machineTime: number, sig: string): Promise<boolean>
  /** Remember which of this user's passkeys the machine trusts (from a step-up refusal). */
  learnPasskeys(passkeys: Array<{ credentialId: string; keyId: string }>): Promise<void>
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
}

export function createIntentSigner(machineId: string, storage: TrustStorage = trustStorage(), now: () => number = Date.now): IntentSigner {
  let offset = 0
  let key: Promise<SigningKey | null> | null = null

  const load = async (): Promise<SigningKey | null> => {
    const userId = await currentUserId()
    if (!userId) return null
    const [browserKey, pin] = await Promise.all([storage.getKey(userId), storage.getPin(userId, machineId)])
    // Sign only where the machine confirmed this very key.
    if (!browserKey || !pin || pin.keyId !== browserKey.keyId) return null
    return { privateKey: browserKey.keyPair.privateKey, keyId: browserKey.keyId, userId, passkeys: pin.passkeys ?? [] }
  }

  /** A passkey intent for a privileged action, or null to fall back to the browser key. */
  const withPasskey = async (signing: SigningKey, body: IntentBody): Promise<SignedIntent | null> => {
    const passkey = signing.passkeys.at(0)
    if (!passkey || typeof window === 'undefined') return null
    try {
      const { assertWithPasskey, passkeysSupported } = await import('./passkeys')
      if (!passkeysSupported()) return null
      const text = JSON.stringify({ ...body, keyId: passkey.keyId })
      const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text) as BufferSource))
      const assertion = await assertWithPasskey(challenge, [passkey.credentialId])
      return { body: text, webauthn: assertion }
    } catch {
      // Cancelled or unavailable: the machine decides whether the browser key will do.
      return null
    }
  }
  if (typeof window !== 'undefined') {
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
        ts: now() + offset,
        keyId: signing.keyId,
        ...(intent.channel !== undefined ? { channel: intent.channel } : {}),
        ...(intent.seq !== undefined ? { seq: intent.seq } : {}),
      }
      if (intent.stepUp) {
        const stepped = await withPasskey(signing, body)
        if (stepped) return stepped
      }
      const text = JSON.stringify(body)
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN, signing.privateKey, utf8.encode(text) as BufferSource))
      return { body: text, sig: toB64url(sig) }
    },
    async learnPasskeys(passkeys) {
      const signing = await (key ??= load().catch(() => null))
      if (!signing) return
      const pin = await storage.getPin(signing.userId, machineId)
      if (!pin) return
      await storage.putPin({ ...pin, passkeys })
      key = null
    },
    setClockOffset(ms) {
      offset = clampOffset(ms)
    },
    async verifyMachineTime(nonce, machineTime, sig) {
      try {
        const userId = await currentUserId()
        const pin = userId ? await storage.getPin(userId, machineId) : undefined
        if (!pin) return false
        const key = await crypto.subtle.importKey('spki', fromB64url(pin.machineKey) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        const data = transcript(MACHINE_TIME_LABEL, nonce, String(machineTime))
        return await crypto.subtle.verify(SIGN, key, fromB64url(sig) as BufferSource, data as BufferSource)
      } catch {
        return false
      }
    },
  }
}
