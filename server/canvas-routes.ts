/**
 * REST routes the Canvas MCP server calls on an agent's behalf
 * (docs/CANVAS-SPEC.md §1): show an item, revise it, list the session's
 * items. Authenticated with the master token or the session-scoped token the
 * agent's process carries, which only reaches its own session. Not proxied
 * by the relay: only processes on this machine call these.
 *
 * Mounted before the global JSON parser, with a body limit large enough for
 * a 1 MiB item (the default is 100 kB).
 */

import express, { Router } from 'express'
import type { Request } from 'express'
import { CanvasError } from './canvas-store.js'
import type { CanvasPublishInput, CanvasSessions } from './canvas-sessions.js'
import type { CanvasItem } from './types.js'

type ExtractFn = (req: Request) => string | undefined
type VerifySessionFn = (token: string | undefined, sessionId: string | undefined) => boolean

/** What a tool call returns to the agent: enough to revise the item later. */
function describe(item: CanvasItem) {
  return { id: item.id, title: item.title, kind: item.kind, revision: item.latest }
}

/** OpenCode's Canvas tools (opencode-canvas.ts): a shared server, so calls name the OpenCode session. */
export interface OpenCodeCanvasAccess {
  verify: (token: string | undefined) => boolean
  /** The Codekin session an OpenCode session id belongs to. */
  resolve: (openCodeSessionId: string) => string | undefined
}

export function createCanvasRouter(
  extractToken: ExtractFn,
  verifySessionToken: VerifySessionFn,
  canvas: () => CanvasSessions,
  opencode?: OpenCodeCanvasAccess,
): Router {
  const router = Router()
  const json = express.json({ limit: '1536kb' })

  const authorized = (req: Request<{ id: string }>) => verifySessionToken(extractToken(req), req.params.id)

  router.get('/api/sessions/:id/canvas/items', (req: Request<{ id: string }>, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
    const list = canvas().list(req.params.id)
    res.json({ items: list.type === 'canvas_items' ? list.items.map(describe) : [] })
  })

  const publish = (itemId?: string) => async (req: Request<{ id: string; itemId?: string }, unknown, CanvasPublishInput>, res: express.Response) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
    const body: CanvasPublishInput = typeof req.body === 'object' ? req.body : {}
    try {
      const item = await canvas().publish(req.params.id, itemId !== undefined ? { ...body, itemId } : { ...body, itemId: undefined })
      res.json({ item: describe(item) })
    } catch (err) {
      if (err instanceof CanvasError) return res.status(400).json({ error: err.message })
      console.error('[canvas] publish failed', err)
      res.status(500).json({ error: 'The Canvas request failed.' })
    }
  }

  router.post('/api/sessions/:id/canvas/items', json, (req: Request<{ id: string }, unknown, CanvasPublishInput>, res) => {
    void publish()(req, res)
  })
  router.post('/api/sessions/:id/canvas/items/:itemId', json, (req: Request<{ id: string; itemId: string }, unknown, CanvasPublishInput>, res) => {
    void publish(req.params.itemId)(req, res)
  })

  // OpenCode: the token authorizes the tools; the OpenCode session id picks the Codekin session.
  if (opencode) {
    const resolveSession = (req: Request<{ oc: string }>, res: express.Response): string | null => {
      if (!opencode.verify(extractToken(req))) { res.status(401).json({ error: 'Unauthorized' }); return null }
      const sessionId = opencode.resolve(req.params.oc)
      if (!sessionId) { res.status(404).json({ error: 'This OpenCode session is not a Codekin session, so it has no Canvas.' }); return null }
      return sessionId
    }
    router.get('/api/opencode-canvas/:oc/items', (req: Request<{ oc: string }>, res) => {
      const sessionId = resolveSession(req, res)
      if (!sessionId) return
      const list = canvas().list(sessionId)
      res.json({ items: list.type === 'canvas_items' ? list.items.map(describe) : [] })
    })
    const publishFor = async (req: Request<{ oc: string; itemId?: string }, unknown, CanvasPublishInput>, res: express.Response, itemId?: string) => {
      const sessionId = resolveSession(req, res)
      if (!sessionId) return
      const body: CanvasPublishInput = typeof req.body === 'object' ? req.body : {}
      try {
        const item = await canvas().publish(sessionId, { ...body, itemId })
        res.json({ item: describe(item) })
      } catch (err) {
        if (err instanceof CanvasError) return res.status(400).json({ error: err.message })
        console.error('[canvas] OpenCode publish failed', err)
        res.status(500).json({ error: 'The Canvas request failed.' })
      }
    }
    router.post('/api/opencode-canvas/:oc/items', json, (req: Request<{ oc: string }, unknown, CanvasPublishInput>, res) => { void publishFor(req, res) })
    router.post('/api/opencode-canvas/:oc/items/:itemId', json, (req: Request<{ oc: string; itemId: string }, unknown, CanvasPublishInput>, res) => { void publishFor(req, res, req.params.itemId) })
  }

  return router
}
