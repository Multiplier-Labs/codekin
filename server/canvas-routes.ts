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

export function createCanvasRouter(
  extractToken: ExtractFn,
  verifySessionToken: VerifySessionFn,
  canvas: () => CanvasSessions,
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

  return router
}
