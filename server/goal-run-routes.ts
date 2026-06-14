/**
 * REST API routes for Goal Runs (loop runs).
 *
 * Mounted at /api/goal-runs/ on the Express app. Exposes the loop templates,
 * the runs list, a per-run evidence ledger, and start/abort controls. All routes
 * require the master Bearer token, mirroring the workflow router.
 *
 * Endpoints:
 *   GET  /templates            — list loop templates (built-ins + repo overrides)
 *   GET  /runs                 — list runs (optional kind/status/limit filters)
 *   GET  /runs/:id             — a run plus its turn-by-turn evidence ledger
 *   POST /runs                 — start a run from a template { kind, repo, branch, goal? }
 *   POST /runs/:id/abort       — abort an in-flight run
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { resolveRepoPathInRoot } from './config.js'
import type { GoalRunKind, GoalRunStatus } from './goal-run-store.js'
import { GoalRunStore } from './goal-run-store.js'
import { GoalRunController } from './goal-run-controller.js'
import { listLoopTemplates, loadLoopTemplate, buildGoalRunInput } from './loop-loader.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

const KINDS: readonly GoalRunKind[] = ['ci-autorepair', 'coverage-increase', 'dependency-upgrade']
const STATUSES: readonly GoalRunStatus[] = [
  'queued',
  'running',
  'verifying',
  'checking',
  'awaiting_human',
  'succeeded',
  'failed',
  'aborted',
]

interface StartRunBody {
  kind?: string
  repo?: string
  branch?: string
  goal?: string
}

export function createGoalRunRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  store: GoalRunStore,
  controller: GoalRunController,
): Router {
  const router = Router()

  router.use((req: Request, res: Response, next: () => void) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  router.get('/templates', (req, res) => {
    const repoPath = req.query.repoPath as string | undefined
    const resolved = repoPath ? resolveRepoPathInRoot(repoPath) : undefined
    if (repoPath && !resolved) {
      return res.status(400).json({ error: 'Invalid repoPath: must be an existing directory under the configured repos root' })
    }
    res.json({ templates: listLoopTemplates(resolved || undefined) })
  })

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  router.get('/runs', (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
    if (kind && !KINDS.includes(kind as GoalRunKind)) {
      return res.status(400).json({ error: `Invalid kind: ${kind}` })
    }
    if (status && !STATUSES.includes(status as GoalRunStatus)) {
      return res.status(400).json({ error: `Invalid status: ${status}` })
    }
    const runs = store.listRuns({
      kind: kind as GoalRunKind | undefined,
      status: status as GoalRunStatus | undefined,
      limit: limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500) : 50,
    })
    res.json({ runs })
  })

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json({ run: { ...run, turns: store.listTurns(run.id) } })
  })

  router.post('/runs', async (req: Request<Record<string, string>, unknown, StartRunBody>, res) => {
    const { kind, repo, branch, goal } = req.body
    if (!kind || !KINDS.includes(kind as GoalRunKind)) {
      return res.status(400).json({ error: `Missing or invalid kind (expected one of ${KINDS.join(', ')})` })
    }
    if (!repo || !branch) {
      return res.status(400).json({ error: 'Missing required fields: repo, branch' })
    }
    const resolvedRepo = resolveRepoPathInRoot(repo)
    if (!resolvedRepo) {
      return res.status(400).json({ error: 'Invalid repo: must be an existing directory under the configured repos root' })
    }

    const template = loadLoopTemplate(kind as GoalRunKind, resolvedRepo)
    if (!template) return res.status(404).json({ error: `No loop template found for kind: ${kind}` })

    try {
      const input = buildGoalRunInput(template, { repo: resolvedRepo, branch, goal })
      const run = await controller.startRun(input)
      res.json({ run })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start run' })
    }
  })

  router.post('/runs/:id/abort', (req, res) => {
    const aborted = controller.abortRun(req.params.id)
    if (!aborted) return res.status(404).json({ error: 'Run not found or already finished' })
    res.json({ success: true })
  })

  return router
}
