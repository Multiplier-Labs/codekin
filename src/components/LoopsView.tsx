/**
 * Loops 2.0 — interim run list + control surface.
 *
 * Left: runs with execution state / outcome. Right: the selected run's
 * stages, evaluator scorecard, pending intervention cards (resolved inline —
 * no detour into a raw session), and the persistent controls (pause, resume,
 * steer, cancel). A start form launches a run from a recipe.
 *
 * This is deliberately thin: the Phase 2 control plane (wizard, four-tab run
 * workspace, timeline) replaces it. It exists so every Phase 1 engine
 * capability is operable from the UI, not only via /api/loops.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconPlus, IconPlayerPause, IconPlayerPlay, IconSquare, IconExternalLink, IconMessageForward } from '@tabler/icons-react'
import {
  listLoopRuns,
  getLoopRun,
  listLoopRecipes,
  startLoopRun,
  pauseLoopRun,
  resumeLoopRun,
  cancelLoopRun,
  steerLoopRun,
  resolveLoopIntervention,
  type LoopRun,
  type LoopRunDetail,
  type LoopRecipeInfo,
  type LoopRunState,
} from '../lib/loopsApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
import { formatTime } from '../lib/workflowHelpers'

function stateBadge(run: LoopRun): { label: string; classes: string } {
  if (run.state === 'done') {
    switch (run.outcome) {
      case 'completed': return { label: 'completed', classes: 'bg-success-7 text-success-2' }
      case 'completed_with_warnings': return { label: 'completed*', classes: 'bg-success-8 text-success-3' }
      case 'canceled': return { label: 'canceled', classes: 'bg-warning-8 text-warning-2' }
      default: return { label: 'failed', classes: 'bg-error-8 text-error-2' }
    }
  }
  switch (run.state) {
    case 'awaiting_approval': return { label: 'needs decision', classes: 'bg-warning-7 text-warning-1 animate-pulse' }
    case 'paused': return { label: 'paused', classes: 'bg-edge-strong text-ink-muted' }
    case 'pausing': return { label: 'pausing…', classes: 'bg-edge-strong text-ink-muted' }
    case 'evaluating': return { label: 'evaluating', classes: 'bg-accent-8 text-accent-2 animate-pulse' }
    case 'reviewing': return { label: 'reviewing', classes: 'bg-primary-8 text-primary-2 animate-pulse' }
    default: return { label: run.state, classes: 'bg-accent-8 text-accent-2 animate-pulse' }
  }
}

const ACTIVE_STATES: ReadonlySet<LoopRunState> = new Set([
  'created', 'preflight', 'executing', 'evaluating', 'reviewing', 'finalizing', 'recovering', 'pausing', 'canceling',
])

interface Props {
  token: string
  initialSelectedRunId?: string
  onNavigateToSession?: (sessionId: string) => void
}

export function LoopsView({ token, initialSelectedRunId, onNavigateToSession }: Props) {
  const [runs, setRuns] = useState<LoopRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState(initialSelectedRunId ?? null)
  const [detail, setDetail] = useState<LoopRunDetail | null>(null)
  const [showStart, setShowStart] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRuns(await listLoopRuns(token, { limit: 100 }))
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
    listLoopRuns(token, { limit: 100 })
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

  return (
    <div className="flex h-full overflow-hidden">
      {/* Run list */}
      <div className="flex w-72 flex-shrink-0 flex-col border-r border-edge">
        <div className="flex items-center justify-between border-b border-edge px-3 py-2">
          <span className="text-meta font-medium text-ink-muted">Loop runs</span>
          <button
            onClick={() => { setShowStart(true) }}
            className="flex items-center gap-1 rounded-control bg-accent-9/30 px-2 py-1 text-meta text-accent-2 hover:bg-accent-9/50 transition-colors"
          >
            <IconPlus size={13} stroke={2} /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 ? (
            <div className="px-3 py-8 text-center text-meta text-ink-muted">No loop runs yet.</div>
          ) : (
            <ul className="divide-y divide-edge">
              {runs.map((run) => {
                const badge = stateBadge(run)
                return (
                  <li key={run.id}>
                    <button
                      onClick={() => { setSelectedRunId(run.id) }}
                      className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                        selectedRunId === run.id ? 'bg-surface-raised' : 'hover:bg-surface-raised'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-body font-medium text-ink">{run.recipeId}</span>
                        <span className={`ml-auto inline-flex flex-shrink-0 items-center rounded-control px-1.5 py-0.5 text-micro font-medium ${badge.classes}`}>
                          {badge.label}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-meta text-ink-muted">
                        <span className="truncate">{run.branch}</span>
                        <span className="ml-auto flex-shrink-0 text-ink-faint">{formatTime(run.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {error && <div className="border-b border-error-9/50 bg-error-10/40 px-4 py-2 text-body text-error-4">{error}</div>}
        {!detail || detail.id !== selectedRunId ? (
          <div className="flex flex-1 items-center justify-center text-body text-ink-muted">
            Select a run to see its stages, evaluations, and controls.
          </div>
        ) : (
          <RunDetail token={token} detail={detail} onAct={act} onNavigateToSession={onNavigateToSession} />
        )}
      </div>

      {showStart && (
        <StartLoopModal
          token={token}
          onClose={() => { setShowStart(false) }}
          onStarted={(run) => {
            setShowStart(false)
            setSelectedRunId(run.id)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-micro uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="truncate text-body text-ink">{value}</span>
    </div>
  )
}

function RunDetail({
  token,
  detail,
  onAct,
  onNavigateToSession,
}: {
  token: string
  detail: LoopRunDetail
  onAct: (fn: () => Promise<void>) => Promise<void>
  onNavigateToSession?: (sessionId: string) => void
}) {
  const [steerText, setSteerText] = useState('')
  const [noteById, setNoteById] = useState<Record<string, string>>({})
  const badge = stateBadge(detail)
  const pending = detail.interventions.filter((iv) => iv.status === 'pending')
  const active = ACTIVE_STATES.has(detail.state)

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title text-ink">{detail.recipeId}</h2>
          <p className="mt-0.5 line-clamp-2 text-meta text-ink-muted">{detail.goal.split('\n')[0]}</p>
        </div>
        <span className={`inline-flex flex-shrink-0 items-center rounded-control px-2 py-1 text-meta font-medium ${badge.classes}`}>
          {badge.label}
        </span>
      </div>
      {detail.stateReason && <p className="text-meta text-warning-3">{detail.stateReason}</p>}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {active && (
          <button onClick={() => { void onAct(() => pauseLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
            <IconPlayerPause size={13} stroke={2} /> Pause
          </button>
        )}
        {detail.state === 'paused' && (
          <button onClick={() => { void onAct(() => resumeLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
            <IconPlayerPlay size={13} stroke={2} /> Resume
          </button>
        )}
        {detail.state !== 'done' && (
          <button onClick={() => { void onAct(() => cancelLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-error-8 px-2 py-1 text-meta text-error-3 hover:bg-error-10/40 transition-colors">
            <IconSquare size={13} stroke={2} /> Stop
          </button>
        )}
        {detail.makerSessionId != null && onNavigateToSession && (
          <button
            onClick={() => { if (detail.makerSessionId != null) onNavigateToSession(detail.makerSessionId) }}
            className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink-muted hover:bg-surface-raised transition-colors"
          >
            <IconExternalLink size={13} stroke={2} /> Open session
          </button>
        )}
        {detail.prUrl && (
          <a href={detail.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-primary-4 hover:text-primary-3 transition-colors">
            PR <IconExternalLink size={13} stroke={2} />
          </a>
        )}
      </div>

      {/* Steer */}
      {detail.state !== 'done' && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const text = steerText.trim()
            if (!text) return
            setSteerText('')
            void onAct(() => steerLoopRun(token, detail.id, text))
          }}
        >
          <input
            value={steerText}
            onChange={(e) => { setSteerText(e.target.value) }}
            placeholder="Steer the run — delivered at the next safe boundary"
            className="flex-1 rounded-control border border-edge bg-surface px-2 py-1 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
          />
          <button type="submit" className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
            <IconMessageForward size={13} stroke={2} /> Send
          </button>
        </form>
      )}

      {/* Intervention cards */}
      {pending.map((iv) => (
        <div key={iv.id} className="rounded-control border border-warning-9/60 bg-warning-10/40 p-3">
          <p className="text-body font-medium text-warning-1">{iv.title}</p>
          {iv.body && <p className="mt-1 text-meta text-warning-2">{iv.body}</p>}
          <input
            value={noteById[iv.id] ?? ''}
            onChange={(e) => { setNoteById((m) => ({ ...m, [iv.id]: e.target.value })) }}
            placeholder="Optional note / guidance"
            className="mt-2 w-full rounded-control border border-edge bg-surface px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            {iv.options.map((option) => (
              <button
                key={option}
                onClick={() => { void onAct(() => resolveLoopIntervention(token, detail.id, iv.id, option, (noteById[iv.id] ?? '').trim() || undefined)) }}
                className="rounded-control border border-edge px-2.5 py-1 text-meta font-medium text-ink hover:bg-surface-raised transition-colors"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Facts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Meta label="Branch" value={detail.branch} />
        <Meta label="Provider" value={detail.model ? `${detail.provider} (${detail.model})` : detail.provider} />
        <Meta label="Turns" value={String(detail.turnCount)} />
        <Meta label="Cost" value={`$${detail.costUsd.toFixed(2)}`} />
      </div>

      {/* Evaluations scorecard */}
      {detail.evaluations.length > 0 && (
        <div>
          <h3 className="mb-1 text-meta font-medium text-ink-muted">Evaluations</h3>
          <ul className="divide-y divide-edge rounded-control border border-edge">
            {detail.evaluations.slice(-12).map((ev) => (
              <li key={ev.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span
                  className={`inline-flex w-14 flex-shrink-0 justify-center rounded-control px-1 py-0.5 text-micro font-medium ${
                    ev.status === 'pass' ? 'bg-success-7 text-success-2' : ev.status === 'error' ? 'bg-warning-8 text-warning-2' : 'bg-error-8 text-error-2'
                  }`}
                >
                  {ev.status}
                </span>
                <span className="truncate text-meta text-ink">{ev.summary}</span>
                <span className="ml-auto flex-shrink-0 text-micro text-ink-faint">{formatTime(ev.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Stage history */}
      {detail.stages.length > 0 && (
        <div>
          <h3 className="mb-1 text-meta font-medium text-ink-muted">Stages</h3>
          <ol className="flex flex-wrap gap-1.5">
            {detail.stages.map((stage) => (
              <li
                key={stage.id}
                className={`rounded-control border px-2 py-0.5 text-micro ${
                  stage.status === 'succeeded'
                    ? 'border-success-8 text-success-3'
                    : stage.status === 'failed'
                      ? 'border-error-8 text-error-3'
                      : stage.status === 'running'
                        ? 'border-accent-8 text-accent-3'
                        : 'border-edge text-ink-muted'
                }`}
              >
                {stage.stageIndex}. {stage.kind}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function StartLoopModal({ token, onClose, onStarted }: { token: string; onClose: () => void; onStarted: (run: LoopRun) => void }) {
  const [recipes, setRecipes] = useState<LoopRecipeInfo[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listLoopRecipes(token, repo.trim() || undefined)
      .then((list) => {
        setRecipes(list)
        setRecipeId((current) => current || (list[0]?.id ?? ''))
      })
      .catch(() => {})
  }, [token, repo])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating"
        onClick={(e) => { e.stopPropagation() }}
      >
        <h2 className="text-title text-ink">Start a loop run</h2>
        <form
          className="mt-3 flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!recipeId || !repo.trim()) { setError('Recipe and repo are required.'); return }
            setBusy(true)
            startLoopRun(token, {
              recipeId,
              repo: repo.trim(),
              branch: branch.trim() || undefined,
              goal: goal.trim() || undefined,
            })
              .then(onStarted)
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : 'Failed to start run')
                setBusy(false)
              })
          }}
        >
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            Recipe
            <select
              value={recipeId}
              onChange={(e) => { setRecipeId(e.target.value) }}
              className="rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink focus:border-focus focus:outline-none"
            >
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.source === 'repo' ? ' (repo)' : ''}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            Repository path
            <input
              value={repo}
              onChange={(e) => { setRepo(e.target.value) }}
              placeholder="/srv/repos/my-project"
              className="rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            Branch (optional — generated when empty)
            <input
              value={branch}
              onChange={(e) => { setBranch(e.target.value) }}
              placeholder="loop/ci-fix"
              className="rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            Outcome override (optional)
            <textarea
              value={goal}
              onChange={(e) => { setGoal(e.target.value) }}
              rows={3}
              placeholder="Defaults to the recipe's outcome prompt"
              className="rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
          </label>
          {error && <p className="text-meta text-error-4">{error}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-control px-3 py-1.5 text-body text-ink-muted hover:bg-surface transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-control bg-accent-9/40 px-3 py-1.5 text-body font-medium text-accent-2 hover:bg-accent-9/60 disabled:opacity-50 transition-colors"
            >
              {busy ? 'Starting…' : 'Start in isolated worktree'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
