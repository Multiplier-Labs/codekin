/**
 * Loop Runs page — the UI for Goal Runs (durable act→verify→continue loops).
 *
 * Left: a list of runs with status. Right: the selected run's detail plus its
 * evidence ledger (one row per maker/verifier/checker turn). A "Start Loop"
 * form launches a new run from a loop template against a repo + branch.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-react'
import {
  listGoalRuns,
  getGoalRun,
  listLoopTemplates,
  startGoalRun,
  abortGoalRun,
  type GoalRun,
  type GoalRunStatus,
  type GoalRunWithTurns,
  type GoalRunTurn,
  type LoopTemplateInfo,
} from '../lib/goalRunApi'
import { formatTime } from '../lib/workflowHelpers'

const TERMINAL: ReadonlySet<GoalRunStatus> = new Set(['succeeded', 'failed', 'aborted', 'awaiting_human'])

function isActive(status: GoalRunStatus): boolean {
  return !TERMINAL.has(status)
}

/** Tailwind classes for a goal-run status badge. */
function statusBadge(status: GoalRunStatus): string {
  switch (status) {
    case 'succeeded': return 'bg-success-7 text-success-2'
    case 'failed': return 'bg-error-8 text-error-2'
    case 'aborted': return 'bg-warning-8 text-warning-2'
    case 'awaiting_human': return 'bg-warning-7 text-warning-1'
    case 'running': return 'bg-accent-8 text-accent-2 animate-pulse'
    case 'verifying': return 'bg-accent-8 text-accent-2 animate-pulse'
    case 'checking': return 'bg-primary-8 text-primary-2 animate-pulse'
    case 'queued': return 'bg-neutral-8 text-neutral-3'
    default: return 'bg-neutral-8 text-neutral-3'
  }
}

function roleBadge(role: GoalRunTurn['role']): string {
  switch (role) {
    case 'maker': return 'bg-accent-9/40 text-accent-2'
    case 'checker': return 'bg-primary-9/40 text-primary-2'
    case 'verifier': return 'bg-neutral-8 text-neutral-3'
    default: return 'bg-neutral-8 text-neutral-3'
  }
}

interface Props {
  /** Auth token for REST API calls. */
  token: string
  /** Navigate the main app to a session (e.g. the run's maker session). */
  onNavigateToSession?: (sessionId: string) => void
}

