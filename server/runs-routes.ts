/**
 * REST API for the unified run read model.
 *
 * Mounted at /api/runs. One endpoint, one shape (see unified-runs.ts) — the
 * Automations "All" feed reads this instead of joining the two engine APIs
 * client-side, and the future single-run-store refactor keeps serving it.
 *
 *   GET /?limit=&engine=&status=   — both engines' runs, newest first
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type { LoopStore } from './loop-store.js'
import type { RunStore } from './run-store.js'
import type { WorkflowEngine } from './workflow-engine.js'
import { mergeRuns, type UnifiedRun } from './unified-runs.js'
import { TERMINAL_RUN_STATUSES, type RunLifecycleStatus } from './run-status.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

const ENGINES = ['workflow', 'loop', 'agent'] as const

export function createRunsRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  /** Lazy — the workflow engine may not be initialized (quiet mode, init failure). */
  getEngine: () => WorkflowEngine | null,
  loops: LoopStore,
  /** Unified store — orchestrator children (engine 'agent') live here. */
  runStore?: RunStore,
): Router {
  const router = Router()

  router.use((req: Request, res: Response, next: () => void) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  router.get('/', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500) : 100
    const engine = typeof req.query.engine === 'string' ? req.query.engine : undefined
    const status = typeof req.query.status === 'string' ? (req.query.status as RunLifecycleStatus) : undefined
    if (engine && !ENGINES.includes(engine as (typeof ENGINES)[number])) {
      return res.status(400).json({ error: `Invalid engine: ${engine}` })
    }

    const workflowRuns = engine && engine !== 'workflow' ? [] : (getEngine()?.listRuns({ limit }) ?? [])
    const loopRuns = engine && engine !== 'loop' ? [] : loops.listRuns({ limit })
    const storedRuns = engine && engine !== 'agent' ? [] : (runStore?.listRuns({ engine: 'agent', limit }) ?? [])

    let runs: UnifiedRun[] = mergeRuns(workflowRuns, loopRuns, limit, storedRuns)
    if (status) runs = runs.filter((r) => r.status === status)
    res.json({ runs })
  })

  return router
}

/** Whether a unified run can still change state (feed polling hint). */
export function isActiveRun(run: UnifiedRun): boolean {
  return !TERMINAL_RUN_STATUSES.has(run.status)
}
