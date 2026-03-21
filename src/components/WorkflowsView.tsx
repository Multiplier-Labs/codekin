/**
 * Workflows page — unified card-based layout with inline run history.
 *
 * Each configured workflow gets a card showing identity, schedule, health,
 * and expandable recent runs. A "Recent Activity" feed at the bottom shows
 * the latest runs across all workflows.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  IconPlus, IconChevronDown,
  IconCalendarEvent, IconArrowRight,
} from '@tabler/icons-react'
import { useWorkflows } from '../hooks/useWorkflows'
import { getRun } from '../lib/workflowApi'
import type { WorkflowRun, WorkflowRunWithSteps, CronSchedule, ReviewRepoConfig } from '../lib/workflowApi'
import { AddWorkflowModal } from './AddWorkflowModal'
import { EditWorkflowModal } from './EditWorkflowModal'
import { RepoGroup } from './workflows/RepoGroup'
import { ActivityRow } from './workflows/ActivityRow'
import { CustomWorkflowGuide } from './workflows/CustomWorkflowGuide'

// ---------------------------------------------------------------------------
// WorkflowsView
// ---------------------------------------------------------------------------

interface Props {
  /** Auth token for REST API calls to the workflow/schedule endpoints. */
  token: string
  /** Navigate the main app to a session (e.g. when the user clicks a run's linked session). */
  onNavigateToSession?: (sessionId: string) => void
}

