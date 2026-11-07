/**
 * Client side of passkey auth (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §5).
 *
 * Registration binds a platform authenticator (Face ID, fingerprint, PIN) to
 * the signed-in account; login runs the discoverable-credential flow so a
 * signed-out device can mint a fresh session with one biometric prompt and
 * no GitHub round trip.
 */

import { isDesktopApp } from './desktopAuth'
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
import { stepUpFetch } from './mfa'

export interface Passkey {
  id: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

export function passkeysSupported(): boolean {
  // WKWebView passkeys need Developer ID signing and an Associated Domains
  // entitlement per relay; the desktop app does passkeys in the browser (D12).
  return browserSupportsWebAuthn() && !isDesktopApp()
}

/** True for the dismissal/timeout the user chose — not worth an error message. */
export function isPasskeyCancel(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')
}

/** Why adding a passkey failed, as far as the client can tell. */
export type PasskeySetupFailure = 'step_up' | 'session' | 'not_verified' | 'unknown'

/** A server-side refusal while adding a passkey, with the reason kept. */
export class PasskeySetupError extends Error {
  readonly reason: PasskeySetupFailure
  constructor(reason: PasskeySetupFailure, message: string) {
    super(message)
    this.name = 'PasskeySetupError'
    this.reason = reason
  }
}

/**
 * The authenticator already holds a passkey for this account (for example one
 * synced from another device through iCloud Keychain or Google Password
 * Manager). It can already sign in, so for the user this is success.
 */
export function isPasskeyAlreadyRegistered(err: unknown): boolean {
  return err instanceof Error && err.name === 'InvalidStateError'
}

/**
 * A user-facing reason a passkey could not be added, or null when nothing
 * should be shown (the user dismissed the prompt). Said plainly, because a
 * bare "that did not work" leaves nothing to act on.
 */
export function describePasskeySetupError(err: unknown, where: 'link' | 'settings' = 'link'): string | null {
  if (isPasskeyCancel(err)) return null
  if (isPasskeyAlreadyRegistered(err)) return 'This device already has a passkey for your account.'
  if (err instanceof PasskeySetupError) {
    switch (err.reason) {
      case 'step_up':
        return where === 'link'
          ? 'Codekin needs you to confirm it is you first. Skip for now, then add the passkey from Settings → Devices.'
          : 'Codekin needs you to confirm it is you before adding a passkey. Try again.'
      case 'session':
        return 'Your sign-in on this device has ended. Sign in again, then add the passkey.'
      case 'not_verified':
        return 'The server could not verify this passkey. If this persists, check that you opened Codekin at its usual address.'
      case 'unknown':
        return 'The server could not start passkey setup. Try again in a moment.'
    }
  }
  if (err instanceof Error) {
    switch (err.name) {
      case 'SecurityError':
        return 'This browser will not create a passkey for this address. Open Codekin at its usual https address and try again.'
      case 'ConstraintError':
      case 'NotSupportedError':
        return 'This device cannot create a passkey with biometric or PIN verification.'
    }
  }
  return 'The passkey could not be added. You can try again or skip.'
}

async function setupFailure(res: Response, fallback: PasskeySetupFailure, message: string): Promise<PasskeySetupError> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  if (body?.error === 'step_up_required') return new PasskeySetupError('step_up', message)
  if (res.status === 401) return new PasskeySetupError('session', message)
  return new PasskeySetupError(fallback, message)
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

// Adding or removing a passkey may ask for a fresh second-factor check.
async function postJson(path: string, body?: unknown): Promise<Response> {
  return stepUpFetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function registerPasskey(label: string): Promise<Passkey> {
  const optionsRes = await postJson('/api/auth/webauthn/register/options')
  if (!optionsRes.ok) throw await setupFailure(optionsRes, 'unknown', 'Could not start passkey setup')
  const { options } = await optionsRes.json() as { options: PublicKeyCredentialCreationOptionsJSON }

  const response = await startRegistration({ optionsJSON: options })

  const verifyRes = await postJson('/api/auth/webauthn/register/verify', { response, label })
  if (!verifyRes.ok) throw await setupFailure(verifyRes, 'not_verified', 'Passkey could not be verified')
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
  const res = await stepUpFetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  return res.ok
}
