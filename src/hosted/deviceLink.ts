/**
 * Client side of device linking (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §4).
 *
 * The signed-in browser mints a single-use link code and renders it as a QR;
 * the new device opens /link#<code> and claims it. The code rides in the URL
 * fragment so it is never sent to the server on page load.
 */

import type { HostedUser } from './useHostedAuth'

export interface DeviceLinkStart {
  requestId: string
  linkUrl: string
  expiresAt: number
}

export type DeviceLinkStatus = 'pending' | 'claimed' | 'expired'

export async function startDeviceLink(): Promise<DeviceLinkStart> {
  const res = await fetch('/api/auth/device-link/start', { method: 'POST', credentials: 'include' })
  if (!res.ok) throw new Error('Could not create a link code')
  return res.json() as Promise<DeviceLinkStart>
}

export async function fetchDeviceLinkStatus(requestId: string): Promise<DeviceLinkStatus | null> {
  const res = await fetch(`/api/auth/device-link/${encodeURIComponent(requestId)}/status`, {
    credentials: 'include',
  })
  if (!res.ok) return null
  const data = await res.json() as { status: DeviceLinkStatus }
  return data.status
}

export type ClaimFailure = 'expired' | 'invalid' | 'not_allowed' | 'network'

export type ClaimResult =
  | { ok: true; user: HostedUser }
  | { ok: false; reason: ClaimFailure }

export async function claimDeviceLink(code: string): Promise<ClaimResult> {
  try {
    const res = await fetch('/api/auth/device-link/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (res.ok) {
      const data = await res.json() as { user: HostedUser }
      return { ok: true, user: data.user }
    }
    if (res.status === 410) return { ok: false, reason: 'expired' }
    if (res.status === 403) return { ok: false, reason: 'not_allowed' }
    return { ok: false, reason: 'invalid' }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** Extract the link code from a /link#<code> fragment; null when malformed. */
export function codeFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  // 32 random bytes base64url-encoded is 43 chars; accept a sane band around it
  return /^[A-Za-z0-9_-]{20,128}$/.test(raw) ? raw : null
}
