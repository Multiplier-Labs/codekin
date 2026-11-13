/**
 * HTTP client for the Loops 2.0 REST API.
 *
 * All calls go through the active transport at /api/loops/ with Bearer token
 * auth. Mirrors the shapes served by server/loop-routes.ts (backed by
 * server/loop-store.ts) — execution `state` and terminal `outcome` are
 * separate fields, and the append-only event log is resumable via
 * `?after=<sequence>`.
 */

import { readJson, request, send, type RequestOptions } from './request'

const BASE = '/api/loops'

/** A /api/loops call. Every loops request sends the JSON content type and the Bearer token. */
function loops<T = unknown>(token: string, path: string, opts: Omit<RequestOptions, 'token'>): Promise<T> {
  return request<T>(`${BASE}${path}`, { token, jsonHeader: true, ...opts })
}

// ---------------------------------------------------------------------------
// Types (mirroring server/loop-store.ts / loop-recipe.ts)
// ---------------------------------------------------------------------------

export type LoopRunState =
  | 'created'
  | 'preflight'
  | 'planning'
  | 'executing'
  | 'evaluating'
  | 'reviewing'
  | 'awaiting_approval'
  | 'pausing'
  | 'paused'
  | 'canceling'
  | 'finalizing'
  | 'monitoring_ci'
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
  baseBranch: string | null
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
  kind: 'preflight' | 'plan' | 'act' | 'evaluate' | 'review' | 'finalize' | 'ci' | 'integrate'
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

export interface LoopScorecardEntry {
  id: string
  type: string
  required: boolean
  status: 'pending' | 'pass' | 'fail' | 'warning' | 'error' | 'waived'
  summary: string | null
  evidenceArtifactIds: string[]
}

export interface LoopRunDetail extends LoopRun {
  /** The recipe frozen at run start (subset the UI renders). */
  recipe: {
    name: string
    plan: { required: boolean }
    budgets: { turns: number; costUsd: number; wallTimeMs?: number; noProgressAttempts: number }
    policy: { mode: 'guided' | 'guarded' | 'autonomous' }
    completion: { action: 'pull-request' | 'commit-only' }
  }
  stages: LoopStage[]
  evaluations: LoopEvaluation[]
  /** Every criterion in the frozen recipe with its latest result. */
  scorecard: LoopScorecardEntry[]
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
  return (await loops<{ recipes: LoopRecipeInfo[] }>(token, `/recipes${qs ? `?${qs}` : ''}`, { error: 'Failed to list loop recipes' })).recipes
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
  return (await loops<{ runs: LoopRun[] }>(token, `/runs${qs ? `?${qs}` : ''}`, { error: 'Failed to list loop runs' })).runs
}

export async function getLoopRun(token: string, runId: string): Promise<LoopRunDetail> {
  return (await loops<{ run: LoopRunDetail }>(token, `/runs/${encodeURIComponent(runId)}`, { error: 'Failed to fetch loop run' })).run
}

export function getLoopRunEvents(
  token: string,
  runId: string,
  after = 0,
): Promise<{ events: LoopEvent[]; lastSequence: number }> {
  return loops(token, `/runs/${encodeURIComponent(runId)}/events?after=${after}`, { error: 'Failed to fetch loop run events' })
}

export interface RecipeOverrides {
  mode?: 'guided' | 'guarded' | 'autonomous'
  budgets?: { turns?: number; costUsd?: number; wallTimeMinutes?: number; noProgressAttempts?: number }
  planRequired?: boolean
}

export interface StartLoopInput {
  recipeId: string
  repo: string
  branch?: string
  baseBranch?: string
  goal?: string
  overrides?: RecipeOverrides
}

export interface EffectiveLoopConfig {
  recipe: {
    id: string
    name: string
    description?: string
    plan: { required: boolean }
    evaluators: Array<{ id: string; type: string; command?: string | string[]; required: boolean }>
    budgets: { turns: number; costUsd: number; wallTimeMs?: number; noProgressAttempts: number }
    policy: { mode: 'guided' | 'guarded' | 'autonomous' }
    completion: { action: 'pull-request' | 'commit-only' }
    workspace: { protectedPaths: string[] }
    contentHash: string
  }
  repo: string
  branch: string
  baseBranch: string | null
  goal: string
  provider: string
  model: string | null
}

