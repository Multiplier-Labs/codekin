/**
 * MiniRunRow — compact run entry for a workflow card's recent runs list.
 */

import {
  IconChevronDown, IconChevronRight, IconPlayerStop,
  IconExternalLink, IconLoader2,
} from '@tabler/icons-react'
import type { WorkflowRun, WorkflowRunWithSteps } from '../../lib/workflowApi'
import { formatDuration, formatTime } from '../../lib/workflowHelpers'
import { StatusBadge } from '../WorkflowBadges'
import { RunDetail } from './RunDetail'

// ---------------------------------------------------------------------------
// MiniRunRow
// ---------------------------------------------------------------------------

export function MiniRunRow({
  run,
  selected,
  detail,
  detailLoading,
  onToggle,
  onCancel,
  onNavigateToSession,
}: {
  run: WorkflowRun
  selected: boolean
  detail: WorkflowRunWithSteps | null
  detailLoading: boolean
  onToggle: () => void
  onCancel: (runId: string) => void
  onNavigateToSession?: (sessionId: string) => void
}) {
  const sessionId = (run.output?.sessionId || run.input?.sessionId) as string | undefined

  return (
    <div>
      <div
        onClick={onToggle}
        className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors rounded-md ${
          selected ? 'bg-neutral-10' : 'hover:bg-neutral-10/50'
        }`}
      >
        <span className="text-neutral-5 w-4 shrink-0">
          {selected
            ? <IconChevronDown size={13} stroke={2} />
            : <IconChevronRight size={13} stroke={2} />
          }
        </span>
        <span className="text-[14px] text-neutral-4 tabular-nums whitespace-nowrap">
          {formatTime(run.createdAt)}
        </span>
        <span className="text-[14px] text-neutral-4 tabular-nums whitespace-nowrap">
          {formatDuration(run.startedAt, run.completedAt)}
        </span>
        <span className="ml-auto">
          <StatusBadge status={run.status} />
        </span>
        <div className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
          {run.status === 'running' && (
            <button
              onClick={() => onCancel(run.id)}
              className="rounded p-1 text-neutral-4 hover:text-error-4 hover:bg-neutral-9 transition-colors"
              title="Cancel"
            >
              <IconPlayerStop size={13} stroke={2} />
            </button>
          )}
          {sessionId && onNavigateToSession && (
            <button
              onClick={() => onNavigateToSession(sessionId)}
              className="rounded p-1 text-neutral-4 hover:text-accent-3 hover:bg-neutral-9 transition-colors"
              title="View session"
            >
              <IconExternalLink size={13} stroke={2} />
            </button>
          )}
        </div>
      </div>
      {selected && (
        <div className="px-3 pb-2">
          {detailLoading ? (
            <div className="flex items-center gap-2 py-3 text-[14px] text-neutral-5">
              <IconLoader2 size={16} stroke={2} className="animate-spin" />
              Loading steps…
            </div>
          ) : detail ? (
            <RunDetail run={detail} />
          ) : null}
        </div>
      )}
    </div>
  )
}
