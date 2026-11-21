/**
 * Execution API routes, mounted at /api/execution/v1 (docs/EXECUTION-API.md).
 *
 *   GET  /capabilities         harnesses, billing mode, profiles, capacity, limits
 *   POST /jobs                 submit (Idempotency-Key header required)
 *   GET  /jobs/:id[?wait=s]    state; long-polls up to 30 s until terminal
 *   POST /jobs/:id/cancel      idempotent cancellation
 *
 * Only execution-client tokens are accepted here. Jobs are scoped to the
 * client, and to `userRef` when the caller passes `X-Execution-User` — a
 * lookup outside that scope is a 404, never a 403, so IDs reveal nothing.
 * The router parses its own JSON body (prompts exceed the global 100 kB
 * limit) and has its own per-client rate limit instead of the per-IP one.
 * Because it sits before the per-IP limiter, it limits failed token
 * attempts per IP itself.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express'
import type { ExecutionClients, ExecutionClient } from './execution-auth.js'
import { ExecutionInputError, type ExecutionService } from './execution-service.js'
import type { Job } from './execution-store.js'

const MAX_WAIT_S = 30
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 600
/** Failed token attempts per IP per window before every request from it is refused. */
const AUTH_FAIL_MAX = 20
const AUTH_FAIL_MAP_MAX = 10_000

type AuthedRequest = Request & { executionClient?: ExecutionClient }

function clientOf(req: AuthedRequest): ExecutionClient {
  if (!req.executionClient) throw new Error('execution client missing after authentication')
  return req.executionClient
}

/** Public shape of a job: no client-internal fields. */
export function jobView(job: Job): Record<string, unknown> {
  const queueEnd = job.startedAt ?? job.finishedAt
  return {
    id: job.id,
    status: job.status,
    waitReason: job.waitReason,
    workload: job.workload,
    harness: job.harness,
    model: job.model,
    priority: job.priority,
    attempts: job.attempts,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    deadlineAt: job.deadlineAt,
    cancelRequestedAt: job.cancelRequestedAt,
    queueMs: queueEnd ? Date.parse(queueEnd) - Date.parse(job.createdAt) : null,
    execMs: job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : null,
    output: job.status === 'succeeded' ? job.output : null,
    raw: job.raw,
    usage: job.usage,
    error: job.status === 'succeeded' ? null : job.error,
    billingMode: job.billingMode,
    payloadExpired: job.payloadExpired,
  }
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

function sendInputError(res: Response, e: ExecutionInputError): void {
  const status = e.code === 'IDEMPOTENCY_CONFLICT' ? 409 : e.code === 'QUEUE_FULL' ? 429 : 400
  if (status === 429) res.setHeader('Retry-After', '30')
  res.status(status).json({ error: { code: e.code === 'QUEUE_FULL' ? 'RUNTIME_UNAVAILABLE' : e.code, message: e.message, retryable: status === 429 } })
}

export function createExecutionRouter(clients: ExecutionClients, service: ExecutionService): Router {
  const router = Router()
  const buckets = new Map<string, { count: number; resetAt: number }>()
  const authFailures = new Map<string, { count: number; resetAt: number }>()

  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    const now = Date.now()
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const failed = authFailures.get(ip)
    if (failed && now < failed.resetAt && failed.count >= AUTH_FAIL_MAX) {
      // Refused before the token is looked at, so a blocked IP learns nothing about it.
      res.setHeader('Retry-After', String(Math.ceil((failed.resetAt - now) / 1000)))
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many failed authentication attempts', retryable: true } })
      return
    }
    const client = clients.authenticate(bearer(req))
    if (!client) {
      if (!failed || now >= failed.resetAt) {
        if (authFailures.size >= AUTH_FAIL_MAP_MAX) {
          for (const [k, v] of authFailures) if (now >= v.resetAt) authFailures.delete(k)
          if (authFailures.size >= AUTH_FAIL_MAP_MAX) authFailures.clear()
        }
        authFailures.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
      } else {
        failed.count++
      }
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unknown execution client token', retryable: false } })
      return
    }
    const b = buckets.get(client.id)
    if (!b || now >= b.resetAt) buckets.set(client.id, { count: 1, resetAt: now + RATE_WINDOW_MS })
    else if (++b.count > RATE_MAX) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)))
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } })
      return
    }
    req.executionClient = client
    next()
  })

  // Parsed only for authenticated clients.
  router.use(express.json({ limit: '1mb' }))

  router.get('/capabilities', async (req: AuthedRequest, res: Response) => {
    res.json(await service.capabilities(clientOf(req).harnesses))
  })

  router.post('/jobs', (req: AuthedRequest, res: Response) => {
    const client = clientOf(req)
    try {
      const { job, created } = service.submit({
        clientId: client.id,
        allowedHarnesses: client.harnesses,
        clientMaxQueued: client.maxQueued ?? undefined,
        idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
        body: req.body,
      })
      res.status(created ? 202 : 200).json({ job: jobView(job) })
    } catch (e) {
      if (e instanceof ExecutionInputError) sendInputError(res, e)
      else throw e
    }
  })

  const scopedJob = (req: AuthedRequest): Job | null => {
    const user = req.headers['x-execution-user']
    return service.getFor(clientOf(req).id, typeof user === 'string' && user ? user : null, String(req.params.id))
  }

  router.get('/jobs/:id', async (req: AuthedRequest, res: Response) => {
    const job = scopedJob(req)
    if (!job) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such job', retryable: false } })
      return
    }
    const waitS = Math.min(MAX_WAIT_S, Math.max(0, Number(req.query.wait) || 0))
    let latest: Job | null = job
    if (waitS > 0) {
      const ac = new AbortController()
      req.on('close', () => { ac.abort() })
      latest = await service.waitFor(job.id, waitS * 1000, ac.signal)
    }
    if (res.writableEnded || req.destroyed) return
    res.json({ job: jobView(latest ?? job) })
  })

  router.post('/jobs/:id/cancel', (req: AuthedRequest, res: Response) => {
    const job = scopedJob(req)
    if (!job) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such job', retryable: false } })
      return
    }
    res.status(202).json({ job: jobView(service.cancel(job.id) ?? job) })
  })

  return router
}
