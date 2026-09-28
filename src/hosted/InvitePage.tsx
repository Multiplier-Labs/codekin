/**
 * Landing page for an invitation link (`/invite#<token>`), shown before the
 * auth gate: an invitee usually has no account yet.
 *
 * The token rides in the URL fragment, so it never reaches the server on
 * page load; it is read once and stripped from the address bar. Accepting
 * always goes through GitHub sign-in, which is where the relay checks that
 * the signed-in account is the one invited.
 */

import { useEffect, useState } from 'react'
import { acceptInvitationViaGithub, lookupInvitation, ROLE_LABELS, type InvitationPreview } from './workspace'

function readToken(): string {
  const token = window.location.hash.slice(1)
  if (token) history.replaceState(null, '', window.location.pathname)
  return token
}

const UNUSABLE: Record<string, string> = {
  accepted: 'This invitation has already been used.',
  revoked: 'This invitation was withdrawn.',
  expired: 'This invitation has expired.',
  unavailable: 'This invitation can no longer be used.',
}

export function InvitePage() {
  const [token] = useState(readToken)
  const [preview, setPreview] = useState<InvitationPreview | null | 'loading'>(token ? 'loading' : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    lookupInvitation(token)
      .then(setPreview)
      .catch(() => { setPreview(null) })
  }, [token])

  const accept = () => {
    setBusy(true)
    setError(null)
    acceptInvitationViaGithub(token).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not continue. Try again.')
      setBusy(false)
    })
  }

  let body: React.ReactNode
  if (preview === 'loading') {
    body = <p className="text-body text-ink-muted">Checking your invitation…</p>
  } else if (preview === null) {
    body = <p className="text-body text-ink">This invitation link is not valid. Check that you copied all of it.</p>
  } else if (preview.status !== 'pending') {
    body = (
      <>
        <p className="text-body text-ink">{UNUSABLE[preview.status]}</p>
        <p className="mt-2 text-meta text-ink-muted">Ask whoever invited you for a new link.</p>
      </>
    )
  } else {
    body = (
      <>
        <p className="text-body text-ink">
          {preview.inviterLogin ? <span className="font-mono">{preview.inviterLogin}</span> : 'Someone'} invited you to
          join <span className="font-semibold">{preview.workspaceName}</span> as {ROLE_LABELS[preview.role].toLowerCase()}.
        </p>
        <p className="mt-2 text-meta text-ink-muted">
          {preview.boundTo === 'github' && preview.githubLogin
            ? <>Sign in as the GitHub account <span className="font-mono">{preview.githubLogin}</span> to accept.</>
            : 'Sign in with the GitHub account that has the invited email address verified.'}
        </p>
        <button
          onClick={accept}
          disabled={busy}
          className="mt-6 w-full rounded-control bg-primary-6 px-4 py-2.5 text-body text-ink-inverse transition hover:bg-primary-7 disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : 'Accept with GitHub'}
        </button>
        {error && <p className="mt-3 text-meta text-error-4">{error}</p>}
      </>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8">
        <h1 className="mb-4 text-center font-mono text-head text-ink">Codekin</h1>
        {body}
      </div>
    </div>
  )
}
