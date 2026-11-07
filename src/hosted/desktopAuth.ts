/**
 * The hosted app inside the Codekin desktop app, and the desktop sign-in
 * handoff (docs/DESKTOP-APP-TAURI-PLAN.md, D9 and D12).
 *
 * Inside the app's webview, sign-in and passkey checks happen in the system
 * browser: the page navigates to `codekin://sign-in`, which the app
 * intercepts to start the handoff. Detection is by the user-agent token the
 * app sets; it only decides which buttons to show, never what is allowed.
 */

import { stepUpFetch } from './mfa'

export const DESKTOP_UA_TOKEN = 'CodekinDesktop/'

export function isDesktopApp(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return userAgent.includes(DESKTOP_UA_TOKEN)
}

/** Ask the app to sign in again through the browser (also how a passkey step-up is done). */
export function desktopSignInUrl(reason?: 'step_up'): string {
  return reason ? `codekin://sign-in?reason=${reason}` : 'codekin://sign-in'
}

export type DesktopRequestStatus = 'pending' | 'used' | 'expired'

export async function fetchDesktopRequest(id: string): Promise<{ status: DesktopRequestStatus; relayName: string } | null> {
  const res = await fetch(`/api/auth/desktop/requests/${encodeURIComponent(id)}`, { credentials: 'include' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not look up the request (${res.status})`)
  return (await res.json()) as { status: DesktopRequestStatus; relayName: string }
}

/** Approve the app's request; resolves to the `codekin://auth` URL that hands the code back. */
export async function approveDesktopRequest(id: string): Promise<string> {
  const res = await stepUpFetch(`/api/auth/desktop/requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `approve_failed_${res.status}`)
  }
  const { redirectUrl } = (await res.json()) as { redirectUrl: string }
  return redirectUrl
}

export interface DesktopSession {
  id: string
  signedInAt: number | null
  lastActiveAt: number | null
  userAgent: string | null
  current: boolean
}

export async function fetchDesktopSessions(): Promise<DesktopSession[]> {
  const res = await fetch('/api/me/desktop-sessions', { credentials: 'include' })
  if (!res.ok) throw new Error(`Could not load desktop apps (${res.status})`)
  return ((await res.json()) as { sessions: DesktopSession[] }).sessions
}

export async function revokeDesktopSession(id: string): Promise<void> {
  const res = await fetch(`/api/me/desktop-sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok && res.status !== 404) throw new Error(`Could not sign the app out (${res.status})`)
}
