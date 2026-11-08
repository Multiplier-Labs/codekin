/**
 * Relay health probes and the operator's live counters.
 *
 * The probes are public, so they say only whether the relay is up. Counts of
 * machines and browsers are usage data and are served to the operator alone
 * (`/api/admin/stats`). A failing readiness check is named in the log, never
 * in the response.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { getUserById } from './control-plane-db.js'
import { createRequireActiveUser, isOperator } from './relay-auth-routes.js'
import type { RelayConfig } from './relay-config.js'

/** Event-loop lag above this makes the relay report not ready. */
export const MAX_READY_EVENT_LOOP_LAG_MS = 1000

export interface RelayStats {
  machinesOnline: number
  browserClients: number
  channelsOpen: number
  /** Connected machines by connector version (`unknown` when not reported). */
  connectorVersions: Record<string, number>
}

export interface ReadinessProbe {
  /** True while the HTTP server is listening and not shutting down. */
  accepting: () => boolean
  /** Latest event-loop lag sample, in milliseconds. */
  eventLoopLagMs: () => number
}

/**
 * Public probes: `live`, `ready` and the `/api/health` alias of `live`.
 * Mount before the session middleware so a probe never touches the session store.
 */
export function createHealthRouter(db: Database.Database, probe: ReadinessProbe): Router {
  const router = Router()

  const live = (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({ ok: true })
  }
  router.get('/api/health', live)
  router.get('/api/health/live', live)

  router.get('/api/health/ready', (_req, res) => {
    const failed = failedReadinessChecks(db, probe)
    res.set('Cache-Control', 'no-store')
    if (failed.length > 0) {
      console.warn(`[relay] readiness check failed: ${failed.join(', ')}`)
      res.status(503).json({ ok: false })
      return
    }
    res.json({ ok: true })
  })

  return router
}

/** Names of the readiness checks that fail right now (empty when ready). */
export function failedReadinessChecks(db: Database.Database, probe: ReadinessProbe): string[] {
  const failed: string[] = []
  try {
    db.prepare('SELECT 1').get()
  } catch {
    failed.push('database')
  }
  if (!probe.accepting()) failed.push('server')
  const lag = probe.eventLoopLagMs()
  if (lag > MAX_READY_EVENT_LOOP_LAG_MS) failed.push(`event_loop_lag(${Math.round(lag)}ms)`)
  return failed
}

/** `GET /api/admin/stats`: live counters, for the platform operator at full auth level. */
export function createAdminStatsRouter(
  db: Database.Database,
  config: Pick<RelayConfig, 'ownerGithubId'>,
  stats: () => RelayStats,
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)

  router.get('/api/admin/stats', requireActiveUser, (req, res) => {
    const actor = getUserById(db, req.session.user?.id ?? '')
    if (!actor || !isOperator(actor, config)) {
      res.status(403).json({ error: 'Only the platform operator can read relay stats' })
      return
    }
    res.set('Cache-Control', 'no-store').json(stats())
  })

  return router
}

/**
 * Sample event-loop lag as timer drift: a timer due every `intervalMs` that
 * fires late was held up by the loop. The value is the latest sample, so a
 * stall shows up within one interval and clears within one after it ends.
 */
export class EventLoopLagMonitor {
  private lag = 0
  private timer: ReturnType<typeof setInterval>
  private expected: number

  constructor(private intervalMs = 500, private now: () => number = () => performance.now()) {
    this.expected = this.now() + intervalMs
    this.timer = setInterval(() => { this.sample(); }, intervalMs)
    this.timer.unref()
  }

  /** Record one tick. Exposed for tests. */
  sample(): void {
    const t = this.now()
    this.lag = Math.max(0, t - this.expected)
    this.expected = t + this.intervalMs
  }

  get lagMs(): number {
    return this.lag
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
