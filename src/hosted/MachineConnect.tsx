/**
 * Connection gate for the hosted workspace.
 *
 * Selecting a machine lands here, not on a preview: it opens the relay
 * connection, confirms the machine actually answers with one preflight
 * request, and then hands off to the workspace. A failure keeps the user
 * here with the reason and a retry — the workspace only ever mounts against
 * a machine that responded.
 */

import { useState, useEffect } from 'react'
import type { HostedRelayTransport } from '../lib/transport'
import type { Machine } from './machines'

interface MachineConnectProps {
  machine: Machine
  transport: HostedRelayTransport
  onBack: () => void
  onConnected: () => void
}

type State = 'connecting' | 'error'

export function MachineConnect({ machine, transport, onBack, onConnected }: MachineConnectProps) {
  const [state, setState] = useState<State>('connecting')
  const [error, setError] = useState<string | null>(null)
  /** Relay error code behind a failure, when there is one. */
  const [relayCode, setRelayCode] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    const probe = async () => {
      setState('connecting')
      setError(null)
      setRelayCode(null)
      try {
        // One cheap round trip proves the whole path: relay socket up, the
        // machine's connector online, and its local token accepted.
        const res = await transport.fetch('/api/sessions/list')
        if (cancelled) return
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as
            | { error?: string; relayCode?: string }
            | null
          setRelayCode(detail?.relayCode ?? null)
          throw new Error(detail?.error ?? `Machine returned ${res.status}`)
        }
        onConnected()
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
      }
    }

    void probe()
    return () => { cancelled = true }
    // onConnected/transport are stable for a given machine; attempt re-runs it.
  }, [transport, attempt, onConnected])

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8 text-center">
        <h1 className="mb-1 text-title text-ink">{machine.displayName}</h1>

        {state === 'connecting' && (
          <>
            <p className="mb-6 text-body text-ink-muted">Connecting…</p>
            <div
              className="mx-auto h-1 w-24 overflow-hidden rounded-full bg-surface-raised"
              aria-hidden
            >
              <div className="h-full w-1/2 animate-pulse rounded-full bg-primary-6" />
            </div>
          </>
        )}

        {state === 'error' && (
          <>
            <p className="mb-2 text-body text-ink">
              {relayCode === 'local_unauthorized'
                ? 'This machine’s connector is not authorized to its local Codekin server.'
                : 'Could not reach this machine.'}
            </p>
            <p className="mb-4 text-meta text-ink-muted">{error}</p>
            <p className="mb-6 text-meta text-ink-faint">
              {relayCode === 'local_unauthorized' ? (
                <>
                  The connector is running, but holding the wrong token. Restart it with{' '}
                  <code className="font-mono">AUTH_TOKEN_FILE</code> set to the token that machine’s
                  server uses.
                </>
              ) : (
                <>
                  Make sure <code className="font-mono">codekin relay connect</code> is running on it.
                </>
              )}
            </p>
            <div className="flex justify-center gap-2">
              <button
                onClick={onBack}
                className="rounded-control border border-edge px-4 py-2 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink"
              >
                ← Machines
              </button>
              <button
                onClick={() => { setAttempt(a => a + 1) }}
                className="rounded-control bg-primary-6 px-4 py-2 text-meta text-ink-inverse transition hover:bg-primary-7"
              >
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
