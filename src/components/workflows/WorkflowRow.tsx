/**
 * WorkflowRow — compact row for a single workflow within a repo group.
 *
 * Renders a workflow's kind label, schedule, model badge, last-run status, and
 * a clickable run-history strip. Action buttons (run, pause/resume, edit, delete)
 * appear on hover. Expanding the run-history strip shows MiniRunRow details.
 *
 * Event-driven workflows (e.g. commit-review) hide the run/pause controls since
 * they are triggered by hooks rather than cron schedules.
 */

import { useState } from 'react'
import {
  IconPlayerPlay, IconPlayerPause,
  IconPencil, IconTrash,
} from '@tabler/icons-react'
import type { WorkflowRun, WorkflowRunWithSteps, CronSchedule, ReviewRepoConfig } from '../../lib/workflowApi'
import { kindLabel, describeCron, modelLabel, isEventDriven, formatTime } from '../../lib/workflowHelpers'
import { StatusBadge } from '../WorkflowBadges'
import { HealthDot } from './HealthDot'
import { MiniRunRow } from './MiniRunRow'

// ---------------------------------------------------------------------------
// WorkflowRow
// ---------------------------------------------------------------------------

export function WorkflowRow({
  repo,
  schedule,
  recentRuns,
  selectedRunId,
  runDetail,
  detailLoading,
  onTrigger,
  onToggleEnabled,
  onEdit,
  onDelete,
  onToggleRun,
  onCancel,
  onNavigateToSession,
}: {
  repo: ReviewRepoConfig
  schedule?: CronSchedule
  recentRuns: WorkflowRun[]
  selectedRunId: string | null
  runDetail: WorkflowRunWithSteps | null
  detailLoading: boolean
  onTrigger: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onEdit: (repo: ReviewRepoConfig) => void
  onDelete: (id: string) => void
  onToggleRun: (runId: string) => void
  onCancel: (runId: string) => void
  onNavigateToSession?: (sessionId: string) => void
}) {
  const [showRuns, setShowRuns] = useState(false)
  const eventDriven = isEventDriven(repo.kind ?? '')
  const paused = schedule ? !schedule.enabled : false
  const lastRun = recentRuns[0]
  // A hold is only worth showing while it's the latest trigger decision —
  // once a newer run exists, the run's own status badge tells the story.
  const held = schedule?.lastHeldAt && schedule.lastHeldReason
    && (!lastRun || schedule.lastHeldAt > lastRun.createdAt)
    ? { at: schedule.lastHeldAt, reason: schedule.lastHeldReason }
    : null

  return (
    <div>
      <div className={`group flex items-center gap-3 px-3 py-2 rounded-control transition-colors hover:bg-surface-raised ${paused && !eventDriven ? 'opacity-60' : ''}`}>
        <HealthDot status={lastRun?.status} />
        <span className={`text-body font-medium min-w-0 truncate ${paused && !eventDriven ? 'text-ink-muted' : 'text-ink'}`}>
          {kindLabel(repo.kind ?? '')}
        </span>
        {paused && !eventDriven && (
          <span className="text-meta text-warning-5 shrink-0">paused</span>
        )}
        <span className={`text-body whitespace-nowrap shrink-0 ${eventDriven ? 'text-secondary-4' : 'text-ink-muted'}`}>
          {eventDriven
            ? (repo.kind === 'pr-review' ? 'On pull request' : 'On commit')
            : schedule ? describeCron(schedule.cronExpression) : describeCron(repo.cronExpression)}
        </span>
        {modelLabel(repo.model) && (
          <span className="text-meta text-ink-muted bg-edge rounded-control px-1.5 py-0.5 shrink-0">
            {modelLabel(repo.model)}
          </span>
        )}
        {held && (
          <span
            className="text-meta text-ink-faint min-w-0 truncate"
            title={`Held ${formatTime(held.at)}: ${held.reason}`}
          >
            held: {held.reason}
          </span>
        )}
        {lastRun && (
          <>
            <StatusBadge status={lastRun.status} />
            <span className="text-meta text-ink-muted tabular-nums whitespace-nowrap shrink-0">
              {formatTime(lastRun.createdAt)}
            </span>
          </>
        )}
        {/* Run history dots */}
        {recentRuns.length > 0 && (
          <button
            onClick={() => setShowRuns(!showRuns)}
            className="flex items-center gap-0.5 shrink-0 rounded-control px-1 py-0.5 hover:bg-edge transition-colors"
            title={`${recentRuns.length} recent runs`}
          >
            {recentRuns.slice(0, 5).map(r => (
              <HealthDot key={r.id} status={r.status} />
            ))}
          </button>
        )}
        {/* Actions — visible on hover */}
        <div className="flex items-center gap-0.5 shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          {!eventDriven && (
            <button
              onClick={() => onTrigger(repo.id)}
              className="rounded-control p-1 text-ink-muted hover:text-accent-3 hover:bg-edge transition-colors"
              title="Run now"
            >
              <IconPlayerPlay size={14} stroke={2} />
            </button>
          )}
          {!eventDriven && (
            <button
              onClick={() => onToggleEnabled(repo.id, !schedule?.enabled)}
              className={`rounded-control p-1 transition-colors ${
                paused
                  ? 'text-success-5 hover:text-success-3 hover:bg-edge'
                  : 'text-ink-muted hover:text-warning-4 hover:bg-edge'
              }`}
              title={paused ? 'Resume' : 'Pause'}
            >
              {paused ? <IconPlayerPlay size={14} stroke={2} /> : <IconPlayerPause size={14} stroke={2} />}
            </button>
          )}
          <button
            onClick={() => onEdit(repo)}
            className="rounded-control p-1 text-ink-muted hover:text-ink hover:bg-edge transition-colors"
            title="Edit"
          >
            <IconPencil size={14} stroke={2} />
          </button>
          <button
            onClick={() => onDelete(repo.id)}
            className="rounded-control p-1 text-ink-faint hover:text-error-4 hover:bg-edge transition-colors"
            title="Delete"
          >
            <IconTrash size={14} stroke={2} />
          </button>
        </div>
      </div>

      {/* Expandable run history */}
      {showRuns && recentRuns.length > 0 && (
        <div className="ml-6 border-l border-edge pl-2 pb-1">
          {recentRuns.map(run => (
            <MiniRunRow
              key={run.id}
              run={run}
              selected={selectedRunId === run.id}
              detail={selectedRunId === run.id ? runDetail : null}
              detailLoading={selectedRunId === run.id ? detailLoading : false}
              onToggle={() => onToggleRun(run.id)}
              onCancel={onCancel}
              onNavigateToSession={onNavigateToSession}
            />
          ))}
        </div>
      )}
    </div>
  )
}
