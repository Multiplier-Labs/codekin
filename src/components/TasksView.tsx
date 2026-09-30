/**
 * Tasks — the global view of work delegated to Agent Joe
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §2).
 *
 * Replaces the standalone Joe chat: conversation with Joe happens in repo
 * sessions (@Joe); this view is oversight — a compact per-repo overview,
 * then decisions, reviews, running, queued and closed work. Structured
 * controls and New task only; there is deliberately no chat composer here.
 * Joe's own transcript stays reachable as its activity log.
 */

import { useState } from 'react'
import { IconRobotFace, IconNotes, IconAlertTriangle } from '@tabler/icons-react'
import type { Repo } from '../types'
import { PROVIDERS, type CodingProvider } from '../types'
import { JoeTasksView } from './JoeTasksView'
import { repoName, type TaskList } from '../lib/tasksApi'
import { summarizeRepos } from '../lib/taskSections'
import * as api from '../lib/ccApi'
import { useAgentHealth } from '../hooks/useAgentHealth'
import { providerAvailability } from '../lib/agentHealth'
import type { JoeStatus } from '../hooks/useJoeStatus'

interface Props {
  token: string
  data: TaskList | null
  error: string | null
  onChanged: () => void
  repos: Repo[]
  repoFilter: string
  onRepoFilterChange: (repo: string) => void
  agentName: string
  joeStatus: JoeStatus | null
  onJoeStatusChanged: () => void
  /** Joe is blocked on one of the user's approvals (answered in its log). */
  joeWaiting: boolean
  onOpenSession: (sessionId: string) => void
  onOpenJoeLog: () => void
}

export function TasksView({
  token, data, error, onChanged, repos, repoFilter, onRepoFilterChange,
  agentName, joeStatus, onJoeStatusChanged, joeWaiting, onOpenSession, onOpenJoeLog,
}: Props) {
  const summaries = summarizeRepos(data)

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <h1 className="text-title font-semibold text-ink">Tasks</h1>
        <span className="text-meta text-ink-muted">Work delegated to Agent {agentName} — ask from any session with @{agentName}</span>
        <button
          type="button"
          onClick={onOpenJoeLog}
          className="ml-auto inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-meta text-ink-muted hover:bg-surface-raised hover:text-ink"
          title={`Agent ${agentName}'s own transcript: notifications it handled and actions it took`}
        >
          <IconNotes size={14} stroke={2} /> {agentName}'s log
        </button>
      </div>

      {joeWaiting && (
        <button
          type="button"
          onClick={onOpenJoeLog}
          className="flex items-center gap-2 border-b border-warning-8/50 bg-surface px-4 py-2 text-left text-meta text-ink"
        >
          <IconAlertTriangle size={15} stroke={2} className="text-warning-5" />
          Agent {agentName} is waiting for your approval — open its log to answer.
        </button>
      )}

      {joeStatus && !joeStatus.provider && (
        <JoeSetup token={token} agentName={agentName} onReady={onJoeStatusChanged} />
      )}

      {summaries.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-edge px-4 py-2" role="group" aria-label="Repos with open tasks">
          {summaries.map(s => {
            const active = repoFilter === s.repo
            return (
              <button
                key={s.repo}
                type="button"
                aria-pressed={active}
                onClick={() => { onRepoFilterChange(active ? '' : s.repo) }}
                className={`flex items-center gap-2 rounded-control border px-2.5 py-1 text-meta ${active ? 'border-edge-strong bg-surface-raised text-ink' : 'border-edge text-ink-muted hover:border-edge-strong hover:text-ink'}`}
              >
                <span className="font-medium text-ink">{repoName(s.repo)}</span>
                {s.needsYou > 0 && <span className="rounded-full bg-warning-7 px-1.5 text-micro font-semibold text-warning-1">{s.needsYou} need{s.needsYou === 1 ? 's' : ''} you</span>}
                {s.running > 0 && <span>{s.running} running</span>}
                {s.queued > 0 && <span>{s.queued} queued</span>}
                {s.needsYou + s.running + s.queued === 0 && <span>{s.open} to do</span>}
              </button>
            )
          })}
        </div>
      )}

      <JoeTasksView
        token={token}
        data={data}
        error={error}
        repos={repos}
        repoFilter={repoFilter}
        onRepoFilterChange={onRepoFilterChange}
        onChanged={onChanged}
        onOpenSession={onOpenSession}
        agentName={agentName}
      />
    </div>
  )
}

/** First run: Joe needs a harness before it can take requests. */
function JoeSetup({ token, agentName, onReady }: { token: string; agentName: string; onReady: () => void }) {
  const health = useAgentHealth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(provider: CodingProvider) {
    setBusy(true)
    setError(null)
    try {
      await api.startOrchestrator(token, provider)
      onReady()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start Agent ${agentName}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-edge px-4 py-3">
      <div className="flex items-center gap-2 text-body font-medium text-ink">
        <IconRobotFace size={16} stroke={2} className="text-accent-5" /> Choose an agent for {agentName}
      </div>
      <p className="mt-1 text-meta text-ink-muted">
        {agentName} and the sessions it starts use this agent. You can change it later from {agentName}'s log.
      </p>
      {error && <p role="alert" className="mt-1 text-meta text-error-5">{error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {PROVIDERS.map(provider => {
          const availability = providerAvailability(health, provider.id)
          return (
            <button
              key={provider.id}
              type="button"
              disabled={busy || !availability.available}
              title={availability.hint ?? provider.description}
              onClick={() => { void choose(provider.id) }}
              className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink hover:border-edge-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {provider.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