/** Workflows management page — shows configured workflows grouped by repo, with inline run history and activity feed. */
export function WorkflowsView({ token, onNavigateToSession }: Props) {
  const { runs, schedules, config, error, cancelRun, triggerSchedule, addRepo, removeRepo, updateRepo, toggleScheduleEnabled } = useWorkflows(token)

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runDetail, setRunDetail] = useState<WorkflowRunWithSteps | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRepo, setEditingRepo] = useState<ReviewRepoConfig | null>(null)
  const [showActivity, setShowActivity] = useState(false)

  const detailLoading = selectedRunId !== null && (runDetail === null || runDetail.id !== selectedRunId)

  // Build repo map
  const repoMap = new Map<string, ReviewRepoConfig>()
  if (config) {
    for (const repo of config.reviewRepos) repoMap.set(repo.id, repo)
  }

  // Build schedule map
  const scheduleMap = new Map<string, CronSchedule>()
  for (const s of schedules) scheduleMap.set(s.id, s)

  // Build runs-per-repo map
  const runsPerRepo = new Map<string, WorkflowRun[]>()
  for (const run of runs) {
    const repoPath = run.input.repoPath as string | undefined
    if (!repoPath) continue
    // Find matching repo config
    const matchingRepo = config?.reviewRepos.find(r => r.repoPath === repoPath && r.kind === run.kind)
    if (matchingRepo) {
      const key = matchingRepo.id
      if (!runsPerRepo.has(key)) runsPerRepo.set(key, [])
      runsPerRepo.get(key)!.push(run)
    }
  }

  // Orphan runs (not matching any config)
  const assignedRunIds = new Set<string>()
  for (const arr of runsPerRepo.values()) {
    for (const r of arr) assignedRunIds.add(r.id)
  }

  // Fetch run detail when selection changes
  useEffect(() => {
    if (!selectedRunId) return
    let cancelled = false
    getRun(token, selectedRunId)
      .then(data => { if (!cancelled) setRunDetail(data) })
      .catch(() => { if (!cancelled) setRunDetail(null) })
    return () => { cancelled = true }
  }, [selectedRunId, token])

  // Re-fetch detail when runs list updates (active run progressing)
  useEffect(() => {
    if (!selectedRunId || !runDetail) return
    if (runDetail.status === 'running' || runDetail.status === 'queued') {
      getRun(token, selectedRunId).then(setRunDetail).catch(() => {})
    }
  }, [runs]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleRun = useCallback((runId: string) => {
    setSelectedRunId(prev => prev === runId ? null : runId)
  }, [])

  const handleDeleteSchedule = useCallback(async (id: string) => {
    try {
      await removeRepo(id)
    } catch {
      // error surfaced via hook
    }
  }, [removeRepo])

  const handleToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    try {
      await toggleScheduleEnabled(id, enabled)
    } catch {
      // error surfaced via hook
    }
  }, [toggleScheduleEnabled])

  const repos = config?.reviewRepos ?? []

  // Group workflows by repoPath
  const repoGroups = new Map<string, ReviewRepoConfig[]>()
  for (const repo of repos) {
    if (!repoGroups.has(repo.repoPath)) repoGroups.set(repo.repoPath, [])
    repoGroups.get(repo.repoPath)!.push(repo)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-8/50 px-5 py-3">
        <h1 className="text-[18px] font-medium text-neutral-1">Workflows</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary-8 px-3 py-1.5 text-[15px] font-medium text-neutral-1 hover:bg-primary-7 transition-colors"
          >
            <IconPlus size={14} stroke={2} />
            New Workflow
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Error */}
        {error && (
          <div className="rounded-lg border border-error-8/50 bg-error-10/30 px-4 py-2 text-[16px] text-error-4 mb-4">
            {error}
          </div>
        )}

        {/* Workflow groups by repo */}
        {repos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-8 px-6 py-10 text-center">
            <div className="text-neutral-5 mb-1">
              <IconCalendarEvent size={32} stroke={1.5} className="mx-auto mb-3 text-neutral-6" />
              <div className="text-[16px] text-neutral-3 font-medium mb-1">No workflows configured</div>
              <div className="text-[14px] text-neutral-5">
                Set up automated code reviews, security audits, and more.
              </div>
            </div>
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary-8 px-4 py-2 text-[15px] font-medium text-neutral-1 hover:bg-primary-7 transition-colors"
            >
              <IconPlus size={14} stroke={2} />
              Create your first workflow
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {Array.from(repoGroups.entries()).map(([repoPath, workflows]) => (
              <RepoGroup
                key={repoPath}
                repoPath={repoPath}
                workflows={workflows}
                scheduleMap={scheduleMap}
                runsPerRepo={runsPerRepo}
                selectedRunId={selectedRunId}
                runDetail={runDetail}
                detailLoading={detailLoading}
                onTrigger={triggerSchedule}
                onToggleEnabled={handleToggleEnabled}
                onEdit={setEditingRepo}
                onDelete={handleDeleteSchedule}
                onToggleRun={handleToggleRun}
                onCancel={cancelRun}
                onNavigateToSession={onNavigateToSession}
              />
            ))}
          </div>
        )}

        {/* Recent Activity */}
        {runs.length > 0 && (
          <div className="mt-6">
            <button
              onClick={() => setShowActivity(!showActivity)}
              className="flex items-center gap-2 text-[15px] font-medium text-neutral-3 hover:text-neutral-1 transition-colors mb-2"
            >
              {showActivity
                ? <IconChevronDown size={14} stroke={2} />
                : <IconArrowRight size={14} stroke={2} />
              }
              Recent Activity
              <span className="text-[13px] text-neutral-5 font-normal">({runs.length} runs)</span>
            </button>

            {showActivity && (
              <div className="workflow-card rounded-lg border border-neutral-9/60 bg-neutral-10/30 py-1 divide-y divide-neutral-9/30">
                {runs.slice(0, 20).map(run => (
                  <ActivityRow
                    key={run.id}
                    run={run}
                    onNavigateToSession={onNavigateToSession}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Custom workflow guide */}
        <CustomWorkflowGuide />
      </div>

      {/* Add Workflow Modal */}
      {showAddForm && (
        <AddWorkflowModal
          token={token}
          onClose={() => setShowAddForm(false)}
          onAdd={addRepo}
        />
      )}

      {/* Edit Workflow Modal */}
      {editingRepo && (
        <EditWorkflowModal
          repo={editingRepo}
          schedules={schedules.filter(s => s.id === editingRepo.id)}
          recentRuns={runs.filter(r =>
            (r.input.repoPath as string | undefined) === editingRepo.repoPath ||
            (r.input.repoName as string | undefined) === editingRepo.name
          )}
          onClose={() => setEditingRepo(null)}
          onSave={updateRepo}
        />
      )}
    </div>
  )
}
