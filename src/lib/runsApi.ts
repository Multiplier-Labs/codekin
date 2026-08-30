/**
 * Client for the unified run read model (GET /api/runs).
 *
 * Mirrors server/unified-runs.ts — one shape for every background run,
 * whichever engine (workflow or loop) produced it.
 */

import { transport } from './transport'

export type UnifiedRunStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'checking'
  | 'blocked'
  | 'awaiting_human'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'skipped'

export interface UnifiedRun {
  id: string
  engine: 'workflow' | 'loop' | 'agent'
  kind: string
  status: UnifiedRunStatus
  title: string | null
  rawStatus: string
  repo: string | null
  branch: string | null
  createdAt: string
  completedAt: string | null
  costUsd: number | null
  prUrl: string | null
  sessionId: string | null
  error: string | null
}

export async function listUnifiedRuns(
  token: string,
  opts?: { limit?: number; engine?: 'workflow' | 'loop' | 'agent'; status?: UnifiedRunStatus },
): Promise<UnifiedRun[]> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.engine) params.set('engine', opts.engine)
  if (opts?.status) params.set('status', opts.status)
  const qs = params.toString()
  const res = await transport.fetch(`/api/runs${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to load runs (${res.status})`)
  const body = (await res.json()) as { runs: UnifiedRun[] }
  return body.runs
}
