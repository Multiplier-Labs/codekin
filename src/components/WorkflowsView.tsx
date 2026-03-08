/**
 * Workflows page — unified card-based layout with inline run history.
 *
 * Each configured workflow gets a card showing identity, schedule, health,
 * and expandable recent runs. A "Recent Activity" feed at the bottom shows
 * the latest runs across all workflows.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  IconPlus, IconPlayerPlay, IconPlayerStop, IconPlayerPause,
  IconExternalLink, IconTrash, IconChevronDown, IconChevronRight,
  IconCheck, IconX, IconLoader2, IconMinus, IconCircle, IconPencil,
  IconCalendarEvent, IconArrowRight,
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
// MiniRunRow — compact run entry for the card's recent runs
// ---------------------------------------------------------------------------

function MiniRunRow({
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
        <span className="text-[13px] text-neutral-4 tabular-nums whitespace-nowrap">
          {formatTime(run.createdAt)}
        </span>
        <span className="text-[13px] text-neutral-4 tabular-nums whitespace-nowrap">
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
            <div className="flex items-center gap-2 py-3 text-[13px] text-neutral-5">
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

// ---------------------------------------------------------------------------
// HealthIndicator — dot showing last run status
// ---------------------------------------------------------------------------

function HealthDot({ status }: { status: string | undefined }) {
  if (!status) return <span className="w-2.5 h-2.5 rounded-full bg-neutral-7 shrink-0" title="No runs yet" />
  const colors: Record<string, string> = {
    succeeded: 'bg-success-5',
    failed: 'bg-error-5',
    running: 'bg-accent-5 animate-pulse',
    queued: 'bg-neutral-5 animate-pulse',
    canceled: 'bg-warning-5',
    skipped: 'bg-neutral-6',
  }
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[status] || 'bg-neutral-7'}`} title={status} />
}

// ---------------------------------------------------------------------------
// WorkflowRow — compact row for a single workflow within a repo group
// ---------------------------------------------------------------------------

function WorkflowRow({
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
  const paused = schedule ? !schedule.enabled : false
  const lastRun = recentRuns[0]

  return (
    <div>
      <div className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-neutral-10/50 ${paused ? 'opacity-60' : ''}`}>
        <HealthDot status={lastRun?.status} />
        <span className={`text-[13px] font-medium min-w-0 truncate ${paused ? 'text-neutral-5' : 'text-neutral-2'}`}>
          {kindLabel(repo.kind ?? '')}
        </span>
        {paused && (
          <span className="text-[11px] text-warning-5 shrink-0">paused</span>
        )}
        <span className="text-[13px] text-neutral-5 whitespace-nowrap shrink-0">
          {schedule ? describeCron(schedule.cronExpression) : describeCron(repo.cronExpression)}
        </span>
        {lastRun && (
          <>
            <StatusBadge status={lastRun.status} />
            <span className="text-[12px] text-neutral-5 tabular-nums whitespace-nowrap shrink-0">
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
          <button
            onClick={() => onTrigger(repo.id)}
            className="rounded p-1 text-neutral-5 hover:text-accent-3 hover:bg-neutral-9 transition-colors"
            title="Run now"
          >
            <IconPlayerPlay size={14} stroke={2} />
          </button>
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

// ---------------------------------------------------------------------------
// RepoGroup — groups workflows under a single repo header
// ---------------------------------------------------------------------------

function RepoGroup({
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
    <div className="rounded-xl border border-neutral-8/50 bg-neutral-11/30 overflow-hidden">
      {/* Repo header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-neutral-8/30">
        <span className="text-[14px] font-semibold text-neutral-2">{repoName}</span>
        <span className="text-[12px] text-neutral-6">{workflows.length}</span>
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

// ---------------------------------------------------------------------------
// ActivityRow — compact run for the activity feed
// ---------------------------------------------------------------------------

function ActivityRow({
  run,
  onNavigateToSession,
}: {
  run: WorkflowRun
  onNavigateToSession?: (sessionId: string) => void
}) {
  const sessionId = (run.output?.sessionId || run.input?.sessionId) as string | undefined

  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-neutral-10/30 transition-colors rounded-md">
      <HealthDot status={run.status} />
      <span className="text-[14px] font-medium text-neutral-2 min-w-0 truncate max-w-[140px]">
        {repoNameFromRun(run)}
      </span>
      <span className="text-[13px] text-neutral-4">
        {kindLabel(run.kind)}
      </span>
      <span className="text-[13px] text-neutral-5 tabular-nums ml-auto whitespace-nowrap">
        {formatTime(run.createdAt)}
      </span>
      <span className="text-[13px] text-neutral-5 tabular-nums whitespace-nowrap">
        {formatDuration(run.startedAt, run.completedAt)}
      </span>
      <StatusBadge status={run.status} />
      {sessionId && onNavigateToSession && (
        <button
          onClick={() => onNavigateToSession(sessionId)}
          className="rounded p-1 text-neutral-5 hover:text-accent-3 hover:bg-neutral-9 transition-colors shrink-0"
          title="View session"
        >
          <IconExternalLink size={13} stroke={2} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CustomWorkflowGuide — collapsible instructions for defining workflow.md files
// ---------------------------------------------------------------------------

function CustomWorkflowGuide() {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-6 rounded-xl border border-neutral-8/40 bg-neutral-11/20">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-[14px] font-medium text-neutral-3 hover:text-neutral-1 transition-colors"
      >
        {open
          ? <IconChevronDown size={14} stroke={2} className="text-neutral-5" />
          : <IconChevronRight size={14} stroke={2} className="text-neutral-5" />
        }
        Defining Custom Workflows
        <span className="text-[12px] text-neutral-5 font-normal ml-1">via workflow.md files</span>
      </button>

      {open && (
        <div className="px-4 pb-4 text-[13px] text-neutral-4 space-y-3 border-t border-neutral-8/30 pt-3">
          <p>
            You can define custom workflow types per-repo by adding <code className="text-accent-3 bg-neutral-10 px-1 rounded">.md</code> files to:
          </p>
          <pre className="rounded-md bg-neutral-12 px-3 py-2 text-[13px] text-neutral-3 font-mono overflow-x-auto">
{'<repo>/.codekin/workflows/<kind>.md'}
          </pre>

          <p>Each file uses YAML frontmatter + a prompt body:</p>
          <pre className="rounded-md bg-neutral-12 px-3 py-2 text-[13px] text-neutral-3 font-mono overflow-x-auto leading-relaxed">{
`---
kind: api-docs.weekly
name: API Documentation Check
sessionPrefix: api-docs
outputDir: .codekin/reports/api-docs
filenameSuffix: _api-docs.md
commitMessage: chore: api docs check
---
You are reviewing the API documentation for this project.

1. Find all REST endpoints and verify they have docs
2. Check for outdated examples or missing parameters
3. Produce a Markdown report

Important: Do NOT modify any source files.`
          }</pre>

          <div className="space-y-1.5 text-[13px]">
            <p className="font-medium text-neutral-3">Frontmatter fields:</p>
            <ul className="list-disc list-inside space-y-0.5 text-neutral-4 ml-1">
              <li><code className="text-neutral-3">kind</code> — unique ID, e.g. <code className="text-neutral-3">code-review.daily</code></li>
              <li><code className="text-neutral-3">name</code> — display name shown in the UI</li>
              <li><code className="text-neutral-3">sessionPrefix</code> — prefix for the session name</li>
              <li><code className="text-neutral-3">outputDir</code> — where reports are saved in the repo</li>
              <li><code className="text-neutral-3">filenameSuffix</code> — appended to the date for the report filename</li>
              <li><code className="text-neutral-3">commitMessage</code> — git commit message prefix</li>
            </ul>
          </div>

          <p className="text-neutral-5">
            Custom workflows appear automatically when adding a new workflow for that repo. To override a built-in workflow{"'"}s prompt, use the same <code className="text-neutral-3">kind</code> value.
          </p>
        </div>
      )}
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
        <h1 className="text-[17px] font-medium text-neutral-1">Workflows</h1>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 rounded-md bg-accent-7 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-6 transition-colors"
          >
            <IconPlus size={14} stroke={2} />
            New Workflow
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Error */}
        {error && (
          <div className="rounded-lg border border-error-8/50 bg-error-10/30 px-4 py-2 text-[15px] text-error-4 mb-4">
            {error}
          </div>
        )}

        {/* Workflow groups by repo */}
        {repos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-8 px-6 py-10 text-center">
            <div className="text-neutral-5 mb-1">
              <IconCalendarEvent size={32} stroke={1.5} className="mx-auto mb-3 text-neutral-6" />
              <div className="text-[15px] text-neutral-3 font-medium mb-1">No workflows configured</div>
              <div className="text-[13px] text-neutral-5">
                Set up automated code reviews, security audits, and more.
              </div>
            </div>
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent-7 px-4 py-2 text-[13px] font-medium text-white hover:bg-accent-6 transition-colors"
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
              className="flex items-center gap-2 text-[14px] font-medium text-neutral-3 hover:text-neutral-1 transition-colors mb-2"
            >
              {showActivity
                ? <IconChevronDown size={14} stroke={2} />
                : <IconArrowRight size={14} stroke={2} />
              }
              Recent Activity
              <span className="text-[12px] text-neutral-5 font-normal">({runs.length} runs)</span>
            </button>

            {showActivity && (
              <div className="rounded-xl border border-neutral-8/50 bg-neutral-11/30 py-1 divide-y divide-neutral-8/30">
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