/** Loop Runs management page — list of goal runs, per-run evidence ledger, and a start form. */
export function LoopRunsView({ token, onNavigateToSession }: Props) {
  const [runs, setRuns] = useState<GoalRun[]>([])
  const [templates, setTemplates] = useState<LoopTemplateInfo[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GoalRunWithTurns | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await listGoalRuns(token, { limit: 100 }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs')
    }
  }, [token])

  // Initial load: runs + templates.
  useEffect(() => {
    let cancelled = false
    listGoalRuns(token, { limit: 100 })
      .then((r) => { if (!cancelled) setRuns(r) })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load runs') })
    listLoopTemplates(token)
      .then((t) => { if (!cancelled) setTemplates(t) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // Poll the runs list while any run is still active.
  useEffect(() => {
    if (!runs.some((r) => isActive(r.status))) return
    const id = setInterval(() => { void refreshRuns() }, 4000)
    return () => { clearInterval(id) }
  }, [runs, refreshRuns])

  // Fetch detail on selection (a stale detail is hidden by the id guard at render).
  useEffect(() => {
    if (!selectedRunId) return
    let cancelled = false
    getGoalRun(token, selectedRunId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [selectedRunId, token])

  // Poll detail while the selected run is active.
  useEffect(() => {
    if (!selectedRunId || !detail || !isActive(detail.status)) return
    const id = setInterval(() => {
      getGoalRun(token, selectedRunId).then(setDetail).catch(() => {})
    }, 3000)
    return () => { clearInterval(id) }
  }, [selectedRunId, detail, token])

  const handleAbort = useCallback(async (runId: string) => {
    try {
      await abortGoalRun(token, runId)
      await refreshRuns()
      if (selectedRunId === runId) {
        getGoalRun(token, runId).then(setDetail).catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to abort run')
    }
  }, [token, refreshRuns, selectedRunId])

  const handleStarted = useCallback((run: GoalRun) => {
    setShowForm(false)
    setSelectedRunId(run.id)
    void refreshRuns()
  }, [refreshRuns])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-8/50 px-5 py-3">
        <h1 className="text-[18px] font-medium text-neutral-1">Loop Runs</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { void refreshRuns() }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[15px] text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6 transition-colors"
            title="Refresh"
          >
            <IconRefresh size={14} stroke={2} />
          </button>
          <button
            onClick={() => { setShowForm(true) }}
            className="flex items-center gap-1.5 rounded-md bg-primary-8 px-3 py-1.5 text-[15px] font-medium text-on-primary hover:bg-primary-7 transition-colors"
          >
            <IconPlayerPlay size={14} stroke={2} />
            Start Loop
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-error-9/50 bg-error-10/40 px-4 py-2 text-[15px] text-error-4">
          {error}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Runs list */}
        <div className="w-80 flex-shrink-0 overflow-y-auto border-r border-neutral-8/50">
          {runs.length === 0 ? (
            <div className="px-4 py-10 text-center text-[15px] text-neutral-5">
              No loop runs yet.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-9/40">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    onClick={() => { setSelectedRunId((p) => (p === run.id ? null : run.id)) }}
                    className={`w-full px-4 py-2.5 text-left transition-colors ${
                      selectedRunId === run.id ? 'bg-neutral-9/60' : 'hover:bg-neutral-9/30'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[15px] font-medium text-neutral-2">{run.kind}</span>
                      <span className={`inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[12px] font-medium ${statusBadge(run.status)}`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[13px] text-neutral-5">
                      <span className="truncate">{run.branch}</span>
                      <span className="flex-shrink-0">{formatTime(run.createdAt)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto">
          {!selectedRunId ? (
            <div className="flex h-full items-center justify-center text-[15px] text-neutral-5">
              Select a run to see its evidence ledger.
            </div>
          ) : !detail || detail.id !== selectedRunId ? (
            <div className="px-5 py-6 text-[15px] text-neutral-5">Loading…</div>
          ) : (
            <RunDetail
              run={detail}
              onAbort={(id) => { void handleAbort(id) }}
              onNavigateToSession={onNavigateToSession}
            />
          )}
        </div>
      </div>

      {showForm && (
        <StartLoopModal
          token={token}
          templates={templates}
          onClose={() => { setShowForm(false) }}
          onStarted={handleStarted}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run detail + evidence ledger
// ---------------------------------------------------------------------------

function RunDetail({
  run,
  onAbort,
  onNavigateToSession,
}: {
  run: GoalRunWithTurns
  onAbort: (runId: string) => void
  onNavigateToSession?: (sessionId: string) => void
}) {
  const { makerSessionId } = run
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-medium text-neutral-1">{run.kind}</h2>
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ${statusBadge(run.status)}`}>
              {run.status}
            </span>
          </div>
          <p className="mt-1 text-[14px] text-neutral-4">{run.goal}</p>
        </div>
        {isActive(run.status) && (
          <button
            onClick={() => { onAbort(run.id) }}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-error-8/50 px-2.5 py-1 text-[14px] text-error-3 hover:bg-error-10/40 transition-colors"
          >
            <IconX size={13} stroke={2} />
            Abort
          </button>
        )}
      </div>

      {/* Meta */}
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[14px] sm:grid-cols-3">
        <Meta label="Branch" value={run.branch} />
        <Meta label="Turns" value={`${run.turnCount} / ${run.spec.maxTurns}`} />
        <Meta label="Cost" value={`$${run.costUsd.toFixed(2)} / $${run.spec.maxCostUsd.toFixed(2)}`} />
        <Meta label="Maker" value={run.spec.maker.provider} />
        <Meta label="Checker" value={run.spec.checker?.provider ?? 'none'} />
        <Meta label="Policy" value={run.spec.completionPolicy} />
      </div>

      {makerSessionId && onNavigateToSession && (
        <button
          onClick={() => { onNavigateToSession(makerSessionId) }}
          className="mt-3 text-[14px] text-accent-3 hover:text-accent-2 hover:underline"
        >
          Open maker session →
        </button>
      )}

      {/* Evidence ledger */}
      <h3 className="mt-5 mb-2 text-[14px] font-medium uppercase tracking-wide text-neutral-5">Evidence Ledger</h3>
      {run.turns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-8 px-4 py-6 text-center text-[14px] text-neutral-5">
          No turns recorded yet.
        </div>
      ) : (
        <ol className="space-y-2">
          {run.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
        </ol>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <span className="text-neutral-5">{label}:</span>
      <span className="truncate text-neutral-2">{value}</span>
    </div>
  )
}

function TurnRow({ turn }: { turn: GoalRunTurn }) {
  return (
    <li className="rounded-lg border border-neutral-9/60 bg-neutral-10/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ${roleBadge(turn.role)}`}>
          {turn.role}
        </span>
        <span className="text-[13px] text-neutral-5">turn {turn.turnIndex}</span>
        {turn.verdict && (
          <span className="text-[13px] text-neutral-3">verdict: {turn.verdict}</span>
        )}
        {turn.exitCode !== null && (
          <span className={`text-[13px] ${turn.exitCode === 0 ? 'text-success-3' : 'text-error-3'}`}>
            exit {turn.exitCode}
          </span>
        )}
        <span className="ml-auto text-[12px] text-neutral-6">{formatTime(turn.createdAt)}</span>
      </div>
      {turn.verifyCmd && (
        <div className="mt-1 font-mono text-[13px] text-neutral-3">$ {turn.verifyCmd}</div>
      )}
      {turn.diffSummary && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] text-neutral-4">{turn.diffSummary}</pre>
      )}
      {turn.outputTail && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] text-neutral-5">{turn.outputTail}</pre>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Start Loop modal
// ---------------------------------------------------------------------------

function StartLoopModal({
  token,
  templates,
  onClose,
  onStarted,
}: {
  token: string
  templates: LoopTemplateInfo[]
  onClose: () => void
  onStarted: (run: GoalRun) => void
}) {
  const initialKind: string = templates[0]?.kind ?? ''
  const [kind, setKind] = useState(initialKind)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    setFormError(null)
    if (!kind || !repo.trim() || !branch.trim()) {
      setFormError('Template, repo, and branch are required.')
      return
    }
    setSubmitting(true)
    try {
      const run = await startGoalRun(token, {
        kind: kind as GoalRun['kind'],
        repo: repo.trim(),
        branch: branch.trim(),
        goal: goal.trim() || undefined,
      })
      onStarted(run)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to start loop')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-neutral-8 bg-neutral-12 p-5 shadow-xl" onClick={(e) => { e.stopPropagation() }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-medium text-neutral-1">Start Loop Run</h2>
          <button onClick={onClose} className="rounded p-1 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-9">
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Template">
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value) }}
              className="w-full rounded-md border border-neutral-8 bg-neutral-11 px-2.5 py-1.5 text-[15px] text-neutral-2 focus:border-primary-7 focus:outline-none"
            >
              {templates.length === 0 && <option value="">No templates available</option>}
              {templates.map((t) => (
                <option key={t.kind} value={t.kind}>{t.name} ({t.source})</option>
              ))}
            </select>
          </Field>

          <Field label="Repo path">
            <input
              value={repo}
              onChange={(e) => { setRepo(e.target.value) }}
              placeholder="/path/to/repo"
              className="w-full rounded-md border border-neutral-8 bg-neutral-11 px-2.5 py-1.5 text-[15px] text-neutral-2 focus:border-primary-7 focus:outline-none"
            />
          </Field>

          <Field label="Branch">
            <input
              value={branch}
              onChange={(e) => { setBranch(e.target.value) }}
              placeholder="fix/ci"
              className="w-full rounded-md border border-neutral-8 bg-neutral-11 px-2.5 py-1.5 text-[15px] text-neutral-2 focus:border-primary-7 focus:outline-none"
            />
          </Field>

          <Field label="Goal override (optional)">
            <textarea
              value={goal}
              onChange={(e) => { setGoal(e.target.value) }}
              rows={3}
              placeholder="Leave blank to use the template's default goal."
              className="w-full resize-y rounded-md border border-neutral-8 bg-neutral-11 px-2.5 py-1.5 text-[15px] text-neutral-2 focus:border-primary-7 focus:outline-none"
            />
          </Field>
        </div>

        {formError && (
          <div className="mt-3 rounded-md border border-error-8/50 bg-error-10/40 px-3 py-2 text-[14px] text-error-4">
            {formError}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[15px] text-neutral-3 hover:text-neutral-1 hover:bg-neutral-9 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { void submit() }}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-md bg-primary-8 px-3 py-1.5 text-[15px] font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors"
          >
            <IconPlayerPlay size={14} stroke={2} />
            {submitting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[14px] text-neutral-4">{label}</span>
      {children}
    </label>
  )
}
