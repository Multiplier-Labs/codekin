/**
 * Workflows page — setup, scheduling, and run monitoring with debug detail.
 *
 * Sections:
 *   - Scheduled Workflows: configured repos with cron, Run Now, and delete
 *   - Add Workflow modal: form to register a new repo/workflow
 *   - Run History: timeline of runs; click to expand step-by-step debug detail
 */

import { useState, useEffect, useCallback } from 'react'
import {
  IconRefresh, IconPlus, IconPlayerPlay, IconPlayerStop, IconPlayerPause,
  IconExternalLink, IconTrash, IconChevronDown, IconChevronRight,
  IconCheck, IconX, IconLoader2, IconMinus, IconCircle, IconClock, IconPencil,
} from '@tabler/icons-react'
import { useWorkflows } from '../hooks/useWorkflows'
import { getRun } from '../lib/workflowApi'
import type { WorkflowRun, WorkflowRunWithSteps, WorkflowStep, CronSchedule, ReviewRepoConfig } from '../lib/workflowApi'
import { AddWorkflowModal } from './AddWorkflowModal'
import { EditWorkflowModal } from './EditWorkflowModal'
import { StatusBadge } from './WorkflowBadges'
import { kindLabel, statusBadge, describeCron, formatDuration, formatTime, repoNameFromRun } from '../lib/workflowHelpers'

// ---------------------------------------------------------------------------
// StepIcon
// ---------------------------------------------------------------------------

function StepIcon({ status }: { status: string }) {
  const cls = 'shrink-0'
  switch (status) {
    case 'succeeded': return <IconCheck size={14} stroke={2.5} className={`${cls} text-success-4`} />
    case 'failed':    return <IconX size={14} stroke={2.5} className={`${cls} text-error-4`} />
    case 'running':   return <IconLoader2 size={14} stroke={2} className={`${cls} text-accent-4 animate-spin`} />
    case 'skipped':   return <IconMinus size={14} stroke={2} className={`${cls} text-neutral-6`} />
    default:          return <IconCircle size={14} stroke={2} className={`${cls} text-neutral-6`} />
  }
}

// ---------------------------------------------------------------------------
// JsonBlock — collapsible JSON viewer
// ---------------------------------------------------------------------------

function JsonBlock({ label, data, defaultOpen = false }: {
  label: string
  data: Record<string, unknown> | null
  defaultOpen?: boolean
}) {
  if (!data || Object.keys(data).length === 0) return null
  const json = JSON.stringify(data, null, 2)
  // Truncate very long values (e.g. full review text)
  const display = json.length > 4000 ? json.slice(0, 4000) + '\n… (truncated)' : json

  return (
    <details open={defaultOpen} className="mt-1.5">
      <summary className="cursor-pointer select-none text-[13px] text-neutral-5 hover:text-neutral-3 list-none flex items-center gap-1">
        <IconChevronRight size={12} stroke={2} className="details-arrow transition-transform" />
        {label}
        <span className="text-neutral-6">({Object.keys(data).length} fields)</span>
      </summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-neutral-12 p-2.5 text-[13px] text-neutral-3 font-mono leading-relaxed max-h-64 overflow-y-auto">
        {display}
      </pre>
    </details>
  )
}

// ---------------------------------------------------------------------------
// StepCard
// ---------------------------------------------------------------------------

