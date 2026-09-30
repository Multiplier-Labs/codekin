/**
 * REST routes for Agent Joe inside repo sessions (see joe-session-bridge.ts).
 *
 * Joe replies into a session, reads its context, and instructs sessions it
 * controls; the user hands a session over to Joe or takes it back. Taking
 * back control is the user's alone, and Joe can only take over on an
 * explicit @Joe request.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { JoeBridgeError, type JoeSessionBridge } from './joe-session-bridge.js'

type VerifyFn = (req: Request) => boolean
type ActorFn = (req: Request) => 'user' | 'joe'

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

export function createJoeSessionRouter(verify: VerifyFn, actorOf: ActorFn, bridge: JoeSessionBridge): Router {
  const router = Router()

  function guard(req: Request, res: Response, only?: 'user' | 'joe'): boolean {
    if (!verify(req)) {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    if (only && actorOf(req) !== only) {
      res.status(403).json({ error: only === 'user' ? 'Only the user can do this' : 'Only Joe can do this' })
      return false
    }
    return true
  }

  function fail(res: Response, err: unknown) {
    if (err instanceof JoeBridgeError) res.status(err.status).json({ error: err.message })
    else res.status(500).json({ error: err instanceof Error ? err.message : 'Request failed' })
  }

  /** The user addresses Joe from a session (REST twin of the ask_joe WS message). */
  router.post('/api/orchestrator/sessions/:id/ask-joe', (req: Request<{ id: string }, unknown, { text?: unknown }>, res) => {
    if (!guard(req, res, 'user')) return
    const body = text(req.body.text, 20_000)
    if (!body) return res.status(400).json({ error: 'text is required' })
    try {
      res.json(bridge.askJoe(req.params.id, body))
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/orchestrator/sessions/:id/joe-reply', (req: Request<{ id: string }, unknown, { text?: unknown; requestId?: unknown; taskId?: unknown }>, res) => {
    if (!guard(req, res, 'joe')) return
    const body = text(req.body.text, 20_000)
    if (!body) return res.status(400).json({ error: 'text is required' })
    try {
      res.json({ message: bridge.reply(req.params.id, body, { requestId: text(req.body.requestId, 200), taskId: text(req.body.taskId, 200) }) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/orchestrator/sessions/:id/context', (req: Request<{ id: string }>, res) => {
    if (!guard(req, res)) return
    const limit = parseInt(String(req.query.limit ?? '10000'), 10) || 10_000
    try {
      res.json(bridge.context(req.params.id, limit))
    } catch (err) {
      fail(res, err)
    }
  })

  router.get('/api/orchestrator/sessions/:id/controller', (req: Request<{ id: string }>, res) => {
    if (!guard(req, res)) return
    try {
      res.json({ controller: bridge.controllerOf(req.params.id) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/orchestrator/sessions/:id/handover', (req: Request<{ id: string }, unknown, { requestId?: unknown; taskId?: unknown }>, res) => {
    if (!guard(req, res)) return
    try {
      res.json({ controller: bridge.handOver(req.params.id, { actor: actorOf(req), requestId: text(req.body.requestId, 200), taskId: text(req.body.taskId, 200) }) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/orchestrator/sessions/:id/take-back', (req: Request<{ id: string }>, res) => {
    if (!guard(req, res, 'user')) return
    try {
      res.json({ controller: bridge.takeBack(req.params.id) })
    } catch (err) {
      fail(res, err)
    }
  })

  router.post('/api/orchestrator/sessions/:id/instruct', (req: Request<{ id: string }, unknown, { text?: unknown; controllerRevision?: unknown }>, res) => {
    if (!guard(req, res, 'joe')) return
    const body = text(req.body.text, 20_000)
    const revision = req.body.controllerRevision
    if (!body || typeof revision !== 'number') return res.status(400).json({ error: 'text and controllerRevision are required' })
    try {
      bridge.sendAsController(req.params.id, body, revision)
      res.json({ ok: true })
    } catch (err) {
      fail(res, err)
    }
  })

  return router
}