/** The wizard's confirmation screen: exactly what would run, before spending. */
export async function preflightLoopRun(token: string, input: StartLoopInput): Promise<EffectiveLoopConfig> {
  const res = await send(`${BASE}/runs/preflight`, { method: 'POST', token, body: input })
  const data = await readJson<{ effective?: EffectiveLoopConfig; error?: string }>(res)
  if (!res.ok || !data.effective) throw new Error(data.error ?? `Preflight failed: ${res.status}`)
  return data.effective
}

export async function startLoopRun(token: string, input: StartLoopInput): Promise<LoopRun> {
  const res = await send(`${BASE}/runs`, { method: 'POST', token, body: input })
  const data = await readJson<{ run?: LoopRun; error?: string }>(res)
  if (!res.ok || !data.run) throw new Error(data.error ?? `Failed to start loop run: ${res.status}`)
  return data.run
}

/** Local branches of a cloned repo, with the detected default. */
export function listLoopBranches(token: string, repoPath: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  return loops(token, `/branches?repoPath=${encodeURIComponent(repoPath)}`, { error: 'Failed to list branches' })
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function control(token: string, runId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  await loops(token, `/runs/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST', parse: 'none', serverMessage: ['error'], error: `Failed to ${action} loop run`,
  })
}

export const pauseLoopRun = (token: string, runId: string) => control(token, runId, 'pause')
export const resumeLoopRun = (token: string, runId: string) => control(token, runId, 'resume')
export const cancelLoopRun = (token: string, runId: string) => control(token, runId, 'cancel')

export async function steerLoopRun(token: string, runId: string, instruction: string, revisePlan = false): Promise<void> {
  await loops(token, `/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST', body: { instruction, revisePlan }, parse: 'none', serverMessage: ['error'], error: 'Failed to steer loop run',
  })
}

export interface LoopLesson {
  id: string
  recipeId: string
  sourceRunId: string
  kind: string
  text: string
  status: 'suggested' | 'approved' | 'rejected'
  createdAt: string
  resolvedAt: string | null
}

/** Reflection suggestions for a recipe; approved ones join future run prompts. */
export async function listLoopLessons(token: string, recipeId?: string, status?: LoopLesson['status']): Promise<LoopLesson[]> {
  const params = new URLSearchParams()
  if (recipeId) params.set('recipeId', recipeId)
  if (status) params.set('status', status)
  const qs = params.toString()
  return (await loops<{ lessons: LoopLesson[] }>(token, `/lessons${qs ? `?${qs}` : ''}`, { error: 'Failed to list lessons' })).lessons
}

export async function resolveLoopLesson(token: string, lessonId: string, action: 'approve' | 'reject'): Promise<void> {
  await loops(token, `/lessons/${encodeURIComponent(lessonId)}/${action}`, {
    method: 'POST', parse: 'none', serverMessage: ['error'], error: `Failed to ${action} lesson`,
  })
}

/** Fork a run into a new one starting from its current worktree state. */
export async function forkLoopRun(token: string, runId: string): Promise<LoopRun> {
  const res = await send(`${BASE}/runs/${encodeURIComponent(runId)}/fork`, { method: 'POST', token, jsonHeader: true })
  const data = await readJson<{ run?: LoopRun; error?: string }>(res)
  if (!res.ok || !data.run) throw new Error(data.error ?? `Failed to fork run: ${res.status}`)
  return data.run
}

/** Artifact body (plan text, evaluator output, review) as text. */
export function getLoopArtifactBody(token: string, runId: string, artifactId: string): Promise<string> {
  return loops(token, `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`, {
    parse: 'text', error: 'Failed to fetch artifact',
  })
}

export async function resolveLoopIntervention(
  token: string,
  runId: string,
  interventionId: string,
  choice: string,
  note?: string,
): Promise<void> {
  await loops(token, `/runs/${encodeURIComponent(runId)}/interventions/${encodeURIComponent(interventionId)}/resolve`, {
    method: 'POST', body: { choice, note }, parse: 'none', serverMessage: ['error'], error: 'Failed to resolve intervention',
  })
}
