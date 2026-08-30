/**
 * HTTP client for the workflow engine REST API.
 *
 * All calls go through the active transport at /api/workflows/ with Bearer token auth.
 */

import { transport } from './transport'

const BASE = '/api/workflows'

/** Type-safe wrapper around Response.json() to avoid `any` leakage. */
async function fetchJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

function headers(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
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
  const res = await transport.fetch(`${BASE}/kinds${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list kinds: ${res.status}`)
  const data = await fetchJson<{ kinds: WorkflowKindInfo[] }>(res)
  return data.kinds
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
  const res = await transport.fetch(`${BASE}/runs${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`)
  const data = await fetchJson<{ runs: WorkflowRun[] }>(res)
  return data.runs
}

/** Fetch a single run with its step details. */
export async function getRun(token: string, runId: string): Promise<WorkflowRunWithSteps> {
  const res = await transport.fetch(`${BASE}/runs/${runId}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get run: ${res.status}`)
  const data = await fetchJson<{ run: WorkflowRunWithSteps }>(res)
  return data.run
}

/** Manually trigger a new workflow run. Returns the created run. */
export async function triggerRun(
  token: string,
  kind: string,
  input: Record<string, unknown> = {}
): Promise<WorkflowRun> {
  const res = await transport.fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ kind, input }),
  })
  if (!res.ok) throw new Error(`Failed to trigger run: ${res.status}`)
  const data = await fetchJson<{ run: WorkflowRun }>(res)
  return data.run
}

/** Cancel a running or queued workflow run. */
export async function cancelRun(token: string, runId: string): Promise<void> {
  const res = await transport.fetch(`${BASE}/runs/${runId}/cancel`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to cancel run: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Fetch all cron schedules. */
export async function listSchedules(token: string): Promise<CronSchedule[]> {
  const res = await transport.fetch(`${BASE}/schedules`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list schedules: ${res.status}`)
  const data = await fetchJson<{ schedules: CronSchedule[] }>(res)
  return data.schedules
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
  const res = await transport.fetch(`${BASE}/trigger-ledger${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list trigger ledger: ${res.status}`)
  const data = await fetchJson<{ entries: TriggerLedgerEntry[] }>(res)
  return data.entries
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
  const res = await transport.fetch(`${BASE}/repo-activity`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list repo activity: ${res.status}`)
  const data = await fetchJson<{ repos: RepoActivity[] }>(res)
  return data.repos
}

/** Manually trigger a scheduled workflow, creating a new run. */
export async function triggerSchedule(token: string, id: string): Promise<WorkflowRun> {
  const res = await transport.fetch(`${BASE}/schedules/${id}/trigger`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to trigger schedule: ${res.status}`)
  const data = await fetchJson<{ run: WorkflowRun }>(res)
  return data.run
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Fetch the current workflow configuration (repo list and settings). */
export async function getConfig(token: string): Promise<WorkflowConfig> {
  const res = await transport.fetch(`${BASE}/config`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get config: ${res.status}`)
  const data = await fetchJson<{ config: WorkflowConfig }>(res)
  return data.config
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
  const res = await transport.fetch(`${BASE}/config/repos`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Failed to add repo config: ${res.status}`)
  const data = await fetchJson<{ config: WorkflowConfig; webhookSetup?: WebhookSetupResult }>(res)
  return { config: data.config, webhookSetup: data.webhookSetup }
}

/** Remove a repo from the workflow configuration. Returns the updated config. */
export async function removeRepoConfig(token: string, id: string): Promise<WorkflowConfig> {
  const res = await transport.fetch(`${BASE}/config/repos/${id}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to remove repo config: ${res.status}`)
  const data = await fetchJson<{ config: WorkflowConfig }>(res)
  return data.config
}

/** Partially update a repo's workflow configuration. Returns the updated config. */
export async function patchRepoConfig(
  token: string,
  id: string,
  patch: Partial<ReviewRepoConfig>
): Promise<WorkflowConfig> {
  const res = await transport.fetch(`${BASE}/config/repos/${id}`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update repo config: ${res.status}`)
  const data = await fetchJson<{ config: WorkflowConfig }>(res)
  return data.config
}
