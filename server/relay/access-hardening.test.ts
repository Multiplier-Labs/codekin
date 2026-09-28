/**
 * Regression tests for the hosted access audit, Phase 0
 * (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md). Each block is the fixed form of a
 * behaviour .codekin/reports/security/2026-09-28_hosted-access-repro.mts
 * reproduced against the pre-fix code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import BetterSqlite3 from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openControlPlaneDb, upsertUserFromGithub, getUserById } from './control-plane-db.js'
import type { UserRow } from './control-plane-db.js'
import { createRelayAuthRouter, createRequireActiveUser, toSessionUser } from './relay-auth-routes.js'
import { createDeviceLinkRouter } from './device-link-routes.js'
import { createShareRouter } from './share-routes.js'
import { createPairingRouter } from './pairing-routes.js'
import { SqliteSessionStore, SESSION_ABSOLUTE_LIFETIME_MS } from './sqlite-session-store.js'
import { BrowserHub } from './browser-hub.js'
import { createMutationOriginGuard } from './origin-guard.js'
import { isExpired, parseShareExpiry, resolveMachineAccess, upsertShare } from './shares.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'

const PUBLIC_URL = 'https://relay.test'
const config = { publicUrl: PUBLIC_URL, ownerGithubId: 1, allowedGithubIds: [2, 3] } as unknown as RelayConfig

class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  closeCode: number | null = null
  send(): void {}
  close(code?: number): void {
    this.closeCode = code ?? 1000
    this.readyState = 3
    this.emit('close')
  }
}

describe('hosted access hardening (Phase 0)', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let hub: BrowserHub
  let server: Server
  let base: string
  let owner: UserRow
  let viewer: UserRow
  let forwarded: number

  const addUser = (id: number) =>
    upsertUserFromGithub(db, { id, login: `user-${id}`, name: null, email: null, avatarUrl: null }, {
      ownerGithubId: 1,
      allowedGithubIds: [2, 3],
    })

  async function call(path: string, opts: { cookie?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
    return fetch(base + path, {
      method: opts.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
  }

  /** Sign in through a test-only route; returns the cookie and the session id. */
  async function login(userId: string): Promise<{ cookie: string; sid: string }> {
    const res = await call(`/test/login/${userId}`)
    const { sid } = (await res.json()) as { sid: string }
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], sid }
  }

  function connectSocket(user: UserRow, sid: string | null): FakeSocket {
    const socket = new FakeSocket()
    hub.handleConnection(socket as never, toSessionUser(user), sid)
    socket.emit('message', JSON.stringify({ version: 1, kind: 'hello', payload: { machineId: 'm1' } }))
    return socket
  }

  function sendRequest(socket: FakeSocket): void {
    socket.emit('message', JSON.stringify({ version: 1, kind: 'request', id: 'r', payload: { method: 'GET', path: '/api/health' } }))
  }

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    store = new SqliteSessionStore(db)
    forwarded = 0
    const connectorStub = {
      isOnline: () => true,
      sendRequest: () => { forwarded++; return Promise.resolve({ response: { status: 200, body: '{}' } }) },
      closeChannel: () => {},
    }
    hub = new BrowserHub(db, connectorStub as never, { isSessionAlive: sid => store.isAlive(sid) })
    owner = addUser(1)
    viewer = addUser(2)
    db.prepare("UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = ?").run(viewer.id)
    viewer = getUserById(db, viewer.id)!
    db.prepare("INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('m1', 'org-default', ?, 'M')").run(owner.id)

    const app = express()
    app.use(express.json())
    app.use(createMutationOriginGuard(PUBLIC_URL))
    app.use(session({ secret: 'test-secret-test-secret-test-secret', store, resave: false, saveUninitialized: false }))
    app.post('/test/login/:id', (req, res) => {
      req.session.user = toSessionUser(getUserById(db, String(req.params.id))!)
      req.session.authenticatedAt = Date.now()
      res.json({ sid: req.sessionID })
    })
    app.get('/test/whoami', createRequireActiveUser(db), (req, res) => { res.json({ user: req.session.user }) })
    app.use(createRelayAuthRouter({
      db, config, store,
      disconnectUser: (id, reason) => { hub.disconnectUser(id, reason) },
      disconnectSession: (sid, reason) => { hub.disconnectSession(sid, reason) },
    }))
    app.use(createDeviceLinkRouter(db, config))
    app.use(createShareRouter(db, hub))
    app.use(createPairingRouter(db, config))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    hub.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    store.close()
    db.close()
  })

  describe('socket lifetime is bound to the web session', () => {
    it('logout closes the sockets that session opened and forwards nothing more', async () => {
      const { cookie, sid } = await login(owner.id)
      const socket = connectSocket(owner, sid)
      expect(hub.clientCount).toBe(1)

      expect((await call('/api/auth/logout', { cookie })).status).toBe(200)
      expect(socket.closeCode).toBe(4003)
      expect(hub.clientCount).toBe(0)
      sendRequest(socket)
      expect(forwarded).toBe(0)
      expect(listAuditEvents(db, {}).map(e => e.kind)).toContain('logout')
    })

    it('logout leaves the same user’s other sessions connected', async () => {
      const first = await login(owner.id)
      const second = await login(owner.id)
      connectSocket(owner, first.sid)
      const other = connectSocket(owner, second.sid)
      await call('/api/auth/logout', { cookie: first.cookie })
      expect(other.closeCode).toBeNull()
      expect(hub.clientCount).toBe(1)
    })

    it('reauthorization drops a socket whose session disappeared from the store', async () => {
      const { sid } = await login(owner.id)
      const socket = connectSocket(owner, sid)
      db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid)
      hub.reauthorize()
      expect(socket.closeCode).toBe(4003)
      sendRequest(socket)
      expect(forwarded).toBe(0)
    })
  })

  describe('logout-all', () => {
    it('revokes device-link codes minted before it', async () => {
      const { cookie } = await login(owner.id)
      const link = (await (await call('/api/auth/device-link/start', { cookie })).json()) as { linkUrl: string }
      expect((await call('/api/auth/logout-all', { cookie })).status).toBe(200)

      const claim = await call('/api/auth/device-link/complete', { body: { code: link.linkUrl.split('#')[1] } })
      expect(claim.status).toBe(404)
      const event = listAuditEvents(db, {}).find(e => e.kind === 'logout_all')
      expect(event?.metadata).toMatchObject({ deviceLinks: 1 })
    })
  })

  describe('share expiry', () => {
    it('rejects malformed and past expiries at creation', async () => {
      addUser(3)
      const { cookie } = await login(owner.id)
      for (const expiresAt of ['not-a-date', '2000-01-01T00:00:00Z', 42]) {
        const res = await call('/api/shares', {
          cookie,
          body: { machineId: 'm1', localSessionId: 's', granteeLogin: 'user-3', role: 'viewer', expiresAt },
        })
        expect(res.status).toBe(400)
      }
    })

    it('normalizes a valid expiry to ISO-8601', () => {
      expect(parseShareExpiry('2999-01-01')).toEqual({ ok: true, value: '2999-01-01T00:00:00.000Z' })
      expect(parseShareExpiry(null)).toEqual({ ok: true, value: null })
      expect(parseShareExpiry(undefined)).toEqual({ ok: true, value: undefined })
    })

    it('treats an unparseable stored expiry as expired', () => {
      const grantee = addUser(3)
      const share = upsertShare(db, {
        machineId: 'm1', localSessionId: 's', sharedByUserId: owner.id,
        granteeUserId: grantee.id, permissions: ['view'], expiresAt: 'not-a-date',
      })
      expect(isExpired(share)).toBe(true)
      expect(resolveMachineAccess(db, grantee, 'm1').kind).toBe('none')
    })
  })

  describe('viewers are read-only', () => {
    it('cannot create a pairing or approve one', async () => {
      const { cookie } = await login(viewer.id)
      expect((await call('/api/machines/pair/precreate', { cookie, body: {} })).status).toBe(403)
      expect((await call('/api/machines/pair/approve', { cookie, body: { code: 'ABCD2345' } })).status).toBe(403)
    })

    it('cannot be granted more than view access', async () => {
      const { cookie } = await login(owner.id)
      const res = await call('/api/shares', {
        cookie,
        body: { machineId: 'm1', localSessionId: 's', granteeLogin: viewer.login, role: 'editor' },
      })
      expect(res.status).toBe(400)
      const ok = await call('/api/shares', {
        cookie,
        body: { machineId: 'm1', localSessionId: 's', granteeLogin: viewer.login, role: 'viewer' },
      })
      expect(ok.status).toBe(201)
    })

    it('has an existing editor grant cut down to view access', () => {
      upsertShare(db, {
        machineId: 'm1', localSessionId: 's', sharedByUserId: owner.id,
        granteeUserId: viewer.id, permissions: ['view', 'view_diff', 'send_prompt', 'approve_shell'],
      })
      const access = resolveMachineAccess(db, viewer, 'm1')
      expect(access).toEqual({ kind: 'grantee', grants: { s: ['view', 'view_diff'] } })
    })
  })

  describe('REST mutation origin guard', () => {
    it('refuses a cross-origin mutation', async () => {
      const { cookie } = await login(owner.id)
      const res = await call('/api/auth/logout', { cookie, headers: { origin: 'https://evil.relay.test' } })
      expect(res.status).toBe(403)
    })

    it('refuses a cross-site fetch without Origin', async () => {
      const res = await call('/api/auth/logout', { headers: { 'sec-fetch-site': 'same-site' } })
      expect(res.status).toBe(403)
    })

    it('allows the app’s own origin and non-browser clients', async () => {
      const { cookie } = await login(owner.id)
      expect((await call('/api/auth/logout', { cookie, headers: { origin: PUBLIC_URL } })).status).toBe(200)
      expect((await call('/api/auth/logout')).status).toBe(200)
    })
  })

  describe('sessions', () => {
    it('/api/me reflects the current role, not the sign-in snapshot', async () => {
      const { cookie } = await login(viewer.id)
      db.prepare("UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?").run(viewer.id)
      const me = (await (await call('/api/me', { cookie, method: 'GET' })).json()) as {
        workspaces: Array<{ role: string }>
      }
      expect(me.workspaces[0].role).toBe('admin')
    })

    it('stores the owning user id, so revocation is an indexed delete', async () => {
      await login(owner.id)
      await login(owner.id)
      await login(viewer.id)
      expect(store.destroyUserSessions(owner.id)).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()).toEqual({ n: 1 })
    })

    it('ends a session past its absolute lifetime even while it keeps rolling', async () => {
      const { cookie, sid } = await login(owner.id)
      const row = db.prepare('SELECT sess FROM web_sessions WHERE sid = ?').get(sid) as { sess: string }
      const sess = JSON.parse(row.sess) as Record<string, unknown>
      sess.authenticatedAt = Date.now() - SESSION_ABSOLUTE_LIFETIME_MS - 1000
      db.prepare('UPDATE web_sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sid)

      expect(store.isAlive(sid)).toBe(false)
      expect((await call('/test/whoami', { cookie, method: 'GET' })).status).toBe(401)
    })

    it('starts the absolute lifetime for a session that predates it', async () => {
      const { cookie, sid } = await login(owner.id)
      const row = db.prepare('SELECT sess FROM web_sessions WHERE sid = ?').get(sid) as { sess: string }
      const sess = JSON.parse(row.sess) as Record<string, unknown>
      delete sess.authenticatedAt
      db.prepare('UPDATE web_sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sid)

      expect((await call('/test/whoami', { cookie, method: 'GET' })).status).toBe(200)
      const after = JSON.parse((db.prepare('SELECT sess FROM web_sessions WHERE sid = ?').get(sid) as { sess: string }).sess) as { authenticatedAt?: number }
      expect(typeof after.authenticatedAt).toBe('number')
    })
  })
})

