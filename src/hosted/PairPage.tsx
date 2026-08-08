/** Approval screen for a machine pairing request (/pair?code=XXXX-XXXX). */

import { useState, useEffect, useCallback } from 'react'

interface PairingRequest {
  userCode: string
  hostname: string | null
  platform: string | null
  status: 'pending' | 'approved' | 'denied' | 'claimed' | 'expired'
  createdAt: string
}

type Phase = 'loading' | 'review' | 'approved' | 'denied' | 'unavailable'

export function PairPage() {
  const initialCode = new URLSearchParams(window.location.search).get('code') ?? ''
  const [code, setCode] = useState(initialCode)
  const [request, setRequest] = useState<PairingRequest | null>(null)
  const [phase, setPhase] = useState<Phase>(initialCode ? 'loading' : 'review')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const lookup = useCallback(async (userCode: string) => {
    setError(null)
    setPhase('loading')
    try {
      const res = await fetch(`/api/machines/pair/info?code=${encodeURIComponent(userCode)}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        setPhase('review')
        setRequest(null)
        setError(res.status === 404 ? 'No pairing request found for that code.' : 'Could not look up the code.')
        return
      }
      const data = await res.json() as { request: PairingRequest }
      setRequest(data.request)
      if (data.request.status === 'pending') {
        setPhase('review')
      } else {
        setPhase('unavailable')
      }
    } catch {
      setPhase('review')
      setError('Could not look up the code.')
    }
  }, [])

  useEffect(() => {
    if (initialCode) void lookup(initialCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the URL-provided code
  }, [])

  async function decide(action: 'approve' | 'deny') {
    setError(null)
    try {
      const res = await fetch(`/api/machines/pair/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'approve' ? { code, displayName: displayName || undefined } : { code },
        ),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error === 'expired' ? 'This pairing request has expired.' : 'That did not work — try again.')
        return
      }
      setPhase(action === 'approve' ? 'approved' : 'denied')
    } catch {
      setError('That did not work — try again.')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-md rounded-floating border border-edge bg-surface p-8">
        <h1 className="mb-4 font-mono text-title text-ink">Pair a machine</h1>

        {phase === 'approved' && (
          <p className="text-body text-ink">
            Machine paired. Return to your terminal — the CLI picks it up automatically.
          </p>
        )}

        {phase === 'denied' && <p className="text-body text-ink">Pairing request denied.</p>}

        {phase === 'unavailable' && request && (
          <p className="text-body text-ink-muted">
            This pairing request is {request.status === 'expired' ? 'expired' : `already ${request.status}`}.
            {request.status === 'expired' && ' Run `codekin relay login` again on the machine.'}
          </p>
        )}

        {phase === 'loading' && <p className="text-body text-ink-muted">Looking up the request…</p>}

        {phase === 'review' && (
          <>
            {request && request.status === 'pending' ? (
              <>
                <p className="mb-4 text-body text-ink-muted">
                  A machine is asking to join. Approving lets it appear in your machines list and, in
                  later versions, relay sessions.
                </p>
                <dl className="mb-4 rounded-control border border-edge bg-surface-raised p-4 text-body">
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Code</dt>
                    <dd className="font-mono text-ink">{request.userCode}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Hostname</dt>
                    <dd className="text-ink">{request.hostname ?? 'unknown'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Platform</dt>
                    <dd className="text-ink">{request.platform ?? 'unknown'}</dd>
                  </div>
                </dl>
                <label className="mb-4 block">
                  <span className="mb-1 block text-meta text-ink-muted">Display name (optional)</span>
                  <input
                    value={displayName}
                    onChange={e => { setDisplayName(e.target.value) }}
                    placeholder={request.hostname ?? 'My machine'}
                    className="w-full rounded-control border border-edge bg-page px-3 py-2 text-body text-ink focus:border-focus focus:outline-none"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => void decide('approve')}
                    className="flex-1 rounded-control bg-primary-8 px-4 py-2.5 text-body font-medium text-on-primary transition hover:bg-primary-7"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void decide('deny')}
                    className="flex-1 rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink"
                  >
                    Deny
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mb-4 text-body text-ink-muted">
                  Enter the code shown by <code className="font-mono">codekin relay login</code>.
                </p>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={e => { setCode(e.target.value.toUpperCase()) }}
                    placeholder="XXXX-XXXX"
                    className="flex-1 rounded-control border border-edge bg-page px-3 py-2 font-mono text-body text-ink focus:border-focus focus:outline-none"
                  />
                  <button
                    onClick={() => void lookup(code)}
                    disabled={!code.trim()}
                    className="rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary transition hover:bg-primary-7 disabled:opacity-50"
                  >
                    Look up
                  </button>
                </div>
              </>
            )}
            {error && <p className="mt-3 text-meta text-error-4">{error}</p>}
          </>
        )}

        <a href="/" className="mt-6 block text-meta text-ink-faint hover:text-ink-muted">
          ← Back to machines
        </a>
      </div>
    </div>
  )
}
