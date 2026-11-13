/**
 * HTTP client for the workflow engine REST API.
 *
 * All calls go through the active transport at /api/workflows/ with Bearer token auth.
 */

import { request, type RequestOptions } from './request'

const BASE = '/api/workflows'

/** A /api/workflows call. Every workflows request sends the JSON content type and the Bearer token. */
function workflows<T = unknown>(token: string, path: string, opts: Omit<RequestOptions, 'token'>): Promise<T> {
  return request<T>(`${BASE}${path}`, { token, jsonHeader: true, ...opts })
}

// ---------------------------------------------------------------------------
// Types (mirroring server workflow-engine.ts types)
// ---------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped'
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface WorkflowRun {
  id: string
  kind: string
  status: RunStatus
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface WorkflowStep {
  id: string
  runId: string
  key: string
  status: StepStatus
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface WorkflowRunWithSteps extends WorkflowRun {
  steps: WorkflowStep[]
}

export interface CronSchedule {
  id: string
  kind: string
  cronExpression: string
  input: Record<string, unknown>
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  catchUp?: 'collapse' | 'skip'
  lastReviewedSha?: string | null
  lastHeldAt?: string | null
  lastHeldReason?: string | null
  heldCount?: number
}

export interface ReviewRepoConfig {
  id: string
  name: string
  repoPath: string
  cronExpression: string
  enabled: boolean
  kind?: string
  customPrompt?: string
  model?: string
  /** AI provider to use for this workflow ('claude', 'opencode', or 'codex'). Defaults to 'claude'. */
  provider?: 'claude' | 'opencode' | 'codex'
  /** Configuration revision; bumps on every change. */
  revision?: number
  /** 'maintenance' when adopted into the repo's maintenance plan (pauses with it). */
  managedBy?: 'maintenance'
}

export interface WorkflowConfig {
  reviewRepos: ReviewRepoConfig[]
}

export interface WorkflowKindInfo {
  kind: string
  name: string
  source: 'builtin' | 'repo'
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** List available workflow kinds. Optionally filter by repo to include repo-specific kinds. */
export async function listKinds(
  token: string,
  repoPath?: string,
): Promise<WorkflowKindInfo[]> {
  const params = new URLSearchParams()
  if (repoPath) params.set('repoPath', repoPath)
  const qs = params.toString()
  return (await workflows<{ kinds: WorkflowKindInfo[] }>(token, `/kinds${qs ? `?${qs}` : ''}`, { error: 'Failed to list kinds' })).kinds
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Fetch workflow runs, optionally filtered by kind/status with pagination. */
export async function listRuns(
  token: string,
  opts?: { kind?: string; status?: RunStatus; limit?: number; offset?: number }
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams()
  if (opts?.kind) params.set('kind', opts.kind)
  if (opts?.status) params.set('status', opts.status)
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.offset) params.set('offset', String(opts.offset))

  const qs = params.toString()
  return (await workflows<{ runs: WorkflowRun[] }>(token, `/runs${qs ? `?${qs}` : ''}`, { error: 'Failed to list runs' })).runs
}

/** Fetch a single run with its step details. */
export async function getRun(token: string, runId: string): Promise<WorkflowRunWithSteps> {
  return (await workflows<{ run: WorkflowRunWithSteps }>(token, `/runs/${runId}`, { error: 'Failed to get run' })).run
}

/** Manually trigger a new workflow run. Returns the created run. */
export async function triggerRun(
  token: string,
  kind: string,
  input: Record<string, unknown> = {}
): Promise<WorkflowRun> {
  return (await workflows<{ run: WorkflowRun }>(token, `/runs`, { method: 'POST', body: { kind, input }, error: 'Failed to trigger run' })).run
}

/** Cancel a running or queued workflow run. */
export async function cancelRun(token: string, runId: string): Promise<void> {
  await workflows(token, `/runs/${runId}/cancel`, { method: 'POST', parse: 'none', error: 'Failed to cancel run' })
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Fetch all cron schedules. */
export async function listSchedules(token: string): Promise<CronSchedule[]> {
  return (await workflows<{ schedules: CronSchedule[] }>(token, `/schedules`, { error: 'Failed to list schedules' })).schedules
}

export interface TriggerLedgerEntry {
  id: number
  scheduleId: string | null
  kind: string
  decision: 'fired' | 'held'
  reason: string
  runId: string | null
  headSha: string | null
  createdAt: string
}

/** Trigger ledger — why schedules and signals did or didn't fire, newest first. */
export async function listTriggerLedger(token: string, opts?: { scheduleId?: string; limit?: number }): Promise<TriggerLedgerEntry[]> {
  const params = new URLSearchParams()
  if (opts?.scheduleId) params.set('scheduleId', opts.scheduleId)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return (await workflows<{ entries: TriggerLedgerEntry[] }>(token, `/trigger-ledger${qs ? `?${qs}` : ''}`, { error: 'Failed to list trigger ledger' })).entries
}

export type ActivityTier = 'active' | 'cooling' | 'dormant'

export interface RepoActivity {
  repoPath: string
  lastCommitAt: string | null
  lastCommitSha: string | null
  lastSessionAt: string | null
  lastCommitEventAt: string | null
  lastPrEventAt: string | null
  lastSignalAt: string | null
  tier: ActivityTier
  updatedAt: string
}

/** Fetch activity tiers for configured review repos. */
export async function listRepoActivity(token: string): Promise<RepoActivity[]> {
  return (await workflows<{ repos: RepoActivity[] }>(token, `/repo-activity`, { error: 'Failed to list repo activity' })).repos
}

/** Manually trigger a scheduled workflow, creating a new run. */
export async function triggerSchedule(token: string, id: string): Promise<WorkflowRun> {
  return (await workflows<{ run: WorkflowRun }>(token, `/schedules/${id}/trigger`, { method: 'POST', error: 'Failed to trigger schedule' })).run
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Fetch the current workflow configuration (repo list and settings). */
export async function getConfig(token: string): Promise<WorkflowConfig> {
  return (await workflows<{ config: WorkflowConfig }>(token, `/config`, { error: 'Failed to get config' })).config
}

export interface WebhookSetupResult {
  status: 'created' | 'updated' | 'already_configured' | 'failed'
  message: string
  repo?: string
}

export interface AddRepoResult {
  config: WorkflowConfig
  webhookSetup?: WebhookSetupResult
}

/** Add a new repo to the workflow configuration. Returns the updated config and optional webhook setup result. */
export async function addRepoConfig(
  token: string,
  repo: ReviewRepoConfig,
  webhookUrl?: string,
): Promise<AddRepoResult> {
  const body = webhookUrl ? { ...repo, webhookUrl } : repo
  const data = await workflows<{ config: WorkflowConfig; webhookSetup?: WebhookSetupResult }>(token, `/config/repos`, {
    method: 'POST', body, error: 'Failed to add repo config',
  })
  return { config: data.config, webhookSetup: data.webhookSetup }
}

/** Remove a repo from the workflow configuration. Returns the updated config. */
export async function removeRepoConfig(token: string, id: string): Promise<WorkflowConfig> {
  return (await workflows<{ config: WorkflowConfig }>(token, `/config/repos/${id}`, { method: 'DELETE', error: 'Failed to remove repo config' })).config
}

/** Partially update a repo's workflow configuration. Returns the updated config. */
export async function patchRepoConfig(
  token: string,
  id: string,
  patch: Partial<ReviewRepoConfig>
): Promise<WorkflowConfig> {
  return (await workflows<{ config: WorkflowConfig }>(token, `/config/repos/${id}`, {
    method: 'PATCH', body: patch, error: 'Failed to update repo config',
  })).config
}