describe('control-plane migrations', () => {
  it('tracks the schema version and backfills session owners', () => {
    const db = openControlPlaneDb(':memory:')
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    const columns = (db.prepare('PRAGMA table_info(web_sessions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(columns).toContain('user_id')
    db.close()
  })

  it('upgrades a pre-migration database in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-'))
    const path = join(dir, 'control-plane.db')
    const legacy = new BetterSqlite3(path)
    legacy.exec('CREATE TABLE web_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)')
    legacy.prepare('INSERT INTO web_sessions VALUES (?, ?, ?)').run('a', JSON.stringify({ user: { id: 'u1' } }), Date.now() + 1000)
    legacy.prepare('INSERT INTO web_sessions VALUES (?, ?, ?)').run('b', JSON.stringify({ cookie: {} }), Date.now() + 1000)
    legacy.close()

    const db = openControlPlaneDb(path)
    expect(db.prepare('SELECT sid, user_id FROM web_sessions ORDER BY sid').all()).toEqual([
      { sid: 'a', user_id: 'u1' },
      { sid: 'b', user_id: null },
    ])
    db.close()
    // Re-opening is a no-op once the version is recorded.
    const again = openControlPlaneDb(path)
    expect(again.pragma('user_version', { simple: true })).toBe(3)
    again.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