function StepCard({ step }: { step: WorkflowStep }) {
  return (
    <div className="rounded-md border border-neutral-8/40 bg-neutral-11/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <StepIcon status={step.status} />
        <span className="font-mono text-[13px] text-neutral-2 font-medium">{step.key}</span>
        <span className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ${statusBadge(step.status)}`}>
          {step.status}
        </span>
        <span className="text-[13px] text-neutral-5 tabular-nums">
          {formatDuration(step.startedAt, step.completedAt)}
        </span>
      </div>

      {step.error && (
        <div className="mt-1.5 rounded bg-error-10/50 px-2 py-1 text-[13px] text-error-4 font-mono">
          {step.error}
        </div>
      )}

      <div className="mt-0.5">
        <JsonBlock label="input" data={step.input} />
        <JsonBlock label="output" data={step.output} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RunDetail — expanded debug panel
// ---------------------------------------------------------------------------

function RunDetail({ run }: { run: WorkflowRunWithSteps }) {
  return (
    <div className="mt-2 space-y-1.5 border-l-2 border-neutral-8/50 pl-3">
      <div className="text-[13px] font-medium text-neutral-5 uppercase tracking-wider mb-2">Steps</div>

      {run.steps.length === 0 ? (
        <div className="text-[13px] text-neutral-5 py-1">No steps recorded yet.</div>
      ) : (
        run.steps.map(step => <StepCard key={step.id} step={step} />)
      )}

      {/* Run-level output (e.g. filePath, sessionId) */}
      {run.output && Object.keys(run.output).length > 0 && (
        <div className="pt-1">
          <JsonBlock label="run output" data={run.output} defaultOpen />
        </div>
      )}

      {run.error && (
        <div className="rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4 font-mono">
          {run.error}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RunTableRow
// ---------------------------------------------------------------------------

function RunTableRow({
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
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer transition-colors ${
          selected ? 'bg-neutral-10' : 'hover:bg-neutral-10/50'
        }`}
      >
        <td className="py-2.5 pl-3 pr-1 text-neutral-5 w-8">
          {selected
            ? <IconChevronDown size={14} stroke={2} />
            : <IconChevronRight size={14} stroke={2} />
          }
        </td>
        <td className="py-2.5 px-3 text-[15px] font-medium text-neutral-1 max-w-[180px] truncate">
          {repoNameFromRun(run)}
        </td>
        <td className="py-2.5 px-3 text-[13px] text-neutral-4 whitespace-nowrap">
          {kindLabel(run.kind)}
        </td>
        <td className="py-2.5 px-3 text-[13px] text-neutral-4 tabular-nums whitespace-nowrap">
          {formatTime(run.createdAt)}
        </td>
        <td className="py-2.5 px-3 text-[13px] text-neutral-4 tabular-nums whitespace-nowrap">
          {formatDuration(run.startedAt, run.completedAt)}
        </td>
        <td className="py-2.5 px-3">
          <StatusBadge status={run.status} />
        </td>
        <td className="py-2.5 pl-1 pr-3 w-14" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1 justify-end">
            {run.status === 'running' && (
              <button
                onClick={() => onCancel(run.id)}
                className="rounded p-1 text-neutral-4 hover:text-error-4 hover:bg-neutral-9 transition-colors"
                title="Cancel"
              >
                <IconPlayerStop size={14} stroke={2} />
              </button>
            )}
            {sessionId && onNavigateToSession && (
              <button
                onClick={() => onNavigateToSession(sessionId)}
                className="rounded p-1 text-neutral-4 hover:text-accent-3 hover:bg-neutral-9 transition-colors"
                title="View Session"
              >
                <IconExternalLink size={14} stroke={2} />
              </button>
            )}
          </div>
        </td>
      </tr>
      {selected && (
        <tr className="bg-neutral-10/30">
          <td colSpan={7} className="px-4 pb-3 pt-1">
            {detailLoading ? (
              <div className="flex items-center gap-2 py-3 text-[13px] text-neutral-5">
                <IconLoader2 size={16} stroke={2} className="animate-spin" />
                Loading steps…
              </div>
            ) : detail ? (
              <RunDetail run={detail} />
            ) : null}
          </td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// ScheduleRow — a single workflow entry within a repo group
// ---------------------------------------------------------------------------

function ScheduleRow({
  schedule,
  repo,
  onTrigger,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  schedule: CronSchedule
  repo?: ReviewRepoConfig
  onTrigger: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onEdit: (repo: ReviewRepoConfig) => void
  onDelete: (id: string) => void
}) {
  const paused = !schedule.enabled
  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors ${
      paused
        ? 'border-neutral-8/40 bg-neutral-11/20 opacity-60'
        : 'border-neutral-8/60 bg-neutral-11/40'
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`shrink-0 text-[13px] font-medium rounded px-2 py-0.5 ${
            paused
              ? 'text-neutral-5 bg-neutral-9/60'
              : 'text-neutral-3 bg-neutral-9'
          }`}>
            {kindLabel(repo?.kind ?? schedule.kind)}
          </span>
          <span className={`text-[13px] font-mono ${paused ? 'text-neutral-5' : 'text-neutral-3'}`}>
            {describeCron(schedule.cronExpression)}
          </span>
          {paused && (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-warning-5 bg-warning-10/40 border border-warning-8/40 rounded-full px-2 py-0.5">
              <IconPlayerPause size={12} stroke={2} />
              paused
            </span>
          )}
        </div>
        {schedule.nextRunAt && !paused && (
          <div className="mt-1 flex items-center gap-1 text-[13px] text-neutral-5">
            <IconClock size={12} stroke={2} />
            Next: {formatTime(schedule.nextRunAt)}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onToggleEnabled(schedule.id, !schedule.enabled)}
          className={`rounded p-1.5 transition-colors ${
            paused
              ? 'text-success-5 hover:text-success-3 hover:bg-neutral-9'
              : 'text-neutral-5 hover:text-warning-4 hover:bg-neutral-9'
          }`}
          title={paused ? 'Resume schedule' : 'Pause schedule'}
        >
          {paused
            ? <IconPlayerPlay size={14} stroke={2} />
            : <IconPlayerPause size={14} stroke={2} />
          }
        </button>
        <button
          onClick={() => onTrigger(schedule.id)}
          className="rounded-md border border-neutral-7 bg-neutral-9 px-2.5 py-1 text-[13px] text-neutral-2 hover:bg-neutral-8 hover:text-neutral-1 transition-colors flex items-center gap-1.5"
          title="Run now"
        >
          <IconPlayerPlay size={12} stroke={2} />
          Run Now
        </button>
        {repo && (
          <button
            onClick={() => onEdit(repo)}
            className="rounded p-1.5 text-neutral-5 hover:text-neutral-2 hover:bg-neutral-9 transition-colors"
            title="Edit workflow"
          >
            <IconPencil size={14} stroke={2} />
          </button>
        )}
        <button
          onClick={() => onDelete(schedule.id)}
          className="rounded p-1.5 text-neutral-6 hover:text-error-4 hover:bg-neutral-9 transition-colors"
          title="Delete"
        >
          <IconTrash size={14} stroke={2} />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkflowsView
// ---------------------------------------------------------------------------

interface Props {
  token: string
  onNavigateToSession?: (sessionId: string) => void
}

export function WorkflowsView({ token, onNavigateToSession }: Props) {
  const { runs, schedules, config, loading, error, refresh, cancelRun, triggerSchedule, addRepo, removeRepo, updateRepo, toggleScheduleEnabled } = useWorkflows(token)

  const [activeTab, setActiveTab] = useState<'schedules' | 'runs'>('schedules')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runDetail, setRunDetail] = useState<WorkflowRunWithSteps | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRepo, setEditingRepo] = useState<ReviewRepoConfig | null>(null)

  // Derived: loading when selected run doesn't match the fetched detail yet
  const detailLoading = selectedRunId !== null && (runDetail === null || runDetail.id !== selectedRunId)

  // Build repo map for schedule cards
  const repoMap = new Map<string, ReviewRepoConfig>()
  if (config) {
    for (const repo of config.reviewRepos) repoMap.set(repo.id, repo)
  }

  // Group schedules by repoPath
  const scheduleGroups: { repoPath: string; repoName: string; items: CronSchedule[] }[] = []
  const groupIndex = new Map<string, number>()
  for (const schedule of schedules) {
    const repo = repoMap.get(schedule.id)
    const key = repo?.repoPath ?? schedule.id
    if (!groupIndex.has(key)) {
      groupIndex.set(key, scheduleGroups.length)
      scheduleGroups.push({ repoPath: key, repoName: repo?.name ?? schedule.id, items: [] })
    }
    scheduleGroups[groupIndex.get(key)!].items.push(schedule)
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-8/50 px-5 py-3">
        <h1 className="text-[17px] font-medium text-neutral-1">AI Workflows</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => refresh()}
            className="rounded-md p-1.5 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-8 transition-colors"
            title="Refresh"
          >
            <IconRefresh size={16} stroke={2} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 rounded-md border border-neutral-7 bg-neutral-9 px-2.5 py-1.5 text-[13px] text-neutral-2 hover:bg-neutral-8 hover:text-neutral-1 transition-colors"
          >
            <IconPlus size={14} stroke={2} />
            Add
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-neutral-8/50 px-5">
        {(['schedules', 'runs'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`mr-4 pb-2.5 pt-2 text-[15px] font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-accent-5 text-accent-3'
                : 'border-transparent text-neutral-4 hover:text-neutral-2'
            }`}
          >
            {tab === 'schedules' ? 'Scheduled' : 'Run History'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Error */}
        {error && (
          <div className="rounded-lg border border-error-8/50 bg-error-10/30 px-4 py-2 text-[15px] text-error-4 mb-4">
            {error}
          </div>
        )}

        {/* Scheduled Workflows — grouped by repo */}
        {activeTab === 'schedules' && (
          <section>
            {scheduleGroups.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-8 px-4 py-6 text-center">
                <div className="text-[15px] text-neutral-4 mb-1">No workflows configured</div>
                <button
                  onClick={() => setShowAddForm(true)}
                  className="text-[13px] text-accent-4 hover:text-accent-3 underline underline-offset-2"
                >
                  Add your first workflow
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {scheduleGroups.map(group => (
                  <div key={group.repoPath} className="rounded-lg border border-neutral-8 bg-neutral-10/50">
                    {/* Repo header */}
                    <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-neutral-8/60">
                      <span className="text-[15px] font-bold text-neutral-1">{group.repoPath.split('/').pop() || group.repoName}</span>
                    </div>
                    {/* Schedule rows */}
                    <div className="p-2 space-y-1.5">
                      {group.items.map(schedule => (
                        <ScheduleRow
                          key={schedule.id}
                          schedule={schedule}
                          repo={repoMap.get(schedule.id)}
                          onTrigger={triggerSchedule}
                          onToggleEnabled={handleToggleEnabled}
                          onEdit={setEditingRepo}
                          onDelete={handleDeleteSchedule}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Run History */}
        {activeTab === 'runs' && (
          <section>
            {runs.length === 0 ? (
              <div className="text-[15px] text-neutral-5 py-2">
                {loading ? 'Loading…' : 'No workflow runs yet.'}
              </div>
            ) : (
              <div className="rounded-lg border border-neutral-8 overflow-hidden">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-8/60 bg-neutral-11/80">
                      <th className="w-8 py-2.5 pl-3 pr-1" />
                      <th className="py-2.5 px-3 text-left text-[13px] font-medium text-neutral-4 uppercase tracking-wider">Repo</th>
                      <th className="py-2.5 px-3 text-left text-[13px] font-medium text-neutral-4 uppercase tracking-wider">Kind</th>
                      <th className="py-2.5 px-3 text-left text-[13px] font-medium text-neutral-4 uppercase tracking-wider">Started</th>
                      <th className="py-2.5 px-3 text-left text-[13px] font-medium text-neutral-4 uppercase tracking-wider">Duration</th>
                      <th className="py-2.5 px-3 text-left text-[13px] font-medium text-neutral-4 uppercase tracking-wider">Status</th>
                      <th className="w-14 py-2.5 pl-1 pr-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-8/40">
                    {runs.map(run => (
                      <RunTableRow
                        key={run.id}
                        run={run}
                        selected={selectedRunId === run.id}
                        detail={selectedRunId === run.id ? runDetail : null}
                        detailLoading={selectedRunId === run.id ? detailLoading : false}
                        onToggle={() => handleToggleRun(run.id)}
                        onCancel={cancelRun}
                        onNavigateToSession={onNavigateToSession}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {/* Add Workflow Modal */}
      {showAddForm && (
        <AddWorkflowModal
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
