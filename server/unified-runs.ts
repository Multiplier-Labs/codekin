/**
 * The unified run read model.
 *
 * One shape for every background run, whatever engine produced it. This is
 * the contract the Automations feed renders and — more importantly — the API
 * the eventual single-run-store refactor must keep serving. Storage today is
 * two table families in one runs.db; when they merge into one schema, this
 * module shrinks to a row mapper and nothing above it notices.
 *
 * Canonicalization: `aborted` (loops) reads as `canceled` (the catalog's
 * synonym pair — see run-status.ts). `rawStatus` keeps the engine's own word
 * for engine-specific detail views.
 */

import type { WorkflowRun } from './workflow-engine.js'
import type { GoalRun } from './goal-run-store.js'
import type { StoredRun } from './run-store.js'
import type { RunLifecycleStatus } from './run-status.js'

export interface UnifiedRun {
  id: string
  engine: 'workflow' | 'loop' | 'agent'
  kind: string
  /** Canonical status — loop `aborted` reads as `canceled`. */
  status: RunLifecycleStatus
  /** Human-readable purpose when the engine records one (agent runs: the task). */
  title: string | null
  /** The engine's native status string. */
  rawStatus: string
  /** Absolute repo path the run worked on, when known. */
  repo: string | null
  /** Loop branch; workflows have none. */
  branch: string | null
  createdAt: string
  completedAt: string | null
  /** Loop spend; workflows do not track cost. */
  costUsd: number | null
  prUrl: string | null
  /** Primary session (workflow session / loop maker), when recorded. */
  sessionId: string | null
  error: string | null
}

export function fromWorkflowRun(run: WorkflowRun): UnifiedRun {
  const repoPath = run.input.repoPath
  return {
    id: run.id,
    engine: 'workflow',
    kind: run.kind,
    status: run.status,
    title: null,
    rawStatus: run.status,
    repo: typeof repoPath === 'string' ? repoPath : null,
    branch: null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    costUsd: null,
    prUrl: null,
    sessionId: run.sessionId ?? null,
    error: run.error,
  }
}

export function fromGoalRun(run: GoalRun): UnifiedRun {
  return {
    id: run.id,
    engine: 'loop',
    kind: run.kind,
    title: run.goal.split('\n')[0].slice(0, 120) || null,
    status: run.status === 'aborted' ? 'canceled' : run.status,
    rawStatus: run.status,
    repo: run.repo,
    branch: run.branch,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    costUsd: run.costUsd,
    prUrl: run.prUrl,
    sessionId: run.makerSessionId,
    error: null,
  }
}

/** Rows from the unified run store (agent runs today) are already this shape. */
export function fromStoredRun(run: StoredRun): UnifiedRun {
  return {
    id: run.id,
    engine: run.engine,
    kind: run.kind,
    status: run.status,
    title: run.title || null,
    rawStatus: run.status,
    repo: run.repo,
    branch: run.branch,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    costUsd: run.costUsd,
    prUrl: run.prUrl,
    sessionId: run.sessionIds[0] ?? null,
    error: run.error,
  }
}

/** Merge all engines' runs newest-first (id as the stable tiebreak). */
export function mergeRuns(workflowRuns: WorkflowRun[], goalRuns: GoalRun[], limit: number, storedRuns: StoredRun[] = []): UnifiedRun[] {
  return [...workflowRuns.map(fromWorkflowRun), ...goalRuns.map(fromGoalRun), ...storedRuns.map(fromStoredRun)]
    .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
    .slice(0, limit)
}
