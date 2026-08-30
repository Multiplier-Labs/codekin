/**
 * Loops home — the operations view (spec §5.1, Phase 2 cut).
 *
 * Left: a summary strip (active / needs attention / last-7-days outcomes /
 * spend) over the run list grouped into Needs attention → Active → Recent.
 * Right: the selected run's workspace (LoopRunWorkspace: overview, timeline,
 * inline intervention cards, persistent controls). "New loop" opens the
 * four-step wizard (NewLoopWizard) — no free-text filesystem paths.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { listLoopRuns, getLoopRun, type LoopRun, type LoopRunDetail } from '../lib/loopsApi'
import { stateBadge, ACTIVE_LOOP_STATES } from '../lib/loopHelpers'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
import { formatTime } from '../lib/workflowHelpers'
import { NewLoopWizard } from './NewLoopWizard'
import { LoopRunWorkspace } from './LoopRunWorkspace'

interface Props {
  token: string
  initialSelectedRunId?: string
  onNavigateToSession?: (sessionId: string) => void
}

interface Summary {
  active: number
  attention: number
  succeeded7d: number
  failed7d: number
  spend7d: number
}

function summarize(runs: LoopRun[]): Summary {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const recent = runs.filter((r) => Date.parse(r.createdAt) >= weekAgo)
  return {
    active: runs.filter((r) => ACTIVE_LOOP_STATES.has(r.state)).length,
    attention: runs.filter((r) => r.state === 'awaiting_approval').length,
    succeeded7d: recent.filter((r) => r.outcome === 'completed' || r.outcome === 'completed_with_warnings').length,
    failed7d: recent.filter((r) => r.outcome === 'failed').length,
    spend7d: recent.reduce((sum, r) => sum + r.costUsd, 0),
  }
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'warning' | 'none' }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={`truncate text-body font-semibold ${accent === 'warning' ? 'text-warning-2' : 'text-ink'}`}>{value}</span>
      <span className="truncate text-micro text-ink-faint">{label}</span>
    </div>
  )
}

function RunRow({ run, selected, onSelect }: { run: LoopRun; selected: boolean; onSelect: () => void }) {
  const badge = stateBadge(run)
  return (
    <button
      onClick={onSelect}
      className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}
    >
      <span className="flex items-center gap-2">
        <span className="truncate text-body font-medium text-ink">{run.recipeId}</span>
        <span className={`ml-auto inline-flex flex-shrink-0 items-center rounded-control px-1.5 py-0.5 text-micro font-medium ${badge.classes}`}>
          {badge.label}
        </span>
      </span>
      <span className="flex items-center gap-2 text-meta text-ink-muted">
        <span className="truncate">{run.stateReason && run.state === 'awaiting_approval' ? run.stateReason : run.branch}</span>
        <span className="ml-auto flex-shrink-0 text-ink-faint">{formatTime(run.createdAt)}</span>
      </span>
    </button>
  )
}

function Section({ title, runs, selectedRunId, onSelect }: {
  title: string
  runs: LoopRun[]
  selectedRunId: string | null
  onSelect: (id: string) => void
}) {
  if (runs.length === 0) return null
  return (
    <div>
      <h3 className="sticky top-0 border-b border-edge bg-surface px-3 py-1 text-micro font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h3>
      <ul className="divide-y divide-edge">
        {runs.map((run) => (
          <li key={run.id}>
            <RunRow run={run} selected={selectedRunId === run.id} onSelect={() => { onSelect(run.id) }} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LoopsView({ token, initialSelectedRunId, onNavigateToSession }: Props) {
  const [runs, setRuns] = useState<LoopRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState(initialSelectedRunId ?? null)
  const [detail, setDetail] = useState<LoopRunDetail | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRuns(await listLoopRuns(token, { limit: 200 }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load loop runs')
    }
  }, [token])

  const refreshDetail = useCallback(async (runId: string) => {
    try {
      setDetail(await getLoopRun(token, runId))
    } catch {
      /* stale selection */
    }
  }, [token])

  // Initial load (inline promise so no setState runs synchronously in the effect body).
  useEffect(() => {
    let cancelled = false
    listLoopRuns(token, { limit: 200 })
      .then((r) => { if (!cancelled) setRuns(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // Fetch detail on selection; a stale detail is hidden by the id guard at render.
  useEffect(() => {
    if (!selectedRunId) return
    let cancelled = false
    getLoopRun(token, selectedRunId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedRunId, token])

  // Push-first refresh off the shared run-event channel, slow poll as net.
  useEffect(() => {
    const poll = setInterval(() => { void refresh() }, 60_000)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents((event) => {
      if (event.engine !== 'loop') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        void refresh()
        if (selectedRunId) void refreshDetail(selectedRunId)
      }, 300)
    })
    return () => {
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh, refreshDetail, selectedRunId])

  const act = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn()
      await refresh()
      if (selectedRunId) await refreshDetail(selectedRunId)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    }
  }, [refresh, refreshDetail, selectedRunId])

  const summary = summarize(runs)
  const attention = runs.filter((r) => r.state === 'awaiting_approval')
  const activeRuns = runs.filter((r) => ACTIVE_LOOP_STATES.has(r.state) || r.state === 'paused')
  const recent = runs.filter((r) => r.state === 'done')

  return (
    <div className="flex h-full overflow-hidden">
      {/* Home column */}
      <div className="flex w-80 flex-shrink-0 flex-col border-r border-edge">
        {/* Summary strip */}
        <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
          <div className="grid flex-1 grid-cols-4 gap-2">
            <Stat label="active" value={String(summary.active)} />
            <Stat label="attention" value={String(summary.attention)} accent={summary.attention > 0 ? 'warning' : 'none'} />
            <Stat label="7d ✓/✗" value={`${summary.succeeded7d}/${summary.failed7d}`} />
            <Stat label="7d spend" value={`$${summary.spend7d.toFixed(2)}`} />
          </div>
          <button
            onClick={() => { setShowWizard(true) }}
            className="flex flex-shrink-0 items-center gap-1 rounded-control bg-primary-8 px-2 py-1 text-meta font-medium text-on-primary hover:bg-primary-7 transition-colors"
          >
            <IconPlus size={13} stroke={2} /> New loop
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 ? (
            <div className="px-3 py-10 text-center text-meta text-ink-muted">
              No loop runs yet. Start one — it plans, works, and verifies in an isolated worktree.
            </div>
          ) : (
            <>
              <Section title="Needs attention" runs={attention} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
              <Section title="Active" runs={activeRuns} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
              <Section title="Recent" runs={recent} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
            </>
          )}
        </div>
      </div>

      {/* Workspace */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {error && <div className="border-b border-error-9/50 bg-error-10/40 px-4 py-2 text-body text-error-4">{error}</div>}
        {!detail || detail.id !== selectedRunId ? (
          <div className="flex flex-1 items-center justify-center text-body text-ink-muted">
            Select a run — or start a new loop — to see its plan, evidence, and controls.
          </div>
        ) : (
          <LoopRunWorkspace token={token} detail={detail} onAct={act} onNavigateToSession={onNavigateToSession} />
        )}
      </div>

      {showWizard && (
        <NewLoopWizard
          token={token}
          onClose={() => { setShowWizard(false) }}
          onStarted={(run) => {
            setShowWizard(false)
            setSelectedRunId(run.id)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
