/**
 * Client side of two-factor authentication (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 3).
 *
 * Two pieces:
 * - the relay's 2FA API (status, verify, authenticator enrollment, recovery
 *   codes, passkey verification);
 * - step-up: sensitive relay calls go through `stepUpFetch`, which, when the
 *   relay answers `401 step_up_required`, asks the mounted StepUpHost to
 *   re-verify the user and then retries the call once.
 */

import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

export type AuthLevel = 'full' | 'mfa_pending' | 'enrollment_required'

export interface MfaStatus {
  totp: boolean
  passkeys: number
  recoveryCodesRemaining: number
  required: boolean
  totpAvailable: boolean
}

export class MfaError extends Error {
  readonly code: string | null

  constructor(code: string | null, message: string) {
    super(message)
    this.code = code
  }
}

const MESSAGES: Record<string, string> = {
  invalid_code: 'That code did not work. Check the app (or the recovery code) and try again.',
  too_many_attempts: 'Too many wrong codes. Wait 15 minutes, then try again.',
  no_enrollment: 'The setup timed out. Start again.',
  totp_unavailable: 'Authenticator apps are not available on this server. Use a passkey instead.',
  mfa_required_by_role: 'Your role requires two-factor authentication, so this is your last factor and cannot be removed.',
  already_enabled: 'An authenticator app is already set up.',
  session_expired: 'Your sign-in timed out. Sign in again.',
}

async function post<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await stepUpFetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    const code = data?.error ?? null
    throw new MfaError(code, (code && MESSAGES[code]) ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export async function fetchMfaStatus(): Promise<MfaStatus> {
  const res = await fetch('/api/auth/mfa', { credentials: 'include' })
  if (!res.ok) throw new MfaError(null, 'Could not load two-factor settings')
  return ((await res.json()) as { mfa: MfaStatus }).mfa
}

/** Verify a TOTP or recovery code (second step of sign-in, or step-up). */
export async function verifyCode(code: string): Promise<{ recoveryCodesRemaining?: number }> {
  return post('/api/auth/mfa/verify', { code })
}

/** Verify with one of this account's passkeys (second step of sign-in, or step-up). */
export async function verifyWithPasskey(): Promise<void> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/webauthn/verify/options')
  const response = await startAuthentication({ optionsJSON: options })
  await post('/api/auth/webauthn/verify/verify', { response })
}

export async function beginTotpSetup(): Promise<{ secret: string; uri: string }> {
  return post('/api/auth/mfa/totp/setup')
}

export async function confirmTotpSetup(code: string): Promise<string[]> {
  return (await post<{ recoveryCodes: string[] }>('/api/auth/mfa/totp/confirm', { code })).recoveryCodes
}

export async function disableTotp(): Promise<void> {
  await post('/api/auth/mfa/totp', undefined, { method: 'DELETE' })
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  return (await post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes')).recoveryCodes
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/** What the relay wants re-proved: a second factor, or (without one) a fresh GitHub sign-in. */
export type StepUpMethod = 'mfa' | 'github'

/** Thrown when the user dismisses the step-up prompt; callers treat it as a quiet cancel. */
export class StepUpCancelled extends Error {
  constructor() {
    super('Confirmation cancelled')
    this.name = 'StepUpCancelled'
  }
}

type StepUpHandler = (method: StepUpMethod) => Promise<void>
let handler: StepUpHandler | null = null

/** Installed by StepUpHost while it is mounted. */
export function setStepUpHandler(next: StepUpHandler | null): void {
  handler = next
}

/**
 * fetch for relay calls that may require a fresh second-factor check. On
 * `401 step_up_required` the user is asked to confirm it is them, then the
 * request is sent once more. Bodies must be replayable (strings), which
 * every caller here uses.
 */
export async function stepUpFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status !== 401 || !handler) return res
  const body = (await res.clone().json().catch(() => null)) as { error?: string; method?: StepUpMethod } | null
  if (body?.error !== 'step_up_required') return res
  await handler(body.method === 'github' ? 'github' : 'mfa')
  return fetch(input, init)
}

export function isStepUpCancel(err: unknown): boolean {
  return err instanceof StepUpCancelled
}
