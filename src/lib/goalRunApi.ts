/**
 * HTTP client for the Goal Run (loop) REST API.
 *
 * All calls go through the active transport at /api/goal-runs/ with Bearer
 * token auth. Mirrors the shapes returned by server/goal-run-routes.ts and
 * server/goal-run-store.ts.
 */

import { transport } from './transport'

const BASE = '/api/goal-runs'

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
// Types (mirroring server/goal-run-store.ts)
// ---------------------------------------------------------------------------

export type GoalRunKind = 'ci-autorepair' | 'coverage-increase' | 'dependency-upgrade'

export type GoalRunStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'checking'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'aborted'

export type TurnRole = 'maker' | 'checker' | 'verifier'
export type CheckerVerdict = 'approve' | 'request_changes' | 'escalate'
export type LoopProvider = 'claude' | 'opencode' | 'codex'
export type CompletionPolicy = 'pr' | 'merge' | 'commit-only'

export interface ProviderRole {
  provider: LoopProvider
  model?: string
}

export interface GoalRunSpec {
  maker: ProviderRole
  checker?: ProviderRole | null
  verify: string[]
  readonly?: string[]
  maxTurns: number
  maxCostUsd: number
  completionPolicy: CompletionPolicy
}

export interface GoalRun {
  id: string
  kind: GoalRunKind
  status: GoalRunStatus
  goal: string
  spec: GoalRunSpec
  repo: string
  branch: string
  makerSessionId: string | null
  checkerSessionId: string | null
  turnCount: number
  costUsd: number
  verdict: string | null
  prUrl: string | null
  createdAt: string
  completedAt: string | null
}

export interface GoalRunTurn {
  id: string
  runId: string
  turnIndex: number
  role: TurnRole
  diffSummary: string | null
  verifyCmd: string | null
  exitCode: number | null
  outputTail: string | null
  verdict: CheckerVerdict | null
  costUsd: number | null
  createdAt: string
}

export interface GoalRunWithTurns extends GoalRun {
  turns: GoalRunTurn[]
}

export interface LoopTemplateInfo {
  kind: GoalRunKind
  name: string
  source: 'builtin' | 'repo'
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** List available loop templates, optionally including a repo's overrides. */
export async function listLoopTemplates(token: string, repoPath?: string): Promise<LoopTemplateInfo[]> {
  const params = new URLSearchParams()
  if (repoPath) params.set('repoPath', repoPath)
  const qs = params.toString()
  const res = await transport.fetch(`${BASE}/templates${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list loop templates: ${res.status}`)
  const data = await fetchJson<{ templates: LoopTemplateInfo[] }>(res)
  return data.templates
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Fetch goal runs, optionally filtered by kind/status. */
export async function listGoalRuns(
  token: string,
  opts?: { kind?: GoalRunKind; status?: GoalRunStatus; limit?: number },
): Promise<GoalRun[]> {
  const params = new URLSearchParams()
  if (opts?.kind) params.set('kind', opts.kind)
  if (opts?.status) params.set('status', opts.status)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const res = await transport.fetch(`${BASE}/runs${qs ? `?${qs}` : ''}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list goal runs: ${res.status}`)
  const data = await fetchJson<{ runs: GoalRun[] }>(res)
  return data.runs
}

/** Fetch a single run with its evidence ledger (turns). */
export async function getGoalRun(token: string, runId: string): Promise<GoalRunWithTurns> {
  const res = await transport.fetch(`${BASE}/runs/${runId}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get goal run: ${res.status}`)
  const data = await fetchJson<{ run: GoalRunWithTurns }>(res)
  return data.run
}

/** Start a goal run from a template. `goal` overrides the template's default goal text. */
export async function startGoalRun(
  token: string,
  input: { kind: GoalRunKind; repo: string; branch: string; goal?: string },
): Promise<GoalRun> {
  const res = await transport.fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const data = await fetchJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
    throw new Error(data.error || `Failed to start goal run: ${res.status}`)
  }
  const data = await fetchJson<{ run: GoalRun }>(res)
  return data.run
}

/** Abort an in-flight goal run. */
export async function abortGoalRun(token: string, runId: string): Promise<void> {
  const res = await transport.fetch(`${BASE}/runs/${runId}/abort`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to abort goal run: ${res.status}`)
}
