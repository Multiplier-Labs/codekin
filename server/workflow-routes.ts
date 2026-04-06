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
import { listAvailableKinds, ensureRepoWorkflowsRegistered } from './workflow-loader.js'
import { syncCommitHooks } from './commit-event-hooks.js'
import type { CommitEventHandler } from './commit-event-handler.js'
import type { SessionManager } from './session-manager.js'
import { VALID_PROVIDERS } from './types.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/** Validate a 5-field cron expression. Returns true if the format is valid. */
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 6],   // day of week
  ]
  return parts.every((part, i) => {
    const [min, max] = ranges[i]
    return part.split(',').every(segment => {
      const stepMatch = segment.match(/^(.+)\/(\d+)$/)
      const range = stepMatch ? stepMatch[1] : segment
      if (range === '*') return true
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number)
        return !isNaN(a) && !isNaN(b) && a >= min && b <= max && a <= b
      }
      const n = parseInt(range, 10)
      return !isNaN(n) && n >= min && n <= max
    })
  })
}

/**
 * Sync cron schedules with the current workflow config.
 * When `sessions` is provided, also registers any standalone repo workflows.
 * Event-driven repos (cronExpression === 'event') are skipped — they don't use cron.
 */
export function syncSchedules(sessions?: SessionManager) {
  const engine = getWorkflowEngine()
  const config = loadWorkflowConfig()
  const existingSchedules = engine.listSchedules()
  // Build set of repo IDs that should have cron schedules (non-event repos only)
  const scheduledIds = new Set<string>()

  // Create or update schedules for configured repos
  for (const repo of config.reviewRepos) {
    // Register any standalone repo workflows before scheduling
    if (sessions) {
      ensureRepoWorkflowsRegistered(engine, sessions, repo.repoPath)
    }

    // Skip event-driven repos — they are triggered by commit hooks, not cron
    if (repo.cronExpression === 'event') {
      continue
    }

    scheduledIds.add(repo.id)
    engine.upsertSchedule({
      id: repo.id,
      kind: repo.kind ?? 'code-review.daily',
      cronExpression: repo.cronExpression,
      input: { repoPath: repo.repoPath, repoName: repo.name, customPrompt: repo.customPrompt, model: repo.model, provider: repo.provider },
      enabled: repo.enabled,
    })
  }

  // Remove schedules for repos no longer in config OR switched to event-driven
  for (const schedule of existingSchedules) {
    if (!scheduledIds.has(schedule.id)) {
      engine.deleteSchedule(schedule.id)
    }
  }
}

export function createWorkflowRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions?: SessionManager,
  commitEventState?: { handler: CommitEventHandler | undefined },
): Router {
  const router = Router()

  /** Auth middleware for all workflow routes (except commit-event). */
  function auth(req: Request, res: Response, next: () => void) {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }

  // -------------------------------------------------------------------------
  // Commit event (from git post-commit hook)
  // Mounted BEFORE router.use(auth) so it can use its own auth strategy.
  // Currently accepts the master Bearer token (written to hook-config.json
  // by ensureHookConfig). This can later be swapped for an HMAC signature
  // without touching the other routes.
  // -------------------------------------------------------------------------

  router.post('/commit-event', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const handler = commitEventState?.handler
    if (!handler) {
      return res.status(503).json({ error: 'Commit event handler not available' })
    }

    const { repoPath, branch, commitHash, commitMessage, author } = req.body
    if (!repoPath || !branch || !commitHash || !commitMessage) {
      return res.status(400).json({ error: 'Missing required fields: repoPath, branch, commitHash, commitMessage' })
    }

    const result = await handler.handle({
      repoPath,
      branch,
      commitHash,
      commitMessage,
      author: author || 'unknown',
    })

    res.status(result.accepted ? 202 : 200).json(result)
  })

  // Apply master auth to all remaining routes
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
  // Kinds
  // -------------------------------------------------------------------------

  router.get('/kinds', (req, res) => {
    const repoPath = req.query.repoPath as string | undefined
    const kinds = listAvailableKinds(repoPath)
    res.json({ kinds })
  })

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

  router.get('/schedules', (_req, res) => {
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
    if (!isValidCron(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' })
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
    const { id, name, repoPath, cronExpression, enabled, customPrompt, kind, model, provider } = req.body as Partial<ReviewRepoConfig>
    if (!id || !name || !repoPath || !cronExpression) {
      return res.status(400).json({ error: 'Missing required fields: id, name, repoPath, cronExpression' })
    }
    if (provider && !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `Invalid provider: ${provider}` })
    }

    // Register any standalone repo workflows before saving config
    if (sessions) {
      try {
        ensureRepoWorkflowsRegistered(getWorkflowEngine(), sessions, repoPath)
      } catch { /* engine may not be ready */ }
    }

    const config = addReviewRepo({
      id,
      name,
      repoPath,
      cronExpression,
      enabled: enabled !== false,
      kind,
      customPrompt,
      model,
      provider,
    })

    // Re-sync schedules and commit hooks with updated config
    try {
      syncSchedules(sessions)
      syncCommitHooks()
    } catch {
      // Engine might not be ready yet
    }

    res.json({ config })
  })

  router.patch('/config/repos/:id', (req, res) => {
    if (req.body.provider && !VALID_PROVIDERS.has(req.body.provider)) {
      return res.status(400).json({ error: `Invalid provider: ${req.body.provider}` })
    }
    try {
      const config = updateReviewRepo(req.params.id, req.body)
      try {
        syncSchedules(sessions)
        syncCommitHooks()
      } catch { /* engine may not be ready */ }
      res.json({ config })
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Repo not found' })
    }
  })

  router.delete('/config/repos/:id', (req, res) => {
    const config = removeReviewRepo(req.params.id)

    // Re-sync schedules and commit hooks with updated config
    try {
      syncSchedules(sessions)
      syncCommitHooks()
    } catch {
      // Engine might not be ready yet
    }

    res.json({ config })
  })

  return router
}
