/**
 * Approval screen for the desktop app's sign-in (/desktop-auth?request=…).
 *
 * Reached in the system browser after the app opened
 * /api/auth/desktop/start. The user confirms, the relay mints a one-time
 * code, and the browser hands it to the app via `codekin://auth`. Asking
 * first means a link someone else started can't sign an app in silently.
 */

import { useEffect, useState } from 'react'
import { approveDesktopRequest, fetchDesktopRequest } from './desktopAuth'
import { isStepUpCancel } from './mfa'

type Phase = 'loading' | 'review' | 'handing_off' | 'unavailable' | 'error'

interface DesktopAuthPageProps {
  login: string
}

const primary =
  'w-full rounded-control bg-primary-8 px-4 py-2.5 text-body font-medium text-on-primary transition hover:bg-primary-7 disabled:opacity-50'

export function DesktopAuthPage({ login }: DesktopAuthPageProps) {
  const requestId = new URLSearchParams(window.location.search).get('request') ?? ''
  const [phase, setPhase] = useState<Phase>('loading')
  const [relayName, setRelayName] = useState('')
  const [reason, setReason] = useState<string | null>(null)
  const [appUrl, setAppUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchDesktopRequest(requestId)
      .then(info => {
        if (cancelled) return
        if (!info) {
          setPhase('unavailable')
          setReason('This sign-in request was not found.')
          return
        }
        setRelayName(info.relayName)
        if (info.status === 'pending') setPhase('review')
        else {
          setPhase('unavailable')
          setReason(info.status === 'expired' ? 'This sign-in request has expired.' : 'This sign-in request was already used.')
        }
      })
      .catch(() => { if (!cancelled) setPhase('error') })
    return () => { cancelled = true }
  }, [requestId])

  const approve = async () => {
    setBusy(true)
    try {
      const url = await approveDesktopRequest(requestId)
      setAppUrl(url)
      setPhase('handing_off')
      window.location.assign(url)
    } catch (err) {
      if (isStepUpCancel(err)) return
      const code = err instanceof Error ? err.message : ''
      setPhase('unavailable')
      setReason(code === 'expired' ? 'This sign-in request has expired.' : code === 'used' ? 'This sign-in request was already used.' : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="w-full max-w-md rounded-floating border border-edge bg-surface p-8">
        <h1 className="mb-4 font-mono text-title text-ink">Sign in to the Codekin app</h1>

        {phase === 'loading' && <p className="text-body text-ink-muted">Looking up the request…</p>}

        {phase === 'review' && (
          <>
            <p className="mb-2 text-body text-ink">
              The Codekin desktop app is asking to sign in to {relayName} as{' '}
              <span className="font-mono">@{login}</span>.
            </p>
            <p className="mb-6 text-meta text-ink-muted">
              Only continue if you just chose “Sign in” in the app on this computer.
            </p>
            <button onClick={() => void approve()} disabled={busy} className={primary}>
              {busy ? 'Signing in…' : 'Sign in to the app'}
            </button>
          </>
        )}

        {phase === 'handing_off' && (
          <>
            <p className="mb-4 text-body text-ink">You can return to Codekin. This tab can be closed.</p>
            {appUrl && (
              <a href={appUrl} className="text-meta text-ink-muted underline underline-offset-2 hover:text-ink">
                Open Codekin
              </a>
            )}
          </>
        )}

        {phase === 'unavailable' && (
          <p className="text-body text-ink-muted">{reason} Start again from the app.</p>
        )}

        {phase === 'error' && <p className="text-body text-ink-muted">Could not look up the request. Reload to try again.</p>}
      </div>
    </div>
  )
}
