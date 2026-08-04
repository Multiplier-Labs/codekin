/**
 * RepoGroup — groups workflows under a single repo header card.
 */

import type { WorkflowRun, WorkflowRunWithSteps, CronSchedule, ReviewRepoConfig } from '../../lib/workflowApi'
import { WorkflowRow } from './WorkflowRow'

// ---------------------------------------------------------------------------
// RepoGroup
// ---------------------------------------------------------------------------

export function RepoGroup({
  repoPath,
  workflows,
  scheduleMap,
  runsPerRepo,
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
  repoPath: string
  workflows: ReviewRepoConfig[]
  scheduleMap: Map<string, CronSchedule>
  runsPerRepo: Map<string, WorkflowRun[]>
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
  const repoName = repoPath.split('/').pop() || repoPath

  return (
    <div className="workflow-card rounded-lg border border-edge bg-surface overflow-hidden">
      {/* Repo header */}
      <div className="flex items-baseline gap-2 px-4 py-2.5 border-b border-edge bg-surface-raised/20">
        <span className="text-body font-semibold text-ink">{repoName}</span>
        <span className="text-meta text-ink-faint">{workflows.length}</span>
      </div>
      {/* Workflow rows */}
      <div className="py-1 px-1">
        {workflows.map(repo => (
          <WorkflowRow
            key={repo.id}
            repo={repo}
            schedule={scheduleMap.get(repo.id)}
            recentRuns={runsPerRepo.get(repo.id) ?? []}
            selectedRunId={selectedRunId}
            runDetail={runDetail}
            detailLoading={detailLoading}
            onTrigger={onTrigger}
            onToggleEnabled={onToggleEnabled}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleRun={onToggleRun}
            onCancel={onCancel}
            onNavigateToSession={onNavigateToSession}
          />
        ))}
      </div>
    </div>
  )
}
