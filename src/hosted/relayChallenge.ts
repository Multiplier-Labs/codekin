/**
 * The relay's own passkey challenges (sign-in, MFA step-up) are never handed
 * to the authenticator raw: the browser signs SHA-256(T("ck-relay-auth-v1",
 * challenge)) and the relay checks that (webauthn-routes separatedChallenge).
 * Machines accept passkey assertions over their own domain-separated
 * challenges, so a relay choosing a challenge that looks like one of theirs
 * gets nothing a machine will take (signed-intents spec §6.6a).
 */

import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { RELAY_AUTH_LABEL, domainSeparated } from '../../server/relay/intent-actions'

function fromB64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The relay's request options, with the challenge replaced by its domain-separated hash. */
export async function separateRelayChallenge(options: PublicKeyCredentialRequestOptionsJSON): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const input = domainSeparated(RELAY_AUTH_LABEL, fromB64url(options.challenge))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input as BufferSource))
  return { ...options, challenge: toB64url(digest) }
}
