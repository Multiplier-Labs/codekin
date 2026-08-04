/**
 * ActivityRow — compact run entry for the activity feed.
 */

import { IconExternalLink } from '@tabler/icons-react'
import type { WorkflowRun } from '../../lib/workflowApi'
import { kindLabel, formatDuration, formatTime, repoNameFromRun } from '../../lib/workflowHelpers'
import { StatusBadge } from '../WorkflowBadges'
import { HealthDot } from './HealthDot'

// ---------------------------------------------------------------------------
// ActivityRow
// ---------------------------------------------------------------------------

export function ActivityRow({
  run,
  onNavigateToSession,
}: {
  run: WorkflowRun
  onNavigateToSession?: (sessionId: string) => void
}) {
  const sessionId = (run.output?.sessionId || run.input?.sessionId) as string | undefined

  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-surface-raised transition-colors rounded-control">
      <HealthDot status={run.status} />
      <span className="text-body font-medium text-ink min-w-0 truncate max-w-[140px]">
        {repoNameFromRun(run)}
      </span>
      <span className="text-body text-ink-muted">
        {kindLabel(run.kind)}
      </span>
      <span className="text-body text-ink-muted tabular-nums ml-auto whitespace-nowrap">
        {formatTime(run.createdAt)}
      </span>
      <span className="text-body text-ink-muted tabular-nums whitespace-nowrap">
        {formatDuration(run.startedAt, run.completedAt)}
      </span>
      <StatusBadge status={run.status} />
      {sessionId && onNavigateToSession && (
        <button
          onClick={() => onNavigateToSession(sessionId)}
          className="rounded-control p-1 text-ink-muted hover:text-accent-3 hover:bg-edge transition-colors shrink-0"
          title="View session"
        >
          <IconExternalLink size={13} stroke={2} />
        </button>
      )}
    </div>
  )
}
