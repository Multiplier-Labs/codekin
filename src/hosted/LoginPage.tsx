/** Sign-in screen for the hosted app: GitHub OAuth, or a passkey if one exists. */

import { useState } from 'react'
import { IconFingerprint } from '@tabler/icons-react'
import { passkeysSupported, loginWithPasskey, isPasskeyCancel } from './passkeys'

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
  access_not_allowed: 'This Codekin instance is private and your GitHub account is not allowed.',
}

export function LoginPage({ authError, onSignedIn }: LoginPageProps) {
  const [busy, setBusy] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8 text-center">
        <h1 className="mb-2 font-mono text-head text-ink">Codekin</h1>
        <p className="mb-6 text-body text-ink-muted">
          Sign in to reach your team's coding agents.
        </p>
        {authError && (
          <p className="mb-4 rounded-control border border-error-7/60 bg-error-10/50 p-3 text-meta text-error-4">
            {ERROR_MESSAGES[authError] ?? 'Sign-in failed. Please try again.'}
          </p>
        )}
        {passkeyError && (
          <p className="mb-4 rounded-control border border-error-7/60 bg-error-10/50 p-3 text-meta text-error-4">
            {passkeyError}
          </p>
        )}
        <a
          href="/api/auth/github/start"
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
