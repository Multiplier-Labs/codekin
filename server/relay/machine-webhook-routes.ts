/**
 * GitHub webhooks through the relay (docs/SELF-HOSTED-RELAY.md, "GitHub webhooks").
 *
 * Owner endpoints, cookie-authenticated:
 *   GET    /api/machines/:machineId/webhook   is a receiver on, and when it last delivered
 *   POST   /api/machines/:machineId/webhook   turn on or rotate; returns the URL once
 *   DELETE /api/machines/:machineId/webhook   turn off
 *
 * Public receiver, called by GitHub:
 *   POST   /api/hooks/github/:token
 *
 * The receiver forwards the raw body and the delivery headers to the machine
 * as a `webhook` principal. The connector lets that principal reach only the
 * local webhook route and refuses replays; the local server checks GitHub's
 * HMAC signature, which the relay cannot produce. Mount the receiver before
 * any JSON body parser: the signature covers the exact bytes GitHub sent.
 */

import express, { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getMachine, getUserById } from './control-plane-db.js'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { getActiveMembership } from './workspaces.js'
import { recordAuditEvent } from './audit.js'
import { RateLimiter } from './rate-limit.js'
import { RELAY_ERROR, WEBHOOK_LOCAL_PATH } from './relay-protocol.js'
import type { ProxyRequest } from './relay-protocol.js'
import type { ProxyOutcome } from './connector-proxy.js'
import {
  disableMachineWebhook,
  enableMachineWebhook,
  getMachineWebhook,
  machineForWebhookToken,
  touchWebhookDelivery,
  webhookUrl,
  WEBHOOK_INGRESS_PREFIX,
} from './machine-webhooks.js'
import type { RelayConfig } from './relay-config.js'

/** Same ceiling as the local receiver (server/ws-server.ts). */
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024

/** GitHub gives up after 10 s; answer before it does. */
const FORWARD_TIMEOUT_MS = 9_000

/** Deliveries per machine: bursts happen (a push fans out to many runs), floods do not. */
const PER_MACHINE_LIMIT = { ratePerSecond: 2, burst: 60 }

const REQUIRED_HEADERS = ['x-github-event', 'x-github-delivery', 'x-hub-signature-256'] as const

interface WebhookHub {
  sendRequest(machineId: string, request: ProxyRequest, timeoutMs?: number): Promise<ProxyOutcome>
}

function ownedMachine(db: Database.Database, req: Request, res: Response): string | null {
  const machineId = typeof req.params.machineId === 'string' ? req.params.machineId : ''
  const userId = req.session.user?.id ?? ''
  const machine = getMachine(db, machineId)
  if (!machine) {
    res.status(404).json({ error: 'Machine not found' })
    return null
  }
  // Same rule as removing a machine: only its owner, while still a member of
  // its workspace and not quarantined.
  if (
    machine.owner_user_id !== userId
    || machine.quarantined_at !== null
    || !getActiveMembership(db, machine.workspace_id, userId)
  ) {
    res.status(403).json({ error: 'Only the machine owner can manage its webhook' })
    return null
  }
  return machineId
}

export function createMachineWebhookRouter(
  db: Database.Database,
  config: Pick<RelayConfig, 'publicUrl' | 'ownerGithubId'>,
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)

  router.get('/api/machines/:machineId/webhook', requireActiveUser, (req, res) => {
    const machineId = ownedMachine(db, req, res)
    if (!machineId) return
    res.json(getMachineWebhook(db, machineId))
  })

  router.post('/api/machines/:machineId/webhook', requireActiveUser, (req, res) => {
    const machineId = ownedMachine(db, req, res)
    if (!machineId) return
    const userId = req.session.user?.id ?? ''
    const rotated = getMachineWebhook(db, machineId).enabled
    const token = enableMachineWebhook(db, machineId, userId)
    recordAuditEvent(db, {
      kind: 'machine_webhook_enabled',
      actorUserId: userId,
      machineId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { rotated },
    })
    res.json({ ...getMachineWebhook(db, machineId), url: webhookUrl(config.publicUrl, token) })
  })

  router.delete('/api/machines/:machineId/webhook', requireActiveUser, (req, res) => {
    const machineId = ownedMachine(db, req, res)
    if (!machineId) return
    if (disableMachineWebhook(db, machineId)) {
      recordAuditEvent(db, {
        kind: 'machine_webhook_disabled',
        actorUserId: req.session.user?.id ?? null,
        machineId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      })
    }
    res.json(getMachineWebhook(db, machineId))
  })

  return router
}

