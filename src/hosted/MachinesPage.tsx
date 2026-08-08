/** Machines list for the hosted app — the landing view after sign-in. */

import { useState, useEffect } from 'react'
import type { HostedUser } from './useHostedAuth'

export interface Machine {
  id: string
  displayName: string
  hostname: string | null
  platform: string | null
  connectorVersion: string | null
  localCodekinVersion: string | null
  status: 'online' | 'offline' | 'degraded'
  lastSeenAt: string | null
}

interface MachinesPageProps {
  user: HostedUser
  onLogout: () => void
  onSelect: (machine: Machine) => void
}

const STATUS_DOT: Record<Machine['status'], string> = {
  online: 'bg-success-7',
  degraded: 'bg-warning-6',
  offline: 'bg-ink-faint',
}

export function MachinesPage({ user, onLogout, onSelect }: MachinesPageProps) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/machines', { credentials: 'include' })
      .then(res => (res.ok ? res.json() as Promise<{ machines: Machine[] }> : Promise.reject(new Error(String(res.status)))))
      .then(data => { setMachines(data.machines); })
      .catch(() => { setMachines([]); })
      .finally(() => { setLoading(false); })
  }, [])

  return (
    <div className="min-h-screen bg-page">
      <header className="flex items-center justify-between border-b border-edge bg-surface px-6 py-3">
        <h1 className="font-mono text-title text-ink">Codekin</h1>
        <div className="flex items-center gap-3">
          {user.avatarUrl && (
            <img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
          )}
          <span className="text-meta text-ink-muted">{user.displayName ?? user.login}</span>
          <button
            onClick={onLogout}
            className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-6">
        <h2 className="mb-4 text-title text-ink">Machines</h2>
        {loading ? (
          <p className="text-body text-ink-muted">Loading…</p>
        ) : machines.length === 0 ? (
          <div className="rounded-floating border border-edge bg-surface p-6 text-center">
            <p className="mb-2 text-body text-ink">No machines paired yet.</p>
            <p className="text-meta text-ink-muted">
              On a machine running Codekin, run{' '}
              <code className="rounded-control bg-surface-raised px-1.5 py-0.5 font-mono text-meta text-ink">
                codekin relay login
              </code>{' '}
              to pair it, then{' '}
              <code className="rounded-control bg-surface-raised px-1.5 py-0.5 font-mono text-meta text-ink">
                codekin relay connect
              </code>{' '}
              to bring it online.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {machines.map(m => (
              <li key={m.id}>
                <button
                  onClick={() => { onSelect(m) }}
                  className="flex w-full items-center gap-3 rounded-control border border-edge bg-surface px-4 py-3 text-left transition hover:bg-surface-raised"
                >
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[m.status]}`} />
                  <span className="text-body text-ink">{m.displayName}</span>
                  {m.hostname && <span className="text-meta text-ink-faint">{m.hostname}</span>}
                  <span className="ml-auto text-meta text-ink-muted">{m.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
