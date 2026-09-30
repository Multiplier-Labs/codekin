/**
 * Automation management API for Agent Joe's workflow tools
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §10).
 *
 * Mounted under /api/orchestrator/automations and reachable with the user's
 * token or Joe's scoped session token. Backed by the same AutomationService
 * the Automations UI uses, so both see — and conflict-check — the same
 * configuration. Joe's mutations must carry an idempotency key; updates and
 * removals must carry the revision Joe read.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { AutomationError, type AutomationPatch, type AutomationService, type ChangeContext } from './automation-service.js'
import { validateWorkflowDefinition } from './workflow-loader.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

type VerifyFn = (req: Request) => boolean
type ActorFn = (req: Request) => 'user' | 'joe'

interface ChangeFields {
  reason?: string
  authorization?: string
  originSessionId?: string
  taskId?: string
  idempotencyKey?: string
  expectedRevision?: number
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function createAutomationRouter(verify: VerifyFn, actorOf: ActorFn, service: AutomationService): Router {
  const router = Router()
  const base = '/api/orchestrator/automations'

  router.use(base, (req, res, next) => {
    if (!verify(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  function fail(res: Response, err: unknown) {
    if (err instanceof AutomationError) {
      res.status(err.status).json({ error: err.message, ...err.details })
      return
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'Automation request failed' })
  }

  /** Change context from the body; Joe must say why and make retries safe. */
  function contextOf(req: Request, body: ChangeFields, needsRevision: boolean): ChangeContext & { expectedRevision?: number } {
    const actor = actorOf(req)
    const ctx = {
      actor,
      reason: str(body.reason),
      authorization: str(body.authorization),
      originSessionId: str(body.originSessionId),
      taskId: str(body.taskId),
      idempotencyKey: str(body.idempotencyKey),
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
    }
    if (actor === 'joe') {
      if (!ctx.idempotencyKey) throw new AutomationError('idempotencyKey is required', 400)
      if (!ctx.reason) throw new AutomationError('reason is required — say why you are making this change', 400)
      if (needsRevision && ctx.expectedRevision === undefined) {
        throw new AutomationError('expectedRevision is required — pass the revision you read with get_repo_automation', 400)
      }
    }
    return ctx
  }

  // --- workflow definitions -------------------------------------------------

  router.get(`${base}/workflows`, (req, res) => {
    try {
      const workflows = service.listWorkflows(str(req.query.repo))
      // The prompt is long; get_workflow returns it.
      res.json({ workflows: workflows.map(w => ({ ...w, prompt: undefined })) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get(`${base}/workflows/:kind`, (req, res) => {
    try {
      res.json({ workflow: service.getWorkflow(str(req.query.repo), req.params.kind) })
    } catch (err) {
      fail(res, err)
    }
  })

  /**
   * Validate a proposed definition (`content`), or the file currently in a
   * repo (`repo` + `kind`) — e.g. after a child session edited it.
   */
  router.post(`${base}/workflows/validate`, (req: Request<Record<string, string>, unknown, { content?: string; repo?: string; kind?: string; filename?: string }>, res) => {
    const repo = str(req.body.repo)
    if (repo && !service.isValidRepo(repo)) {
      return res.status(400).json({ error: `Invalid repo: ${repo}` })
    }
    let content = typeof req.body.content === 'string' ? req.body.content : undefined
    let filename = str(req.body.filename)
    let source: 'proposed' | 'repo-file' = 'proposed'
    if (content === undefined) {
      const kind = str(req.body.kind)
      if (!repo || !kind) return res.status(400).json({ error: 'Pass content, or repo and kind to validate the repo file' })
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(kind)) return res.status(400).json({ error: `Invalid kind: ${kind}` })
      const path = join(repo, '.codekin', 'workflows', `${kind}.md`)
      if (!existsSync(path)) {
        return res.json({ validation: { valid: false, errors: [`${path} does not exist in the repo checkout runs load from — is the change merged?`], warnings: [], kind, effect: null, hash: null }, path })
      }
      content = readFileSync(path, 'utf-8')
      filename = path
      source = 'repo-file'
    }
    const validation = validateWorkflowDefinition(content, { repoPath: repo, filename })
    let active: boolean | undefined
    if (source === 'repo-file' && validation.kind && repo) {
      // Active means the definition runs would load now matches this file.
      try {
        active = service.getWorkflow(repo, validation.kind).hash === validation.hash
      } catch {
        active = false
      }
    }
    res.json({ validation, source, ...(filename && source === 'repo-file' ? { path: filename } : {}), ...(active !== undefined ? { active } : {}) })
  })

  // --- change history ---------------------------------------------------------

  router.get(`${base}/changes`, (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50
    res.json({ changes: service.changeHistory({ repo: str(req.query.repo), automationId: str(req.query.automationId), limit }) })
  })

  // --- ad-hoc runs ------------------------------------------------------------

  /** Trigger a workflow kind now (trigger_workflow). */
  router.post(`${base}/runs`, async (req: Request<Record<string, string>, unknown, { kind?: string; input?: Record<string, unknown> }>, res) => {
    const kind = str(req.body.kind)
    if (!kind) return res.status(400).json({ error: 'Missing kind' })
    const input = req.body.input ?? {}
    const repoPath = typeof input.repoPath === 'string' ? input.repoPath : undefined
    if (repoPath && !service.isValidRepo(repoPath)) return res.status(400).json({ error: `Invalid repoPath: ${repoPath}` })
    try {
      const run = await service.startAdHocRun(kind, input)
      res.json({ run, link: '/automations' })
    } catch (err) {
      fail(res, err)
    }
  })

  // --- repo automations -------------------------------------------------------

  router.get(base, (req, res) => {
    try {
      res.json({ automations: service.list({ repo: str(req.query.repo) }) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post(base, (req: Request<Record<string, string>, unknown, ChangeFields & { repo?: string; kind?: string; cronExpression?: string; name?: string; enabled?: boolean; customPrompt?: string; model?: string; provider?: string }>, res) => {
    try {
      const repo = str(req.body.repo)
      const kind = str(req.body.kind)
      const cronExpression = str(req.body.cronExpression)
      if (!repo || !kind || !cronExpression) throw new AutomationError('repo, kind and cronExpression are required', 400)
      const ctx = contextOf(req, req.body, false)
      const result = service.create({
        repo,
        kind,
        cronExpression,
        name: str(req.body.name),
        enabled: req.body.enabled,
        customPrompt: str(req.body.customPrompt),
        model: str(req.body.model),
        provider: str(req.body.provider) as never,
      }, ctx, { rejectDuplicates: ctx.actor === 'joe' })
      res.json(result)
    } catch (err) {
      fail(res, err)
    }
  })

  router.get(`${base}/:id`, (req, res) => {
    try {
      res.json({ automation: service.get(req.params.id) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get(`${base}/:id/health`, (req, res) => {
    try {
      res.json({ health: service.health(req.params.id) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get(`${base}/:id/history`, (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '20'), 10) || 20
      res.json(service.triggerHistory(req.params.id, limit))
    } catch (err) {
      fail(res, err)
    }
  })

  router.patch(`${base}/:id`, (req: Request<{ id: string }, unknown, ChangeFields & AutomationPatch>, res) => {
    try {
      const ctx = contextOf(req, req.body, true)
      const { name, kind, cronExpression, enabled, customPrompt, model, provider } = req.body
      res.json(service.update(req.params.id, { name, kind, cronExpression, enabled, customPrompt, model, provider }, ctx))
    } catch (err) {
      fail(res, err)
    }
  })

  router.post(`${base}/:id/remove`, (req: Request<{ id: string }, unknown, ChangeFields>, res) => {
    try {
      res.json(service.remove(req.params.id, contextOf(req, req.body, true)))
    } catch (err) {
      fail(res, err)
    }
  })

  router.post(`${base}/:id/trigger`, async (req, res) => {
    try {
      const run = await service.trigger(req.params.id)
      res.json({ run, link: '/automations' })
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
