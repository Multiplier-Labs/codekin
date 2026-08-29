/** Tests for the admin user-management endpoints: auth boundaries, guards, live revocation. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, getUserById } from './control-plane-db.js'
import { createUserRouter } from './user-routes.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { UserRole } from './control-plane-db.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { BrowserHub } from './browser-hub.js'
import { SqliteSessionStore } from './sqlite-session-store.js'

const CONFIG = { ownerGithubId: 1 } as RelayConfig

function sessionUser(db: Database.Database, id: string): SessionUser {
  const row = getUserById(db, id)!
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
  }
}

describe('user admin routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let ownerId: string
  let adminId: string
  let memberId: string
  let store: SqliteSessionStore
  const reauthorize = vi.fn()

  /** Park a stored cookie row for a user, as a real login would. */
  function seedSession(sid: string, userId: string): void {
    db.prepare('INSERT INTO web_sessions (sid, sess, expire) VALUES (?, ?, ?)').run(
      sid,
      JSON.stringify({ cookie: {}, user: { id: userId } }),
      Date.now() + 86_400_000,
    )
  }

  function storedSids(): string[] {
    return (db.prepare('SELECT sid FROM web_sessions ORDER BY sid').all() as Array<{ sid: string }>)
      .map(r => r.sid)
  }

  beforeEach(async () => {
    reauthorize.mockClear()
    db = openControlPlaneDb(':memory:')
    ownerId = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    ).id
    adminId = upsertUserFromGithub(
      db,
      { id: 2, login: 'adminuser', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    ).id
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminId)
    memberId = upsertUserFromGithub(
      db,
      { id: 3, login: 'member', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [3] },
    ).id

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const who = req.headers['x-test-user']
      if (who === 'owner') req.session.user = sessionUser(db, ownerId)
      if (who === 'admin') req.session.user = sessionUser(db, adminId)
      if (who === 'member') req.session.user = sessionUser(db, memberId)
      next()
    })
    store = new SqliteSessionStore(db)
    app.use(createUserRouter(db, CONFIG, { reauthorize } as unknown as BrowserHub, store))
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    store.close()
    db.close()
  })

  function as(who: string): Record<string, string> {
    return { 'x-test-user': who, 'Content-Type': 'application/json' }
  }

  async function patch(who: string, id: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/users/${id}`, {
      method: 'PATCH',
      headers: as(who),
      body: JSON.stringify(body),
    })
  }

  it('requires an authenticated user', async () => {
    expect((await fetch(`${baseUrl}/api/users`)).status).toBe(401)
  })

  it('forbids a non-manager from listing or changing users', async () => {
    expect((await fetch(`${baseUrl}/api/users`, { headers: as('member') })).status).toBe(403)
    const res = await patch('member', ownerId, { status: 'disabled' })
    expect(res.status).toBe(403)
    // The refusal is audited
    expect(listAuditEvents(db, {}).some(e => e.kind === 'access_denied')).toBe(true)
  })

  it('lists all users with an owner flag for the manager', async () => {
    const res = await fetch(`${baseUrl}/api/users`, { headers: as('owner') })
    expect(res.status).toBe(200)
    const { users } = (await res.json()) as { users: Array<{ login: string; isOwner: boolean }> }
    expect(users.map(u => u.login).sort()).toEqual(['adminuser', 'member', 'owner'])
    expect(users.find(u => u.login === 'owner')!.isOwner).toBe(true)
    expect(users.find(u => u.login === 'member')!.isOwner).toBe(false)
  })

  it('disables a member and drops their live sockets', async () => {
    const res = await patch('owner', memberId, { status: 'disabled' })
    expect(res.status).toBe(200)
    expect(getUserById(db, memberId)!.status).toBe('disabled')
    expect(reauthorize).toHaveBeenCalledWith({ userId: memberId })

    const event = listAuditEvents(db, {}).find(e => e.kind === 'user_updated')
    expect(event?.actorUserId).toBe(ownerId)
    expect(event?.metadata).toMatchObject({ status: 'disabled', previousStatus: 'active' })
  })

  it('re-enables a disabled user', async () => {
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(memberId)
    const res = await patch('owner', memberId, { status: 'active' })
    expect(res.status).toBe(200)
    expect(getUserById(db, memberId)!.status).toBe('active')
  })

  it('refuses to change the configured owner account', async () => {
    const res = await patch('admin', ownerId, { status: 'disabled' })
    expect(res.status).toBe(403)
    expect(getUserById(db, ownerId)!.status).toBe('active')
    expect(reauthorize).not.toHaveBeenCalled()
  })

  it('refuses to let a manager change their own access', async () => {
    const res = await patch('admin', adminId, { status: 'disabled' })
    expect(res.status).toBe(400)
    expect(getUserById(db, adminId)!.status).toBe('active')
  })

  it('lets an admin change status but not role', async () => {
    const ok = await patch('admin', memberId, { status: 'disabled' })
    expect(ok.status).toBe(200)

    const denied = await patch('admin', memberId, { role: 'admin' })
    expect(denied.status).toBe(403)
    expect(getUserById(db, memberId)!.role).toBe('member')
  })

  it('lets the owner change a role, but never to owner', async () => {
    const promote = await patch('owner', memberId, { role: 'admin' as UserRole })
    expect(promote.status).toBe(200)
    expect(getUserById(db, memberId)!.role).toBe('admin')

    const toOwner = await patch('owner', memberId, { role: 'owner' })
    expect(toOwner.status).toBe(400)
    expect(getUserById(db, memberId)!.role).toBe('admin')
  })

  it('rejects an unknown status value', async () => {
    const res = await patch('owner', memberId, { status: 'banished' })
    expect(res.status).toBe(400)
  })

  it('404s an unknown user', async () => {
    const res = await patch('owner', 'no-such-user', { status: 'disabled' })
    expect(res.status).toBe(404)
  })

  it('is a no-op that touches no sockets when nothing changes', async () => {
    const res = await patch('owner', memberId, { status: 'active' })
    expect(res.status).toBe(200)
    expect(reauthorize).not.toHaveBeenCalled()
    expect(listAuditEvents(db, {}).some(e => e.kind === 'user_updated')).toBe(false)
  })

  it('destroys the target\'s stored cookies when they lose active status', async () => {
    seedSession('member-a', memberId)
    seedSession('member-b', memberId)
    seedSession('admin-a', adminId)

    const res = await patch('owner', memberId, { status: 'disabled' })
    expect(res.status).toBe(200)

    // Both of the member's cookies are gone; the admin's is untouched.
    expect(storedSids()).toEqual(['admin-a'])
    const event = listAuditEvents(db, {}).find(e => e.kind === 'user_updated')!
    expect((event.metadata as { destroyedSessions: number }).destroyedSessions).toBe(2)
  })

  it('does not revive old cookies when a disabled user is re-activated', async () => {
    seedSession('member-a', memberId)
    expect((await patch('owner', memberId, { status: 'disabled' })).status).toBe(200)
    expect(storedSids()).toEqual([])

    // Re-enabling grants access again, but only to a session established after
    // the fact — the cookies the revocation cut off stay dead.
    expect((await patch('owner', memberId, { status: 'active' })).status).toBe(200)
    expect(getUserById(db, memberId)!.status).toBe('active')
    expect(storedSids()).toEqual([])
  })

  it('keeps stored cookies when the change is a demotion, not a revocation', async () => {
    seedSession('member-a', memberId)
    const res = await patch('owner', memberId, { role: 'viewer' as UserRole })
    expect(res.status).toBe(200)
    // Still active: the account is not revoked, so the session survives.
    expect(storedSids()).toEqual(['member-a'])
  })
})
