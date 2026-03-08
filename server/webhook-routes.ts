/**
 * REST routes for webhook and stepflow event management.
 *
 * Mounted at the Express app root (routes carry their own /api/ prefixes).
 * Note: the actual webhook receiver endpoints (/api/webhooks/github and
 * /api/webhooks/stepflow) remain in ws-server.ts because they require raw
 * body parsing before express.json() runs.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { WebhookHandler } from './webhook-handler.js'
import type { StepflowHandler } from './stepflow-handler.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createWebhookRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  webhookHandler: WebhookHandler,
  stepflowHandler: StepflowHandler,
): Router {
  const router = Router()

  // --- Webhook management endpoints ---

  router.get('/api/webhooks/events', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ events: webhookHandler.getEvents() })
  })

  router.get('/api/webhooks/events/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const event = webhookHandler.getEvent(req.params.id)
    if (event) {
      res.json({ event })
    } else {
      res.status(404).json({ error: 'Event not found' })
    }
  })

  router.get('/api/webhooks/config', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ config: webhookHandler.getConfig() })
  })

  // --- Stepflow management endpoints ---

  router.get('/api/stepflow/events', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ events: stepflowHandler.getEvents() })
  })

  router.get('/api/stepflow/events/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const event = stepflowHandler.getEvent(req.params.id)
    if (event) {
      res.json({ event })
    } else {
      res.status(404).json({ error: 'Event not found' })
    }
  })

  return router
}
