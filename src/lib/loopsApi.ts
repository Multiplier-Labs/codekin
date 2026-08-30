/**
 * HTTP client for the Loops 2.0 REST API.
 *
 * All calls go through the active transport at /api/loops/ with Bearer token
 * auth. Mirrors the shapes served by server/loop-routes.ts (backed by
 * server/loop-store.ts) — execution `state` and terminal `outcome` are
 * separate fields, and the append-only event log is resumable via
 * `?after=<sequence>`.
 */

import { transport } from './transport'

const BASE = '/api/loops'

function headers(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

// ---------------------------------------------------------------------------
// Types (mirroring server/loop-store.ts / loop-recipe.ts)
// ---------------------------------------------------------------------------

export type LoopRunState =
  | 'created'
  | 'preflight'
  | 'executing'
  | 'evaluating'
  | 'reviewing'
  | 'awaiting_approval'
  | 'pausing'
  | 'paused'
  | 'canceling'
  | 'finalizing'
  | 'recovering'
  | 'done'

export type LoopRunOutcome = 'completed' | 'completed_with_warnings' | 'failed' | 'canceled'

export interface LoopRecipeInfo {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'repo'
}

export interface LoopRun {
  id: string
  recipeId: string
  recipeHash: string
  goal: string
  repo: string
  branch: string
  baseSha: string | null
  provider: string
  model: string | null
  state: LoopRunState
  stateReason: string | null
  outcome: LoopRunOutcome | null
  makerSessionId: string | null
  worktreePath: string | null
  turnCount: number
  costUsd: number
  prUrl: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface LoopStage {
  id: string
  runId: string
  stageIndex: number
  kind: 'preflight' | 'act' | 'evaluate' | 'review' | 'finalize'
  status: 'running' | 'succeeded' | 'failed' | 'canceled'
  startedAt: string
  completedAt: string | null
}

export interface LoopEvaluation {
  id: string
  runId: string
  stageId: string
  evaluatorId: string
  status: 'pass' | 'fail' | 'warning' | 'error' | 'waived'
  classification: string | null
  summary: string
  fingerprint: string | null
  retryable: boolean
  durationMs: number
  costUsd: number | null
  evidenceArtifactIds: string[]
  createdAt: string
}

export interface LoopIntervention {
  id: string
  runId: string
  kind: 'approval' | 'question'
  purpose: string
  status: 'pending' | 'resolved' | 'canceled'
  title: string
  body: string | null
  options: string[]
  resolution: { choice: string; note?: string } | null
  createdAt: string
  resolvedAt: string | null
}

export interface LoopArtifact {
  id: string
  runId: string
  kind: string
  label: string
  contentHash: string
  sizeBytes: number
  createdAt: string
}

export interface LoopEvent<T = unknown> {
  runId: string
  sequence: number
  type: string
  at: string
  actor: { type: 'user' | 'system' | 'agent'; id?: string }
  stageId?: string
  attemptId?: string
  payload: T
}

export interface LoopRunDetail extends LoopRun {
  stages: LoopStage[]
  evaluations: LoopEvaluation[]
  interventions: LoopIntervention[]
  artifacts: LoopArtifact[]
  lastSequence: number
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export async function listLoopRecipes(token: string, repoPath?: string): Promise<LoopRecipeInfo[]> {
  const params = new URLSearchParams()
  if (repoPath) params.set('repoPath', repoPath)
  const qs = params.toString()
  const res = await transport.fetch(`${BASE}/recipes${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list loop recipes: ${res.status}`)
  const data = (await res.json()) as { recipes: LoopRecipeInfo[] }
  return data.recipes
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function listLoopRuns(
  token: string,
  opts?: { state?: LoopRunState; active?: boolean; repo?: string; limit?: number },
): Promise<LoopRun[]> {
  const params = new URLSearchParams()
  if (opts?.state) params.set('state', opts.state)
  if (opts?.active) params.set('active', '1')
  if (opts?.repo) params.set('repo', opts.repo)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const res = await transport.fetch(`${BASE}/runs${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list loop runs: ${res.status}`)
  const data = (await res.json()) as { runs: LoopRun[] }
  return data.runs
}

export async function getLoopRun(token: string, runId: string): Promise<LoopRunDetail> {
  const res = await transport.fetch(`${BASE}/runs/${encodeURIComponent(runId)}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to fetch loop run: ${res.status}`)
  const data = (await res.json()) as { run: LoopRunDetail }
  return data.run
}

export async function getLoopRunEvents(
  token: string,
  runId: string,
  after = 0,
): Promise<{ events: LoopEvent[]; lastSequence: number }> {
  const res = await transport.fetch(`${BASE}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to fetch loop run events: ${res.status}`)
  return (await res.json()) as { events: LoopEvent[]; lastSequence: number }
}

export async function startLoopRun(
  token: string,
  input: { recipeId: string; repo: string; branch?: string; goal?: string },
): Promise<LoopRun> {
  const res = await transport.fetch(`${BASE}/runs`, { method: 'POST', headers: headers(token), body: JSON.stringify(input) })
  const data = (await res.json()) as { run?: LoopRun; error?: string }
  if (!res.ok || !data.run) throw new Error(data.error ?? `Failed to start loop run: ${res.status}`)
  return data.run
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function control(token: string, runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const res = await transport.fetch(`${BASE}/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST', headers: headers(token) })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Failed to ${action} loop run: ${res.status}`)
  }
}

export const pauseLoopRun = (token: string, runId: string) => control(token, runId, 'pause')
export const resumeLoopRun = (token: string, runId: string) => control(token, runId, 'resume')
export const cancelLoopRun = (token: string, runId: string) => control(token, runId, 'cancel')

export async function steerLoopRun(token: string, runId: string, instruction: string): Promise<void> {
  const res = await transport.fetch(`${BASE}/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ instruction }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Failed to steer loop run: ${res.status}`)
  }
}

export async function resolveLoopIntervention(
  token: string,
  runId: string,
  interventionId: string,
  choice: string,
  note?: string,
): Promise<void> {
  const res = await transport.fetch(
    `${BASE}/runs/${encodeURIComponent(runId)}/interventions/${encodeURIComponent(interventionId)}/resolve`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ choice, note }) },
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Failed to resolve intervention: ${res.status}`)
  }
}
