/** Tests for the operator's account endpoints: auth boundaries, guards, live revocation. */
import { signInFully } from './__fixtures__/auth.js'
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
    db.prepare('INSERT INTO web_sessions (sid, sess, expire, user_id) VALUES (?, ?, ?, ?)').run(
      sid,
      JSON.stringify({ cookie: {}, user: { id: userId } }),
      Date.now() + 86_400_000,
      userId,
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
    // A workspace admin is still not the platform operator.
    db.prepare("UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?").run(adminId)
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
      if (who === 'owner') { req.session.user = sessionUser(db, ownerId); signInFully(db, req.session, req.session.user.id) }
      if (who === 'admin') { req.session.user = sessionUser(db, adminId); signInFully(db, req.session, req.session.user.id) }
      if (who === 'member') { req.session.user = sessionUser(db, memberId); signInFully(db, req.session, req.session.user.id) }
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

  it('forbids anyone but the operator, including workspace admins', async () => {
    for (const who of ['member', 'admin']) {
      expect((await fetch(`${baseUrl}/api/users`, { headers: as(who) })).status).toBe(403)
      expect((await patch(who, memberId, { status: 'disabled' })).status).toBe(403)
    }
    expect(getUserById(db, memberId)!.status).toBe('active')
    // The refusal is audited
    expect(listAuditEvents(db, {}).some(e => e.kind === 'access_denied')).toBe(true)
  })

  it('lists all accounts with an operator flag', async () => {
    const res = await fetch(`${baseUrl}/api/users`, { headers: as('owner') })
    expect(res.status).toBe(200)
    const { users } = (await res.json()) as { users: Array<{ login: string; isOperator: boolean }> }
    expect(users.map(u => u.login).sort()).toEqual(['adminuser', 'member', 'owner'])
    expect(users.find(u => u.login === 'owner')!.isOperator).toBe(true)
    expect(users.find(u => u.login === 'member')!.isOperator).toBe(false)
  })

  it('disables an account and drops their live sockets', async () => {
    const res = await patch('owner', memberId, { status: 'disabled' })
    expect(res.status).toBe(200)
    expect(getUserById(db, memberId)!.status).toBe('disabled')
    expect(reauthorize).toHaveBeenCalledWith({ userId: memberId })

    const event = listAuditEvents(db, {}).find(e => e.kind === 'user_updated')
    expect(event?.actorUserId).toBe(ownerId)
    expect(event?.metadata).toMatchObject({ status: 'disabled', previousStatus: 'active' })
  })

  it('re-enables a disabled account', async () => {
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(memberId)
    const res = await patch('owner', memberId, { status: 'active' })
    expect(res.status).toBe(200)
    expect(getUserById(db, memberId)!.status).toBe('active')
  })

  it('refuses to change the operator account', async () => {
    const res = await patch('owner', ownerId, { status: 'disabled' })
    expect(res.status).toBe(400)
    expect(getUserById(db, ownerId)!.status).toBe('active')
    expect(reauthorize).not.toHaveBeenCalled()
  })

  it('grants and revokes permission to create workspaces', async () => {
    const grant = await patch('owner', memberId, { canCreateWorkspaces: true })
    expect(grant.status).toBe(200)
    expect(((await grant.json()) as { user: { canCreateWorkspaces: boolean } }).user.canCreateWorkspaces).toBe(true)
    expect(getUserById(db, memberId)!.can_create_workspaces).toBe(1)

    expect((await patch('owner', memberId, { canCreateWorkspaces: false })).status).toBe(200)
    expect(getUserById(db, memberId)!.can_create_workspaces).toBe(0)
    expect((await patch('owner', memberId, { canCreateWorkspaces: 'yes' })).status).toBe(400)
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

  it('keeps stored cookies when the change is not a revocation', async () => {
    seedSession('member-a', memberId)
    const res = await patch('owner', memberId, { canCreateWorkspaces: true })
    expect(res.status).toBe(200)
    expect(storedSids()).toEqual(['member-a'])
  })
})
