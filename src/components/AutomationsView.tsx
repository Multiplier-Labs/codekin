/**
 * Automations — the single home for background runs (Phase 2 of the
 * automation unification).
 *
 * One sidebar entry replaces "AI Workflows" and "Loop Runs". Three tabs:
 *
 *   All        — the merged chronological feed over the unified run read
 *                model (GET /api/runs): every workflow and loop run in one
 *                list, one status vocabulary.
 *   Workflows  — the existing WorkflowsView (recipes, schedules, config).
 *   Loops      — the existing LoopRunsView (evidence ledger, start form).
 *
 * Above the tabs, a needs-attention banner surfaces loop runs that are
 * `blocked` (a tool call waiting on approval) or `awaiting_human`
 * (escalated) — the only run states that stall silently without a human.
 *
 * Everything refreshes push-first off the shared workflow_event channel with
 * a slow poll as the safety net.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconSparkles, IconRefresh, IconAlertTriangle, IconListDetails, IconExternalLink, IconRobotFace } from '@tabler/icons-react'
import { WorkflowsView } from './WorkflowsView'
import { LoopRunsView } from './LoopRunsView'
import { listGoalRuns, type GoalRun } from '../lib/goalRunApi'
import { listUnifiedRuns, type UnifiedRun, type UnifiedRunStatus } from '../lib/runsApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
import { formatTime } from '../lib/workflowHelpers'

export type AutomationsTab = 'all' | 'workflows' | 'loops'

interface Props {
  /** Auth token for REST API calls. */
  token: string
  /** Tab to open with (legacy /workflows and /loops deep links). */
  initialTab?: AutomationsTab
  /** Navigate the main app to a session (e.g. a run's maker session). */
  onNavigateToSession?: (sessionId: string) => void
}

const TABS: { id: AutomationsTab; label: string; icon: typeof IconSparkles }[] = [
  { id: 'all', label: 'All runs', icon: IconListDetails },
  { id: 'workflows', label: 'Workflows', icon: IconSparkles },
  { id: 'loops', label: 'Loops', icon: IconRefresh },
]

/** Badge classes for the unified status vocabulary. */
function unifiedStatusBadge(status: UnifiedRunStatus): string {
  switch (status) {
    case 'succeeded': return 'bg-success-7 text-success-2'
    case 'failed': return 'bg-error-8 text-error-2'
    case 'canceled': return 'bg-warning-8 text-warning-2'
    case 'skipped': return 'bg-edge-strong text-ink-muted'
    case 'awaiting_human': return 'bg-warning-7 text-warning-1'
    case 'blocked': return 'bg-warning-7 text-warning-1 animate-pulse'
    case 'checking': return 'bg-primary-8 text-primary-2 animate-pulse'
    case 'running':
    case 'verifying': return 'bg-accent-8 text-accent-2 animate-pulse'
    case 'queued': return 'bg-edge-strong text-ink'
    default: return 'bg-edge-strong text-ink'
  }
}

