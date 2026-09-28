/** Sign-in screen for the hosted app: GitHub OAuth, or a passkey if one exists. */

import { useState, useEffect } from 'react'
import { INVITE_ERROR_MESSAGES } from './workspace'
import { IconFingerprint } from '@tabler/icons-react'
import { passkeysSupported, loginWithPasskey, isPasskeyCancel } from './passkeys'
import { githubSignInHref } from './signInHref'

interface LoginPageProps {
  /** Error code from a failed OAuth callback, if any. */
  authError: string | null
  /** A passkey login succeeded — the session cookie is set; re-probe /api/me. */
  onSignedIn?: () => void
}

const ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: 'The sign-in attempt expired or was tampered with. Please try again.',
  token_exchange_failed: 'GitHub did not accept the sign-in. Please try again.',
  profile_fetch_failed: 'Could not read your GitHub profile. Please try again.',
  login_failed: 'Sign-in failed. Please try again.',
  access_not_allowed: "This GitHub account doesn't have access to this Codekin instance yet.",
  ...INVITE_ERROR_MESSAGES,
}

/** What the relay says about admission, before anyone signs in. */
interface AuthConfig {
  inviteOnly: boolean
  accessUrl?: string
}

async function fetchAuthConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch('/api/auth/config', { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as AuthConfig
  } catch {
    return null
  }
}

export function LoginPage({ authError, onSignedIn }: LoginPageProps) {
  const [busy, setBusy] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchAuthConfig().then(c => { if (!cancelled) setAuthConfig(c) })
    return () => { cancelled = true }
  }, [])

  const passkeySignIn = async () => {
    setBusy(true)
    setPasskeyError(null)
    try {
      await loginWithPasskey()
      onSignedIn?.()
    } catch (err) {
      if (!isPasskeyCancel(err)) {
        setPasskeyError('Passkey sign-in failed — use GitHub instead.')
      }
    } finally {
      setBusy(false)
    }
  }

  const accessUrl = authConfig?.accessUrl
  const requestAccess = accessUrl ? (
    <a href={accessUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
      Request access
    </a>
  ) : null

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8 text-center">
        <h1 className="mb-2 font-mono text-head text-ink">Codekin</h1>
        <p className="text-body text-ink-muted">
          Coding agents run on your own computer. Sign in here to control them from this browser, or
          from any device you link.
        </p>
        {authConfig?.inviteOnly ? (
          <p className="mt-2 mb-6 text-meta text-ink-faint" data-testid="invite-only">
            Access is currently by invitation.{requestAccess && <> {requestAccess}.</>}
          </p>
        ) : (
          <div className="mb-6" />
        )}
        {authError && (
          <p className="mb-4 rounded-control border border-error-7/60 bg-error-10/50 p-3 text-meta text-error-4">
            {ERROR_MESSAGES[authError] ?? 'Sign-in failed. Please try again.'}
            {authError === 'access_not_allowed' && requestAccess && <> {requestAccess}.</>}
          </p>
        )}
        {passkeyError && (
          <p className="mb-4 rounded-control border border-error-7/60 bg-error-10/50 p-3 text-meta text-error-4">
            {passkeyError}
          </p>
        )}
        <a
          href={githubSignInHref(window.location)}
          className="block w-full rounded-control bg-primary-8 px-4 py-2.5 text-body font-medium text-on-primary transition hover:bg-primary-7"
        >
          Sign in with GitHub
        </a>
        {passkeysSupported() && (
          <button
            onClick={() => void passkeySignIn()}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink disabled:opacity-50"
          >
            <IconFingerprint size={16} />
            {busy ? 'Waiting for the authenticator…' : 'Sign in with a passkey'}
          </button>
        )}
      </div>
    </div>
  )
}
