/**
 * HTTP client for the workflow engine REST API.
 *
 * All calls go through /cc/api/workflows/ with Bearer token auth.
 */

const BASE = '/cc/api/workflows'

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

export async function listKinds(
  token: string,
  repoPath?: string,
): Promise<WorkflowKindInfo[]> {
  const params = new URLSearchParams()
  if (repoPath) params.set('repoPath', repoPath)
  const qs = params.toString()
  const res = await fetch(`${BASE}/kinds${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list kinds: ${res.status}`)
  const data = await res.json()
  return data.kinds
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

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
  const res = await fetch(`${BASE}/runs${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`)
  const data = await res.json()
  return data.runs
}

export async function getRun(token: string, runId: string): Promise<WorkflowRunWithSteps> {
  const res = await fetch(`${BASE}/runs/${runId}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get run: ${res.status}`)
  const data = await res.json()
  return data.run
}

export async function triggerRun(
  token: string,
  kind: string,
  input: Record<string, unknown> = {}
): Promise<WorkflowRun> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ kind, input }),
  })
  if (!res.ok) throw new Error(`Failed to trigger run: ${res.status}`)
  const data = await res.json()
  return data.run
}

export async function cancelRun(token: string, runId: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${runId}/cancel`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to cancel run: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function listSchedules(token: string): Promise<CronSchedule[]> {
  const res = await fetch(`${BASE}/schedules`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list schedules: ${res.status}`)
  const data = await res.json()
  return data.schedules
}

export async function triggerSchedule(token: string, id: string): Promise<WorkflowRun> {
  const res = await fetch(`${BASE}/schedules/${id}/trigger`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to trigger schedule: ${res.status}`)
  const data = await res.json()
  return data.run
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getConfig(token: string): Promise<WorkflowConfig> {
  const res = await fetch(`${BASE}/config`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get config: ${res.status}`)
  const data = await res.json()
  return data.config
}

export async function addRepoConfig(
  token: string,
  repo: ReviewRepoConfig
): Promise<WorkflowConfig> {
  const res = await fetch(`${BASE}/config/repos`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(repo),
  })
  if (!res.ok) throw new Error(`Failed to add repo config: ${res.status}`)
  const data = await res.json()
  return data.config
}

export async function removeRepoConfig(token: string, id: string): Promise<WorkflowConfig> {
  const res = await fetch(`${BASE}/config/repos/${id}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to remove repo config: ${res.status}`)
  const data = await res.json()
  return data.config
}

export async function patchRepoConfig(
  token: string,
  id: string,
  patch: Partial<ReviewRepoConfig>
): Promise<WorkflowConfig> {
  const res = await fetch(`${BASE}/config/repos/${id}`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update repo config: ${res.status}`)
  const data = await res.json()
  return data.config
}