function repoName(path: string | null): string | null {
  if (!path) return null
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function AutomationsView({ token, initialTab, onNavigateToSession }: Props) {
  const [tab, setTab] = useState<AutomationsTab>(initialTab ?? 'all')
  const [attention, setAttention] = useState<GoalRun[]>([])
  const [feed, setFeed] = useState<UnifiedRun[]>([])
  const [feedError, setFeedError] = useState<string | null>(null)
  /** Run to preselect in the Loops tab after a row click. */
  const [focusRunId, setFocusRunId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [runs, blocked, awaiting] = await Promise.all([
        listUnifiedRuns(token, { limit: 100 }),
        listGoalRuns(token, { status: 'blocked', limit: 20 }),
        listGoalRuns(token, { status: 'awaiting_human', limit: 20 }),
      ])
      setFeed(runs)
      setAttention([...blocked, ...awaiting])
      setFeedError(null)
    } catch (err) {
      setFeedError(err instanceof Error ? err.message : 'Failed to load runs')
    }
  }, [token])

  // Initial load (separate from the poll/subscription effect so no setState
  // runs synchronously inside an effect body).
  useEffect(() => {
    let cancelled = false
    Promise.all([
      listUnifiedRuns(token, { limit: 100 }),
      listGoalRuns(token, { status: 'blocked', limit: 20 }),
      listGoalRuns(token, { status: 'awaiting_human', limit: 20 }),
    ])
      .then(([runs, blocked, awaiting]) => {
        if (cancelled) return
        setFeed(runs)
        setAttention([...blocked, ...awaiting])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // Push-driven: any run event (either engine) refreshes the feed + banner.
  useEffect(() => {
    const poll = setInterval(() => { void refresh() }, 60_000)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refresh() }, 300)
    })
    return () => {
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh])

  const openLoopRun = useCallback((runId: string) => {
    setFocusRunId(runId)
    setTab('loops')
  }, [])

  const openFeedRow = useCallback((run: UnifiedRun) => {
    if (run.engine === 'loop') openLoopRun(run.id)
    else if (run.engine === 'agent') {
      // An orchestrator child — its session IS the detail view.
      if (run.sessionId) onNavigateToSession?.(run.sessionId)
    } else setTab('workflows')
  }, [openLoopRun, onNavigateToSession])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-edge px-3 py-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setTab(id) }}
            className={`flex items-center gap-1.5 rounded-control px-2.5 py-1 text-body transition-colors ${
              tab === id ? 'bg-accent-9/30 text-accent-2' : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
            }`}
          >
            <Icon size={15} stroke={2} />
            {label}
          </button>
        ))}
        {attention.length > 0 && tab !== 'loops' && (
          <span className="ml-auto flex items-center gap-1 text-meta text-warning-3">
            <IconAlertTriangle size={14} stroke={2} />
            {attention.length} waiting on you
          </span>
        )}
      </div>

      {/* Needs-attention banner — runs that cannot progress without a human. */}
      {attention.length > 0 && (
        <div className="border-b border-warning-9/50 bg-warning-10/40 px-4 py-2">
          <ul className="flex flex-col gap-1">
            {attention.map((run) => (
              <li key={run.id}>
                <button
                  onClick={() => { openLoopRun(run.id) }}
                  className="flex w-full items-center gap-2 rounded-control px-1 py-0.5 text-left text-body text-warning-2 hover:bg-warning-9/30 transition-colors"
                >
                  <IconAlertTriangle size={14} stroke={2} className="flex-shrink-0" />
                  <span className="font-medium">{run.kind}</span>
                  <span className="truncate text-ink-muted">{run.branch}</span>
                  <span className="ml-auto flex-shrink-0 text-meta">
                    {run.status === 'blocked' ? 'waiting on approval' : 'needs a decision'} · {formatTime(run.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Active tab */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {tab === 'all' ? (
          <div className="flex-1 overflow-y-auto">
            {feedError && (
              <div className="border-b border-error-9/50 bg-error-10/40 px-4 py-2 text-body text-error-4">{feedError}</div>
            )}
            {feed.length === 0 ? (
              <div className="px-4 py-10 text-center text-body text-ink-muted">
                No runs yet. Set up a workflow or start a loop from the tabs above.
              </div>
            ) : (
              <ul className="divide-y divide-edge">
                {feed.map((run) => (
                  <li key={`${run.engine}:${run.id}`}>
                    <button
                      onClick={() => { openFeedRow(run) }}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-surface-raised"
                    >
                      {run.engine === 'loop'
                        ? <IconRefresh size={15} stroke={2} className="flex-shrink-0 text-ink-faint" />
                        : run.engine === 'agent'
                          ? <IconRobotFace size={15} stroke={2} className="flex-shrink-0 text-ink-faint" />
                          : <IconSparkles size={15} stroke={2} className="flex-shrink-0 text-ink-faint" />}
                      <span className="truncate text-body font-medium text-ink">{run.engine === 'agent' && run.title ? run.title : run.kind}</span>
                      {repoName(run.repo) && <span className="truncate text-meta text-ink-muted">{repoName(run.repo)}</span>}
                      {run.branch && <span className="truncate text-meta text-ink-faint">{run.branch}</span>}
                      <span className="ml-auto flex flex-shrink-0 items-center gap-2">
                        {run.costUsd != null && run.costUsd > 0 && (
                          <span className="text-meta text-ink-muted">${run.costUsd.toFixed(2)}</span>
                        )}
                        {run.prUrl && (
                          <a
                            href={run.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => { e.stopPropagation() }}
                            className="flex items-center gap-0.5 text-meta text-primary-4 hover:text-primary-3"
                          >
                            PR <IconExternalLink size={12} stroke={2} />
                          </a>
                        )}
                        <span className={`inline-flex items-center rounded-control px-1.5 py-0.5 text-meta font-medium ${unifiedStatusBadge(run.status)}`}>
                          {run.status}
                        </span>
                        <span className="text-meta text-ink-faint">{formatTime(run.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : tab === 'workflows' ? (
          <WorkflowsView token={token} onNavigateToSession={onNavigateToSession} />
        ) : (
          <LoopRunsView
            key={focusRunId ?? 'loops'}
            token={token}
            initialSelectedRunId={focusRunId ?? undefined}
            onNavigateToSession={onNavigateToSession}
          />
        )}
      </div>
    </div>
  )
}
