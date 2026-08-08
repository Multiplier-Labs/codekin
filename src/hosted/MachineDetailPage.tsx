/**
 * Machine detail for the hosted app: a preflight view showing what the
 * machine is doing before the full workspace is opened against it.
 *
 * Sessions and repos are fetched over the relay through a
 * HostedRelayTransport bound to this machine, which also confirms the
 * machine really answers before the workspace mounts.
 */

import { useState, useEffect, useRef } from 'react'
import { HostedRelayTransport } from '../lib/transport'
import { ShareDialog } from './ShareDialog'
import type { Session } from '../types'
import type { Machine } from './MachinesPage'

interface RepoGroup {
  owner: string
  repos: { name: string; description?: string | null }[]
}

interface MachineDetailPageProps {
  machine: Machine
  onBack: () => void
  onOpenWorkspace: () => void
}

type LoadState = 'loading' | 'ready' | 'error'

export function MachineDetailPage({ machine, onBack, onOpenWorkspace }: MachineDetailPageProps) {
  const transportRef = useRef<HostedRelayTransport | null>(null)
  const [online, setOnline] = useState(machine.status === 'online')
  const [sessions, setSessions] = useState<Session[]>([])
  const [repoGroups, setRepoGroups] = useState<RepoGroup[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  /** Relay error code behind a failure, when there is one. */
  const [relayCode, setRelayCode] = useState<string | null>(null)
  const [sharing, setSharing] = useState<Session | null>(null)

  // Only a machine's owner may share its sessions; a guest sees just the
  // sessions already shared with them.
  const isOwner = machine.access !== 'shared'

  useEffect(() => {
    const transport = new HostedRelayTransport(machine.id)
    transportRef.current = transport
    transport.connect()

    let cancelled = false

    const load = async () => {
      setState('loading')
      setError(null)
      setRelayCode(null)
      try {
        const [sessionsRes, reposRes] = await Promise.all([
          transport.fetch('/api/sessions/list'),
          transport.fetch('/api/repos'),
        ])
        if (cancelled) return

        if (!sessionsRes.ok) {
          const detail = (await sessionsRes.json().catch(() => null)) as
            | { error?: string; relayCode?: string }
            | null
          setRelayCode(detail?.relayCode ?? null)
          throw new Error(detail?.error ?? `Machine returned ${sessionsRes.status}`)
        }

        const sessionData = (await sessionsRes.json()) as { sessions?: Session[] }
        setSessions(sessionData.sessions ?? [])
        setOnline(true)

        if (reposRes.ok) {
          const repoData = (await reposRes.json()) as { groups?: RepoGroup[] }
          setRepoGroups(repoData.groups ?? [])
        }
        setState('ready')
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setOnline(false)
        setState('error')
      }
    }

    void load()

    return () => {
      cancelled = true
      transport.close()
      transportRef.current = null
    }
  }, [machine.id])

  return (
    <div className="min-h-screen bg-page">
      <header className="flex items-center gap-3 border-b border-edge bg-surface px-6 py-3">
        <button
          onClick={onBack}
          className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          ← Machines
        </button>
        <h1 className="text-title text-ink">{machine.displayName}</h1>
        <span
          className={`h-2 w-2 rounded-full ${online ? 'bg-success-7' : 'bg-ink-faint'}`}
          aria-hidden
        />
        <span className="text-meta text-ink-muted">{online ? 'online' : 'unreachable'}</span>
        <button
          onClick={onOpenWorkspace}
          disabled={state !== 'ready'}
          className="ml-auto rounded-control border border-edge bg-primary-6 px-3 py-1.5 text-meta text-ink-inverse transition hover:bg-primary-7 disabled:opacity-50"
        >
          Open workspace
        </button>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        {state === 'loading' && <p className="text-body text-ink-muted">Contacting machine…</p>}

        {state === 'error' && (
          <div className="rounded-floating border border-edge bg-surface p-6">
            <p className="mb-1 text-body text-ink">
              {relayCode === 'local_unauthorized'
                ? 'This machine’s connector is not authorized to its local Codekin server.'
                : 'Could not reach this machine.'}
            </p>
            <p className="text-meta text-ink-muted">{error}</p>
            <p className="mt-3 text-meta text-ink-faint">
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
          </div>
        )}

        {state === 'ready' && (
          <>
            <section>
              <h2 className="mb-3 text-title text-ink">Sessions</h2>
              {sessions.length === 0 ? (
                <p className="text-body text-ink-muted">No sessions on this machine.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {sessions.map(s => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 rounded-control border border-edge bg-surface px-4 py-3"
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${s.active ? 'bg-success-7' : 'bg-ink-faint'}`}
                        aria-hidden
                      />
                      <span className="text-body text-ink">{s.name}</span>
                      <span className="truncate text-meta text-ink-faint">{s.workingDir}</span>
                      <span className="ml-auto shrink-0 text-meta text-ink-muted">
                        {s.active ? 'running' : 'idle'}
                      </span>
                      {isOwner && (
                        <button
                          onClick={() => { setSharing(s) }}
                          className="shrink-0 rounded-control border border-edge px-2 py-1 text-meta text-ink-muted transition hover:text-ink"
                        >
                          Share
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-title text-ink">Repositories</h2>
              {repoGroups.length === 0 ? (
                <p className="text-body text-ink-muted">No repositories reported.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {repoGroups.map(group => (
                    <li key={group.owner}>
                      <p className="mb-1 font-mono text-meta text-ink-muted">{group.owner}</p>
                      <ul className="flex flex-wrap gap-1.5">
                        {group.repos.map(repo => (
                          <li
                            key={repo.name}
                            className="rounded-control border border-edge bg-surface px-2 py-1 font-mono text-meta text-ink"
                          >
                            {repo.name}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="text-meta text-ink-faint">
              Open the workspace to work in these sessions from here.
            </p>
          </>
        )}
      </main>

      {sharing && (
        <ShareDialog
          machineId={machine.id}
          sessionId={sharing.id}
          sessionName={sharing.name}
          onClose={() => { setSharing(null) }}
        />
      )}
    </div>
  )
}
