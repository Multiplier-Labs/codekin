/**
 * REST API routes for the workflow engine.
 *
 * Mounted at /api/workflows/ on the Express app. Provides CRUD for
 * runs, schedules, and repo config. All routes require auth.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { getWorkflowEngine } from './workflow-engine.js'
import {
  loadWorkflowConfig,
  addReviewRepo,
  removeReviewRepo,
  updateReviewRepo,
  type ReviewRepoConfig,
} from './workflow-config.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/** Sync cron schedules with the current workflow config. */
export function syncSchedules() {
  const engine = getWorkflowEngine()
  const config = loadWorkflowConfig()
  const existingSchedules = engine.listSchedules()
  const configIds = new Set(config.reviewRepos.map(r => r.id))

  // Create or update schedules for configured repos
  for (const repo of config.reviewRepos) {
    engine.upsertSchedule({
      id: repo.id,
      kind: repo.kind ?? 'code-review.daily',
      cronExpression: repo.cronExpression,
      input: { repoPath: repo.repoPath, repoName: repo.name, customPrompt: repo.customPrompt },
      enabled: repo.enabled,
    })
  }

  // Remove schedules for repos no longer in config
  for (const schedule of existingSchedules) {
    if (!configIds.has(schedule.id)) {
      engine.deleteSchedule(schedule.id)
    }
  }
}

export function createWorkflowRouter(verifyToken: VerifyFn, extractToken: ExtractFn): Router {
  const router = Router()

  /** Auth middleware for all workflow routes. */
  function auth(req: Request, res: Response, next: () => void) {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }

  router.use(auth)

  /** Health check — returns 503 if engine not initialized. */
  function getEngine(res: Response) {
    try {
      return getWorkflowEngine()
    } catch {
      res.status(503).json({ error: 'Workflow engine not available' })
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  router.get('/runs', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const { kind, status, limit, offset } = req.query
    const runs = engine.listRuns({
      kind: kind as string | undefined,
      status: status as 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | undefined,
      limit: limit ? Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 500) : 50,
      offset: offset ? Math.max(parseInt(offset as string, 10) || 0, 0) : 0,
    })
    res.json({ runs })
  })

  router.get('/runs/:runId', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const run = engine.getRun(req.params.runId)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json({ run })
  })

  router.post('/runs', async (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const { kind, input } = req.body
    if (!kind) return res.status(400).json({ error: 'Missing kind' })

    try {
      const run = await engine.startRun(kind, input || {})
      res.json({ run })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start run' })
    }
  })

  router.post('/runs/:runId/cancel', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const canceled = engine.cancelRun(req.params.runId)
    if (!canceled) return res.status(404).json({ error: 'Run not found or not active' })
    res.json({ success: true })
  })

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  router.get('/schedules', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    res.json({ schedules: engine.listSchedules() })
  })

  router.post('/schedules', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const { id, kind, cronExpression, input, enabled } = req.body
    if (!id || !kind || !cronExpression) {
      return res.status(400).json({ error: 'Missing id, kind, or cronExpression' })
    }

    const schedule = engine.upsertSchedule({
      id,
      kind,
      cronExpression,
      input: input || {},
      enabled: enabled !== false,
    })
    res.json({ schedule })
  })

  router.patch('/schedules/:id', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const existing = engine.getSchedule(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Schedule not found' })

    const schedule = engine.upsertSchedule({
      id: existing.id,
      kind: existing.kind,
      cronExpression: req.body.cronExpression ?? existing.cronExpression,
      input: req.body.input ?? existing.input,
      enabled: req.body.enabled ?? existing.enabled,
    })
    res.json({ schedule })
  })

  router.delete('/schedules/:id', (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    const deleted = engine.deleteSchedule(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Schedule not found' })
    res.json({ success: true })
  })

  router.post('/schedules/:id/trigger', async (req, res) => {
    const engine = getEngine(res)
    if (!engine) return

    try {
      const run = await engine.triggerSchedule(req.params.id)
      res.json({ run })
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed to trigger schedule' })
    }
  })

  // -------------------------------------------------------------------------
  // Config (review repos)
  // -------------------------------------------------------------------------

  router.get('/config', (_req, res) => {
    res.json({ config: loadWorkflowConfig() })
  })

  router.post('/config/repos', (req, res) => {
    const { id, name, repoPath, cronExpression, enabled, customPrompt, kind } = req.body as Partial<ReviewRepoConfig>
    if (!id || !name || !repoPath || !cronExpression) {
      return res.status(400).json({ error: 'Missing required fields: id, name, repoPath, cronExpression' })
    }

    const config = addReviewRepo({
      id,
      name,
      repoPath,
      cronExpression,
      enabled: enabled !== false,
      kind,
      customPrompt,
    })

    // Re-sync schedules with updated config
    try {
      syncSchedules()
    } catch {
      // Engine might not be ready yet
    }

    res.json({ config })
  })

  router.patch('/config/repos/:id', (req, res) => {
    try {
      const config = updateReviewRepo(req.params.id, req.body)
      try { syncSchedules() } catch { /* engine may not be ready */ }
      res.json({ config })
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Repo not found' })
    }
  })

  router.delete('/config/repos/:id', (req, res) => {
    const config = removeReviewRepo(req.params.id)

    // Re-sync schedules with updated config
    try {
      syncSchedules()
    } catch {
      // Engine might not be ready yet
    }

    res.json({ config })
  })

  return router
}
