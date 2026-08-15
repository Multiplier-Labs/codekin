/** Tests for the share REST endpoints: grantee resolution and live revocation. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { createShareRouter } from './share-routes.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { UserRow } from './control-plane-db.js'
import type { BrowserHub } from './browser-hub.js'
import type { SessionShare } from './shares.js'

const POLICY = { ownerGithubId: 1, allowedGithubIds: [2] }

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    login: row.login,
    displayName: null,
    avatarUrl: null,
    role: row.role,
    status: row.status,
  }
}

describe('share routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let owner: UserRow
  let guest: UserRow
  let machineId: string
  const reauthorize = vi.fn()

  beforeEach(async () => {
    reauthorize.mockClear()
    db = openControlPlaneDb(':memory:')
    owner = upsertUserFromGithub(db, { id: 1, login: 'owner', name: null, email: null, avatarUrl: null }, POLICY)
    guest = upsertUserFromGithub(db, { id: 2, login: 'guest', name: null, email: null, avatarUrl: null }, POLICY)

    const { userCode, deviceCode } = startPairing(db, { hostname: 'box', platform: 'linux' })
    approvePairing(db, userCode, owner.id, 'Box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed')
    machineId = complete.machineId

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'owner') req.session.user = toSessionUser(owner)
      next()
    })
    app.use(createShareRouter(db, { reauthorize } as unknown as BrowserHub))
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  const asOwner = { 'x-test-user': 'owner', 'Content-Type': 'application/json' }

  async function createShare(): Promise<SessionShare> {
    const res = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: asOwner,
      body: JSON.stringify({ machineId, localSessionId: 's1', granteeLogin: 'guest', role: 'viewer' }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { share: SessionShare }).share
  }

  it('creates a share for an unambiguous grantee login', async () => {
    const share = await createShare()
    expect(share.granteeUserId).toBe(guest.id)
  })

  it('refuses a grantee login held by more than one account', async () => {
    // A rename left a stale row with the same login as a newer account; a
    // grant must not silently land on whichever row the query returned.
    upsertUserFromGithub(db, { id: 3, login: 'guest', name: null, email: null, avatarUrl: null }, POLICY)
    db.prepare('UPDATE users SET login = ? WHERE github_id = 2').run('guest')

    const res = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: asOwner,
      body: JSON.stringify({ machineId, localSessionId: 's1', granteeLogin: 'guest', role: 'viewer' }),
    })
    expect(res.status).toBe(409)
    const shares = db.prepare('SELECT COUNT(*) AS n FROM session_shares').get() as { n: number }
    expect(shares.n).toBe(0)
  })

  it('revoking a share reauthorizes the grantee immediately', async () => {
    const share = await createShare()
    reauthorize.mockClear()

    const res = await fetch(`${baseUrl}/api/shares/${share.id}`, { method: 'DELETE', headers: asOwner })
    expect(res.status).toBe(200)
    expect(reauthorize).toHaveBeenCalledWith({ userId: guest.id, machineId })
  })

  it('narrowing a share reauthorizes the grantee immediately', async () => {
    const share = await createShare()
    reauthorize.mockClear()

    const res = await fetch(`${baseUrl}/api/shares/${share.id}`, {
      method: 'PATCH',
      headers: asOwner,
      body: JSON.stringify({ permissions: ['view'] }),
    })
    expect(res.status).toBe(200)
    expect(reauthorize).toHaveBeenCalledWith({ userId: guest.id, machineId })
  })
})
