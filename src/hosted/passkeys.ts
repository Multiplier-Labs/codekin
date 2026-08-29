/**
 * Client side of passkey auth (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §5).
 *
 * Registration binds a platform authenticator (Face ID, fingerprint, PIN) to
 * the signed-in account; login runs the discoverable-credential flow so a
 * signed-out device can mint a fresh session with one biometric prompt and
 * no GitHub round trip.
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import type { HostedUser } from './useHostedAuth'

export interface Passkey {
  id: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn()
}

/** True for the dismissal/timeout the user chose — not worth an error message. */
export function isPasskeyCancel(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')
}

/** UA-derived default label so the passkey list reads as a device list. */
export function defaultPasskeyLabel(ua: string = navigator.userAgent): string {
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Macintosh/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'This device'
}

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function registerPasskey(label: string): Promise<Passkey> {
  const optionsRes = await postJson('/api/auth/webauthn/register/options')
  if (!optionsRes.ok) throw new Error('Could not start passkey setup')
  const { options } = await optionsRes.json() as { options: PublicKeyCredentialCreationOptionsJSON }

  const response = await startRegistration({ optionsJSON: options })

  const verifyRes = await postJson('/api/auth/webauthn/register/verify', { response, label })
  if (!verifyRes.ok) throw new Error('Passkey could not be verified')
  const data = await verifyRes.json() as { passkey: Passkey }
  return data.passkey
}

export async function loginWithPasskey(): Promise<HostedUser> {
  const optionsRes = await postJson('/api/auth/webauthn/login/options')
  if (!optionsRes.ok) throw new Error('Could not start passkey sign-in')
  const { options } = await optionsRes.json() as { options: PublicKeyCredentialRequestOptionsJSON }

  const response = await startAuthentication({ optionsJSON: options })

  const verifyRes = await postJson('/api/auth/webauthn/login/verify', { response })
  if (!verifyRes.ok) throw new Error('Passkey sign-in failed')
  const data = await verifyRes.json() as { user: HostedUser }
  return data.user
}

export async function fetchPasskeys(): Promise<Passkey[]> {
  const res = await fetch('/api/auth/passkeys', { credentials: 'include' })
  if (!res.ok) throw new Error('Could not load passkeys')
  const data = await res.json() as { passkeys?: Passkey[] }
  return Array.isArray(data.passkeys) ? data.passkeys : []
}

export async function removePasskey(id: string): Promise<boolean> {
  const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  return res.ok
}
