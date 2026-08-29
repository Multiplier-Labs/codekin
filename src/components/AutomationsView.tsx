/**
 * Automations — the single home for background runs (Phase 2 of the
 * automation unification).
 *
 * One sidebar entry replaces "AI Workflows" and "Loop Runs"; this view hosts
 * both under a tab strip and adds the piece neither had: a needs-attention
 * banner surfacing loop runs that are `blocked` (a tool call waiting on
 * approval) or `awaiting_human` (escalated). Those are the only run states
 * that stall silently without a human — everything else either progresses or
 * terminates.
 *
 * The tab contents are the existing WorkflowsView / LoopRunsView unchanged;
 * folding the two into one run feed is the next cut, once the unified run
 * schema lands. The banner is push-driven off the shared workflow_event
 * channel with a slow poll as the safety net (same pattern as both views).
 */

import { useState, useEffect, useCallback } from 'react'
import { IconSparkles, IconRefresh, IconAlertTriangle } from '@tabler/icons-react'
import { WorkflowsView } from './WorkflowsView'
import { LoopRunsView } from './LoopRunsView'
import { listGoalRuns, type GoalRun } from '../lib/goalRunApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
import { formatTime } from '../lib/workflowHelpers'

export type AutomationsTab = 'workflows' | 'loops'

interface Props {
  /** Auth token for REST API calls. */
  token: string
  /** Tab to open with (legacy /workflows and /loops deep links). */
  initialTab?: AutomationsTab
  /** Navigate the main app to a session (e.g. a run's maker session). */
  onNavigateToSession?: (sessionId: string) => void
}

const TABS: { id: AutomationsTab; label: string; icon: typeof IconSparkles }[] = [
  { id: 'workflows', label: 'Workflows', icon: IconSparkles },
  { id: 'loops', label: 'Loops', icon: IconRefresh },
]

export function AutomationsView({ token, initialTab, onNavigateToSession }: Props) {
  const [tab, setTab] = useState<AutomationsTab>(initialTab ?? 'workflows')
  const [attention, setAttention] = useState<GoalRun[]>([])
  /** Run to preselect in the Loops tab after an attention-row click. */
  const [focusRunId, setFocusRunId] = useState<string | null>(null)

  const refreshAttention = useCallback(async () => {
    try {
      const [blocked, awaiting] = await Promise.all([
        listGoalRuns(token, { status: 'blocked', limit: 20 }),
        listGoalRuns(token, { status: 'awaiting_human', limit: 20 }),
      ])
      setAttention([...blocked, ...awaiting])
    } catch {
      // The banner is best-effort; the tab views surface their own errors.
    }
  }, [token])

  // Initial load (separate from the poll/subscription effect so no setState
  // runs synchronously inside an effect body).
  useEffect(() => {
    let cancelled = false
    Promise.all([
      listGoalRuns(token, { status: 'blocked', limit: 20 }),
      listGoalRuns(token, { status: 'awaiting_human', limit: 20 }),
    ])
      .then(([blocked, awaiting]) => { if (!cancelled) setAttention([...blocked, ...awaiting]) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    const poll = setInterval(() => { void refreshAttention() }, 60_000)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents((event) => {
      if (event.engine !== 'loop') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refreshAttention() }, 300)
    })
    return () => {
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refreshAttention])

  const openRun = useCallback((runId: string) => {
    setFocusRunId(runId)
    setTab('loops')
  }, [])

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
                  onClick={() => { openRun(run.id) }}
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
        {tab === 'workflows' ? (
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