/** The public receiver GitHub posts to. */
export function createWebhookIngressRouter(db: Database.Database, hub: WebhookHub): Router & { close(): void } {
  const router = Router() as Router & { close(): void }
  const limiter = new RateLimiter(PER_MACHINE_LIMIT)
  router.close = () => { limiter.close() }

  router.post(
    `${WEBHOOK_INGRESS_PREFIX}:token`,
    express.raw({ type: () => true, limit: MAX_DELIVERY_BYTES }),
    (req, res) => {
      void (async () => {
        const token = typeof req.params.token === 'string' ? req.params.token : ''
        const machineId = machineForWebhookToken(db, token)
        const machine = machineId ? getMachine(db, machineId) : undefined
        const owner = machine ? getUserById(db, machine.owner_user_id) : undefined
        // One answer for "no such receiver" and "receiver not usable", so a
        // token cannot be probed for whether its machine still exists.
        if (
          !machine || !owner || owner.status !== 'active' || machine.quarantined_at !== null
          || !getActiveMembership(db, machine.workspace_id, owner.id)
        ) {
          res.status(404).json({ error: 'Not found' })
          return
        }

        if (!limiter.tryConsume(machine.id)) {
          res.status(429).json({ error: 'Too many deliveries' })
          return
        }
        const contentType = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          res.status(415).json({ error: 'Set the webhook content type to application/json' })
          return
        }
        const headers: Record<string, string> = {}
        for (const name of REQUIRED_HEADERS) {
          const value = req.get(name)
          if (!value) {
            res.status(400).json({ error: `Missing ${name} header` })
            return
          }
          headers[name] = value
        }
        const body = req.body as unknown
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'Empty body' })
          return
        }

        const outcome = await hub.sendRequest(machine.id, {
          method: 'POST',
          path: WEBHOOK_LOCAL_PATH,
          contentType: 'application/json',
          body: body.toString('base64'),
          headers,
          principal: { userId: machine.owner_user_id, role: 'webhook', grants: {} },
        }, FORWARD_TIMEOUT_MS)

        const audit = (result: Record<string, unknown>) => {
          recordAuditEvent(db, {
            kind: 'webhook_delivered',
            machineId: machine.id,
            ip: req.ip ?? null,
            userAgent: req.get('user-agent') ?? null,
            metadata: { event: headers['x-github-event'], delivery: headers['x-github-delivery'], ...result },
          })
        }

        if ('error' in outcome) {
          audit({ error: outcome.error.code })
          const status = outcome.error.code === RELAY_ERROR.machineOffline ? 503
            : outcome.error.code === RELAY_ERROR.timeout ? 504
              : outcome.error.code === RELAY_ERROR.notPermitted ? 403
                : 502
          res.status(status).json({ error: outcome.error.code, message: outcome.error.message })
          return
        }

        touchWebhookDelivery(db, machine.id)
        audit({ status: outcome.response.status })
        const responseType = outcome.response.headers['content-type'] ?? 'application/json'
        res.status(outcome.response.status).type(responseType)
        res.send(outcome.response.body ? Buffer.from(outcome.response.body, 'base64') : '')
      })().catch((err: unknown) => {
        console.error('[relay] webhook forward failed:', err)
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
      })
    },
  )

  // Body-parser failures on this route (too large, aborted) answer GitHub
  // directly rather than falling through to the app's generic 500.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity
  router.use(WEBHOOK_INGRESS_PREFIX, (err: { status?: number; type?: string }, _req: Request, res: Response, _next: () => void) => {
    const status = err.type === 'entity.too.large' ? 413 : (err.status ?? 400)
    res.status(status).json({ error: status === 413 ? 'Delivery too large' : 'Bad delivery' })
  })

  return router
}
