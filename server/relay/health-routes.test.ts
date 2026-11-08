/** Tests for the relay's public health probes and the operator-only stats endpoint. */
import { signInFully } from './__fixtures__/auth.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, getUserById } from './control-plane-db.js'
import {
  createAdminStatsRouter,
  createHealthRouter,
  EventLoopLagMonitor,
  MAX_READY_EVENT_LOOP_LAG_MS,
} from './health-routes.js'
import type { RelayStats } from './health-routes.js'
import type { RelayConfig } from './relay-config.js'

const CONFIG = { ownerGithubId: 1 } as RelayConfig

const STATS: RelayStats = {
  machinesOnline: 12,
  browserClients: 4,
  channelsOpen: 7,
  connectorVersions: { '0.10.5': 9, unknown: 3 },
}

describe('relay health routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let ownerId: string
  let memberId: string
  let accepting: boolean
  let lagMs: number
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    accepting = true
    lagMs = 0
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db = openControlPlaneDb(':memory:')
    ownerId = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    ).id
    memberId = upsertUserFromGithub(
      db,
      { id: 2, login: 'member', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    ).id
    // A workspace admin is still not the platform operator.
    db.prepare("UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?").run(memberId)

    const app = express()
    app.use(createHealthRouter(db, { accepting: () => accepting, eventLoopLagMs: () => lagMs }))
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const who = req.headers['x-test-user']
      const level = req.headers['x-test-level']
      if (typeof who === 'string') {
        const row = getUserById(db, who)!
        req.session.user = {
          id: row.id, login: row.login, displayName: row.display_name, avatarUrl: row.avatar_url, status: row.status,
        }
        if (level === 'partial') {
          req.session.authLevel = 'mfa_pending'
          req.session.authenticatedAt = Date.now()
          req.session.partialSince = Date.now()
        } else {
          signInFully(db, req.session, who)
        }
      }
      next()
    })
    app.use(createAdminStatsRouter(db, CONFIG, () => STATS))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => { resolve() }))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    warn.mockRestore()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  describe('public probes', () => {
    it.each(['/api/health', '/api/health/live', '/api/health/ready'])('%s returns only ok, no counts', async path => {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ ok: true })
    })

    it('live stays up while ready fails', async () => {
      accepting = false
      expect((await fetch(`${baseUrl}/api/health/live`)).status).toBe(200)
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200)
    })

    it('ready answers 503 without naming the failing check, and logs it', async () => {
      accepting = false
      const res = await fetch(`${baseUrl}/api/health/ready`)
      expect(res.status).toBe(503)
      const body = await res.text()
      expect(JSON.parse(body)).toEqual({ ok: false })
      expect(body).not.toContain('server')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('server'))
    })

    it('ready fails when event-loop lag passes the limit', async () => {
      lagMs = MAX_READY_EVENT_LOOP_LAG_MS + 1
      expect((await fetch(`${baseUrl}/api/health/ready`)).status).toBe(503)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('event_loop_lag'))
      lagMs = MAX_READY_EVENT_LOOP_LAG_MS
      expect((await fetch(`${baseUrl}/api/health/ready`)).status).toBe(200)
    })

    it('ready fails when the database is unusable', async () => {
      db.close()
      expect((await fetch(`${baseUrl}/api/health/ready`)).status).toBe(503)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('database'))
      // Reopen so afterEach can close it.
      db = openControlPlaneDb(':memory:')
    })
  })

  describe('GET /api/admin/stats', () => {
    it('needs a signed-in user', async () => {
      expect((await fetch(`${baseUrl}/api/admin/stats`)).status).toBe(401)
    })

    it('refuses a non-operator, even a workspace admin', async () => {
      const res = await fetch(`${baseUrl}/api/admin/stats`, { headers: { 'x-test-user': memberId } })
      expect(res.status).toBe(403)
    })

    it('refuses the operator before the second factor', async () => {
      const res = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { 'x-test-user': ownerId, 'x-test-level': 'partial' },
      })
      expect(res.status).toBe(401)
    })

    it('gives the operator the live counters', async () => {
      const res = await fetch(`${baseUrl}/api/admin/stats`, { headers: { 'x-test-user': ownerId } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual(STATS)
    })
  })
})

describe('EventLoopLagMonitor', () => {
  it('reports how late the last tick fired and recovers once the loop is free', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor(500, () => now)
    try {
      now = 500
      monitor.sample()
      expect(monitor.lagMs).toBe(0)

      // The next tick was due at 1000 but the loop was blocked until 3000.
      now = 3000
      monitor.sample()
      expect(monitor.lagMs).toBe(2000)

      now = 3500
      monitor.sample()
      expect(monitor.lagMs).toBe(0)
    } finally {
      monitor.stop()
    }
  })
})
