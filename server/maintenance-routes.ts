/**
 * REST API for explicit repo maintenance (see maintenance-service.ts).
 *
 * Mounted under /api/orchestrator/maintenance; reachable with the user's
 * token or Joe's scoped token. The service decides what each actor may do —
 * Joe proposes and may pause; the user enables, resumes and turns off.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { MaintenanceError, type MaintenanceService } from './maintenance-service.js'
import { RESPONSE_POLICIES, type ResponsePolicy, type ResponsibilityInput } from './maintenance-store.js'

type VerifyFn = (req: Request) => boolean
type ActorFn = (req: Request) => 'user' | 'joe'

function str(value: unknown, max = 2000): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined
}

function revisionOf(body: Record<string, unknown>): number | undefined {
  return typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
}

/** Parse a responsibility body; `partial` allows omitting fields for updates. */
function parseResponsibility(body: Record<string, unknown>, partial: boolean): Partial<ResponsibilityInput> | string {
  const out: Partial<ResponsibilityInput> = {}
  if (body.name !== undefined) {
    const name = str(body.name, 200)
    if (!name) return 'name must be 1–200 characters'
    out.name = name
  } else if (!partial) return 'name is required'
  if (body.scope !== undefined) out.scope = typeof body.scope === 'string' ? body.scope.slice(0, 500) : ''
  else if (!partial) out.scope = ''
  if (body.automationIds !== undefined) {
    if (!Array.isArray(body.automationIds) || !body.automationIds.every(id => typeof id === 'string')) return 'automationIds must be a list of automation ids'
    out.automationIds = body.automationIds
  } else if (!partial) return 'automationIds is required'
  if (body.policy !== undefined) {
    if (!RESPONSE_POLICIES.includes(body.policy as ResponsePolicy)) return `policy must be one of ${RESPONSE_POLICIES.join(', ')}`
    out.policy = body.policy as ResponsePolicy
  } else if (!partial) return 'policy is required'
  if (body.maxActiveTasks !== undefined) {
    if (typeof body.maxActiveTasks !== 'number') return 'maxActiveTasks must be a number'
    out.maxActiveTasks = body.maxActiveTasks
  }
  if (body.requiredDecision !== undefined) out.requiredDecision = typeof body.requiredDecision === 'string' ? body.requiredDecision.slice(0, 500) : ''
  if (body.enabled !== undefined) out.enabled = body.enabled === true
  return out
}

export function createMaintenanceRouter(
  verify: VerifyFn,
  actorOf: ActorFn,
  service: MaintenanceService,
  isValidRepo: (repo: string) => boolean,
): Router {
  const router = Router()
  const base = '/api/orchestrator/maintenance'

  router.use(base, (req, res, next) => {
    if (!verify(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  function fail(res: Response, err: unknown) {
    if (err instanceof MaintenanceError) res.status(err.status).json({ error: err.message })
    else res.status(500).json({ error: err instanceof Error ? err.message : 'Maintenance request failed' })
  }

  function repoFrom(value: unknown, res: Response): string | null {
    const repo = str(value, 4096)
    if (!repo || !isValidRepo(repo)) {
      res.status(400).json({ error: 'Invalid repo: must be an existing directory under the configured repos root' })
      return null
    }
    return repo
  }

  /** Every repo with a plan: state, health label, counts. */
  router.get(base, (_req, res) => {
    try {
      res.json({ repos: service.list() })
    } catch (err) {
      fail(res, err)
    }
  })

  /** One repo's plan, responsibilities with their checks, and recent activity. */
  router.get(`${base}/plan`, (req, res) => {
    const repo = repoFrom(req.query.repo, res)
    if (!repo) return
    try {
      const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50
      res.json({ plan: service.get(repo), activity: service.activity(repo, limit) })
    } catch (err) {
      fail(res, err)
    }
  })

  const stateAction = (path: string, run: (repo: string, req: Request, body: Record<string, unknown>) => unknown) => {
    router.post(`${base}/${path}`, (req: Request<Record<string, string>, unknown, Record<string, unknown>>, res) => {
      const body = req.body
      const repo = repoFrom(body.repo, res)
      if (!repo) return
      try {
        res.json({ plan: run(repo, req, body) })
      } catch (err) {
        fail(res, err)
      }
    })
  }

  stateAction('enable', (repo, req, body) => service.enable(repo, actorOf(req), {
    expectedRevision: revisionOf(body),
    adoptAutomationIds: Array.isArray(body.adoptAutomationIds) ? body.adoptAutomationIds.filter((id): id is string => typeof id === 'string') : [],
  }))
  stateAction('pause', (repo, req, body) => service.pause(repo, actorOf(req), { expectedRevision: revisionOf(body) }))
  stateAction('resume', (repo, req, body) => service.resume(repo, actorOf(req), { expectedRevision: revisionOf(body) }))
  stateAction('off', (repo, req, body) => service.turnOff(repo, actorOf(req), { expectedRevision: revisionOf(body) }))

  router.post(`${base}/responsibilities`, (req: Request<Record<string, string>, unknown, Record<string, unknown>>, res) => {
    const repo = repoFrom(req.body.repo, res)
    if (!repo) return
    const parsed = parseResponsibility(req.body, false)
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed })
    try {
      res.json({ responsibility: service.addResponsibility(repo, parsed as ResponsibilityInput, actorOf(req)) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.patch(`${base}/responsibilities/:id`, (req: Request<{ id: string }, unknown, Record<string, unknown>>, res) => {
    const parsed = parseResponsibility(req.body, true)
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed })
    try {
      res.json({ responsibility: service.updateResponsibility(req.params.id, parsed, actorOf(req)) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post(`${base}/responsibilities/:id/remove`, (req: Request<{ id: string }>, res) => {
    try {
      service.removeResponsibility(req.params.id, actorOf(req))
      res.json({ ok: true })
    } catch (err) {
      fail(res, err)
    }
  })

  /** Hand an adopted automation back to independent management. */
  router.post(`${base}/release`, (req: Request<Record<string, string>, unknown, { automationId?: unknown }>, res) => {
    const automationId = str(req.body.automationId, 200)
    if (!automationId) return res.status(400).json({ error: 'automationId is required' })
    try {
      service.release(automationId, actorOf(req))
      res.json({ ok: true })
    } catch (err) {
      fail(res, err)
    }
  })

  /** Joe records a triage outcome or action for a responsibility. */
  router.post(`${base}/activity`, (req: Request<Record<string, string>, unknown, Record<string, unknown>>, res) => {
    const repo = repoFrom(req.body.repo, res)
    if (!repo) return
    const kind = req.body.kind
    const summary = str(req.body.summary)
    if (kind !== 'finding' && kind !== 'check_ok' && kind !== 'action') return res.status(400).json({ error: 'kind must be finding, check_ok or action' })
    if (!summary) return res.status(400).json({ error: 'summary is required' })
    try {
      res.json({ activity: service.recordActivity(repo, { responsibilityId: str(req.body.responsibilityId, 200), kind, summary, ref: str(req.body.ref, 300) }) })
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
