/** Sign-in screen for the hosted app: GitHub OAuth entry point. */

interface LoginPageProps {
  /** Error code from a failed OAuth callback, if any. */
  authError: string | null
}

const ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: 'The sign-in attempt expired or was tampered with. Please try again.',
  token_exchange_failed: 'GitHub did not accept the sign-in. Please try again.',
  profile_fetch_failed: 'Could not read your GitHub profile. Please try again.',
  login_failed: 'Sign-in failed. Please try again.',
}

export function LoginPage({ authError }: LoginPageProps) {
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
        <a
          href="/api/auth/github/start"
          className="block w-full rounded-control bg-primary-8 px-4 py-2.5 text-body font-medium text-on-primary transition hover:bg-primary-7"
        >
          Sign in with GitHub
        </a>
      </div>
    </div>
  )
}
