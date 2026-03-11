/**
 * WorkflowRow — compact row for a single workflow within a repo group.
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

  return (
    <div>
      <div className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-neutral-10/50 ${paused && !eventDriven ? 'opacity-60' : ''}`}>
        <HealthDot status={lastRun?.status} />
        <span className={`text-[14px] font-medium min-w-0 truncate ${paused && !eventDriven ? 'text-neutral-5' : 'text-neutral-2'}`}>
          {kindLabel(repo.kind ?? '')}
        </span>
        {paused && !eventDriven && (
          <span className="text-[12px] text-warning-5 shrink-0">paused</span>
        )}
        <span className={`text-[14px] whitespace-nowrap shrink-0 ${eventDriven ? 'text-purple-400' : 'text-neutral-5'}`}>
          {eventDriven
            ? 'On commit'
            : schedule ? describeCron(schedule.cronExpression) : describeCron(repo.cronExpression)}
        </span>
        {modelLabel(repo.model) && (
          <span className="text-[12px] text-neutral-5 bg-neutral-9 rounded px-1.5 py-0.5 shrink-0">
            {modelLabel(repo.model)}
          </span>
        )}
        {lastRun && (
          <>
            <StatusBadge status={lastRun.status} />
            <span className="text-[13px] text-neutral-5 tabular-nums whitespace-nowrap shrink-0">
              {formatTime(lastRun.createdAt)}
            </span>
          </>
        )}
        {/* Run history dots */}
        {recentRuns.length > 0 && (
          <button
            onClick={() => setShowRuns(!showRuns)}
            className="flex items-center gap-0.5 shrink-0 rounded px-1 py-0.5 hover:bg-neutral-9 transition-colors"
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
              className="rounded p-1 text-neutral-5 hover:text-accent-3 hover:bg-neutral-9 transition-colors"
              title="Run now"
            >
              <IconPlayerPlay size={14} stroke={2} />
            </button>
          )}
          {!eventDriven && (
            <button
              onClick={() => onToggleEnabled(repo.id, !schedule?.enabled)}
              className={`rounded p-1 transition-colors ${
                paused
                  ? 'text-success-5 hover:text-success-3 hover:bg-neutral-9'
                  : 'text-neutral-5 hover:text-warning-4 hover:bg-neutral-9'
              }`}
              title={paused ? 'Resume' : 'Pause'}
            >
              {paused ? <IconPlayerPlay size={14} stroke={2} /> : <IconPlayerPause size={14} stroke={2} />}
            </button>
          )}
          <button
            onClick={() => onEdit(repo)}
            className="rounded p-1 text-neutral-5 hover:text-neutral-2 hover:bg-neutral-9 transition-colors"
            title="Edit"
          >
            <IconPencil size={14} stroke={2} />
          </button>
          <button
            onClick={() => onDelete(repo.id)}
            className="rounded p-1 text-neutral-6 hover:text-error-4 hover:bg-neutral-9 transition-colors"
            title="Delete"
          >
            <IconTrash size={14} stroke={2} />
          </button>
        </div>
      </div>

      {/* Expandable run history */}
      {showRuns && recentRuns.length > 0 && (
        <div className="ml-6 border-l border-neutral-8/40 pl-2 pb-1">
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
