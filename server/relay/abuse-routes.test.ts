/** Tests for the operator's abuse review endpoints. */
import { signInFully } from './__fixtures__/auth.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, getUserById, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { createAbuseRouter } from './abuse-routes.js'
import { recordFinding } from './abuse-signals.js'

describe('abuse review routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let operatorId: string
  let memberId: string
  let flagId: string
  const onResolved = vi.fn()

  beforeEach(async () => {
    onResolved.mockClear()
    db = openControlPlaneDb(':memory:')
    operatorId = upsertUserFromGithub(db, { id: 1, login: 'op', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] }).id
    memberId = upsertUserFromGithub(db, { id: 2, login: 'member', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] }).id
    db.prepare(`INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('m1', ?, ?, 'box')`).run(BOOTSTRAP_WORKSPACE_ID, memberId)
    flagId = recordFinding(db, 'm1', { signal: 'largeFrames', action: 'throttle', detail: { frames: 300 } })!

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const who = req.headers['x-test-user']
      if (typeof who === 'string') {
        const row = getUserById(db, who)!
        req.session.user = { id: row.id, login: row.login, displayName: null, avatarUrl: null, status: row.status }
        signInFully(db, req.session, who)
        if (req.headers['x-test-stale'] === '1') req.session.mfaVerifiedAt = Date.now() - 3_600_000
      }
      next()
    })
    app.use(createAbuseRouter(db, { ownerGithubId: 1 }, onResolved))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => { resolve() }))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  const resolve = (as: string, note: unknown, extra: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/admin/abuse-flags/${flagId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': as, ...extra },
      body: JSON.stringify({ note }),
    })

  it('lists open flags for the operator only', async () => {
    expect((await fetch(`${baseUrl}/api/admin/abuse-flags`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/admin/abuse-flags`, { headers: { 'x-test-user': memberId } })).status).toBe(403)
    const res = await fetch(`${baseUrl}/api/admin/abuse-flags`, { headers: { 'x-test-user': operatorId } })
    expect(res.status).toBe(200)
    const { flags } = (await res.json()) as { flags: Array<{ id: string; ownerLogin: string; machineName: string }> }
    expect(flags).toMatchObject([{ id: flagId, ownerLogin: 'member', machineName: 'box' }])
  })

  it('resolves with a note and a fresh second factor, then lifts throttles', async () => {
    expect((await resolve(memberId, 'nope')).status).toBe(403)
    expect((await resolve(operatorId, '  ')).status).toBe(400)
    expect((await resolve(operatorId, 'ok', { 'x-test-stale': '1' })).status).toBe(401)
    expect(onResolved).not.toHaveBeenCalled()

    const res = await resolve(operatorId, 'a backup job; asked them to schedule it at night')
    expect(res.status).toBe(200)
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect((await resolve(operatorId, 'again')).status).toBe(404)
  })
})
