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

import { INTENT_VERSION, MAX_CLOCK_OFFSET_MS } from '../../server/relay/intent-actions'
import type { IntentBody, SignedIntent } from '../../server/relay/intent-actions'
import { DEVICE_TRUST_CHANGED, currentUserId, toB64url, trustStorage, type TrustStorage } from './deviceTrust'

export type { SignedIntent }

export interface IntentToSign {
  action: string
  sessionId: string | null
  /** The exact bytes the machine will hash (intent-actions payload helpers). */
  payload: Uint8Array
}

export interface IntentSigner {
  /** The signed intent, or null when this browser isn't confirmed on the machine. */
  sign(intent: IntentToSign): Promise<SignedIntent | null>
  /** Adopt a clock correction (bounded to ±1 h, §6.5). */
  setClockOffset(ms: number): void
}

const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
const utf8 = new TextEncoder()

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, ms))
}

interface SigningKey { privateKey: CryptoKey; keyId: string }

export function createIntentSigner(machineId: string, storage: TrustStorage = trustStorage(), now: () => number = Date.now): IntentSigner {
  let offset = 0
  let key: Promise<SigningKey | null> | null = null

  const load = async (): Promise<SigningKey | null> => {
    const userId = await currentUserId()
    if (!userId) return null
    const [browserKey, pin] = await Promise.all([storage.getKey(userId), storage.getPin(userId, machineId)])
    // Sign only where the machine confirmed this very key.
    if (!browserKey || !pin || pin.keyId !== browserKey.keyId) return null
    return { privateKey: browserKey.keyPair.privateKey, keyId: browserKey.keyId }
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
        nonce: toB64url(crypto.getRandomValues(new Uint8Array(16))),
        ts: now() + offset,
        keyId: signing.keyId,
      }
      const text = JSON.stringify(body)
      const sig = new Uint8Array(await crypto.subtle.sign(SIGN, signing.privateKey, utf8.encode(text) as BufferSource))
      return { body: text, sig: toB64url(sig) }
    },
    setClockOffset(ms) {
      offset = clampOffset(ms)
    },
  }
}
