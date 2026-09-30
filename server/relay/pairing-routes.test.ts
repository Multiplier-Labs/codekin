/** Tests for the pairing REST endpoints (auth boundaries + status codes). */
import { signInFully } from './__fixtures__/auth.js'
import { BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, listMachines } from './control-plane-db.js'
import { createPairingRouter } from './pairing-routes.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { ConnectorHub } from './connector-hub.js'
import type { BrowserHub } from './browser-hub.js'

const CONFIG = {
  publicUrl: 'https://app.example.com',
} as RelayConfig

describe('pairing routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let activeUser: SessionUser
  let otherUser: SessionUser
  const disconnectMachine = vi.fn()
  const reauthorize = vi.fn()

  beforeEach(async () => {
    disconnectMachine.mockClear()
    reauthorize.mockClear()
    db = openControlPlaneDb(':memory:')
    const row = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    activeUser = {
      id: row.id,
      login: row.login,
      displayName: null,
      avatarUrl: null,
      status: row.status,
    }

    // A second active member, to stand in for a share grantee: someone who
    // is signed in and allowed, but owns none of the machines.
    const otherRow = upsertUserFromGithub(
      db,
      { id: 2, login: 'grantee', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    )
    otherUser = {
      id: otherRow.id,
      login: otherRow.login,
      displayName: null,
      avatarUrl: null,
      status: otherRow.status,
    }

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    // Test hook: mark the session as the active user when the header is set
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'active') { req.session.user = activeUser; signInFully(db, req.session, req.session.user.id) }
      if (req.headers['x-test-user'] === 'other') { req.session.user = otherUser; signInFully(db, req.session, req.session.user.id) }
      next()
    })
    app.use(
      createPairingRouter(db, CONFIG, {
        connectorHub: { disconnectMachine } as unknown as ConnectorHub,
        browserHub: { reauthorize } as unknown as BrowserHub,
      }),
    )
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

  const asUser = { 'x-test-user': 'active', 'Content-Type': 'application/json' }
  const anon = { 'Content-Type': 'application/json' }

  async function startRequest(): Promise<{ userCode: string; deviceCode: string; verificationUrl: string }> {
    const res = await fetch(`${baseUrl}/api/machines/pair/start`, {
      method: 'POST',
      headers: anon,
      body: JSON.stringify({ hostname: 'devbox', platform: 'linux' }),
    })
    expect(res.status).toBe(200)
    return res.json() as Promise<{ userCode: string; deviceCode: string; verificationUrl: string }>
  }

  it('start is unauthenticated and returns codes plus the verification url', async () => {
    const data = await startRequest()
    expect(data.verificationUrl).toBe(
      `https://app.example.com/pair?code=${encodeURIComponent(data.userCode)}`,
    )
  })

  it('info/approve/deny require an active user', async () => {
    const { userCode } = await startRequest()
    expect((await fetch(`${baseUrl}/api/machines/pair/info?code=${userCode}`)).status).toBe(401)
    expect(
      (await fetch(`${baseUrl}/api/machines/pair/approve`, {
        method: 'POST', headers: anon, body: JSON.stringify({ code: userCode }),
      })).status,
    ).toBe(401)
    expect(
      (await fetch(`${baseUrl}/api/machines/pair/deny`, {
        method: 'POST', headers: anon, body: JSON.stringify({ code: userCode }),
      })).status,
    ).toBe(401)
  })

  it('full flow: start → info → approve → complete → delete machine', async () => {
    const { userCode, deviceCode } = await startRequest()

    const infoRes = await fetch(`${baseUrl}/api/machines/pair/info?code=${userCode}`, { headers: asUser })
    expect(infoRes.status).toBe(200)
    const info = await infoRes.json() as { request: { hostname: string; status: string } }
    expect(info.request.hostname).toBe('devbox')
    expect(info.request.status).toBe('pending')

    // Device polls before approval → 202
    const early = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode }),
    })
    expect(early.status).toBe(202)

    const approveRes = await fetch(`${baseUrl}/api/machines/pair/approve`, {
      method: 'POST', headers: asUser, body: JSON.stringify({ code: userCode, displayName: 'Dev box' }),
    })
    expect(approveRes.status).toBe(200)

    const completeRes = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode }),
    })
    expect(completeRes.status).toBe(200)
    const complete = await completeRes.json() as { machineId: string; machineSecret: string }
    expect(complete.machineSecret.length).toBeGreaterThan(20)

    const deleteRes = await fetch(`${baseUrl}/api/machines/${complete.machineId}`, {
      method: 'DELETE', headers: asUser,
    })
    expect(deleteRes.status).toBe(200)
  })

  it('denied flow returns 403 to the polling device', async () => {
    const { userCode, deviceCode } = await startRequest()
    await fetch(`${baseUrl}/api/machines/pair/deny`, {
      method: 'POST', headers: asUser, body: JSON.stringify({ code: userCode }),
    })
    const res = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode }),
    })
    expect(res.status).toBe(403)
  })

  /** Pair a machine to the owning user and return its id. */
  async function pairMachine(): Promise<string> {
    const { userCode, deviceCode } = await startRequest()
    await fetch(`${baseUrl}/api/machines/pair/approve`, {
      method: 'POST', headers: asUser, body: JSON.stringify({ code: userCode, displayName: 'Dev box' }),
    })
    const completeRes = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode }),
    })
    const complete = await completeRes.json() as { machineId: string }
    return complete.machineId
  }

  it('refuses to delete a machine the caller does not own', async () => {
    const machineId = await pairMachine()

    const res = await fetch(`${baseUrl}/api/machines/${machineId}`, {
      method: 'DELETE', headers: { 'x-test-user': 'other' },
    })

    expect(res.status).toBe(403)
    // The machine must survive the attempt
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(1)

    const denied = listAuditEvents(db, {}).find(e => e.kind === 'access_denied')
    expect(denied?.actorUserId).toBe(otherUser.id)
    expect(denied?.machineId).toBe(machineId)
  })

  it('records an audit event when the owner deletes their machine', async () => {
    const machineId = await pairMachine()

    const res = await fetch(`${baseUrl}/api/machines/${machineId}`, {
      method: 'DELETE', headers: asUser,
    })

    expect(res.status).toBe(200)
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(0)

    const removed = listAuditEvents(db, {}).find(e => e.kind === 'machine_removed')
    expect(removed?.actorUserId).toBe(activeUser.id)
    expect(removed?.machineId).toBe(machineId)
  })

  it('deleting a machine drops its live connector and browser sockets', async () => {
    const machineId = await pairMachine()

    await fetch(`${baseUrl}/api/machines/${machineId}`, { method: 'DELETE', headers: asUser })

    expect(disconnectMachine).toHaveBeenCalledWith(machineId)
    expect(reauthorize).toHaveBeenCalledWith({ machineId })
  })

  it('a refused machine deletion touches no live sockets', async () => {
    const machineId = await pairMachine()

    await fetch(`${baseUrl}/api/machines/${machineId}`, {
      method: 'DELETE', headers: { 'x-test-user': 'other' },
    })

    expect(disconnectMachine).not.toHaveBeenCalled()
    expect(reauthorize).not.toHaveBeenCalled()
  })

  it('deleting an unknown machine is a 404, not a 403', async () => {
    const res = await fetch(`${baseUrl}/api/machines/does-not-exist`, {
      method: 'DELETE', headers: asUser,
    })
    expect(res.status).toBe(404)
  })

  async function precreate(
    body: Record<string, unknown> = {},
    headers: Record<string, string> = asUser,
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/machines/pair/precreate`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
  }

  it('precreate requires an active user and records an audit event', async () => {
    expect((await precreate({}, anon)).status).toBe(401)

    const res = await precreate()
    expect(res.status).toBe(200)
    const data = await res.json() as { machineId: string; pairingToken: string; expiresAt: number }
    const created = listAuditEvents(db, {}).find(e => e.kind === 'machine_pairing_created')
    expect(created?.actorUserId).toBe(activeUser.id)
    expect(created?.machineId).toBe(data.machineId)
    // The secret itself is never written to the audit trail
    expect(JSON.stringify(created)).not.toContain(data.pairingToken)
  })

  it('precreate with replaceMachineId discards the old pending machine and its token', async () => {
    const first = await (await precreate()).json() as { machineId: string; pairingToken: string }
    const res = await precreate({ replaceMachineId: first.machineId })
    expect(res.status).toBe(200)
    const second = await res.json() as { machineId: string }

    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID).map(m => m.id)).toEqual([second.machineId])
    const stale = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode: first.pairingToken }),
    })
    expect(stale.status).toBe(410)
    const events = listAuditEvents(db, {})
    expect(events.find(e => e.kind === 'machine_removed')?.machineId).toBe(first.machineId)
    expect(events.find(e => e.kind === 'machine_pairing_created' && e.machineId === second.machineId)?.metadata)
      .toEqual({ replacedMachineId: first.machineId })
  })

  it('precreate refuses to replace a machine that has been paired', async () => {
    const machineId = await pairMachine()
    const res = await precreate({ replaceMachineId: machineId })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'machine_already_paired' })
    // Nothing was created or removed
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID).map(m => m.id)).toEqual([machineId])
  })

  it("precreate treats someone else's or an unknown machine id as not found", async () => {
    const theirs = await (await precreate({}, { ...asUser, 'x-test-user': 'other' })).json() as { machineId: string }
    const res = await precreate({ replaceMachineId: theirs.machineId })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'machine_not_found' })
    expect((await precreate({ replaceMachineId: 'nope' })).status).toBe(404)
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID).map(m => m.id)).toEqual([theirs.machineId])
    expect((await precreate({ replaceMachineId: 42 })).status).toBe(400)
  })

  it('unknown codes 404', async () => {
    expect((await fetch(`${baseUrl}/api/machines/pair/info?code=XXXX-YYYY`, { headers: asUser })).status).toBe(404)
    const res = await fetch(`${baseUrl}/api/machines/pair/complete`, {
      method: 'POST', headers: anon, body: JSON.stringify({ deviceCode: 'nope' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('pairing routes: precreate rate limit', () => {
  it('limits precreate per signed-in user, not globally', async () => {
    const db = openControlPlaneDb(':memory:')
    const users = [1, 2].map(id => {
      const row = upsertUserFromGithub(
        db,
        { id, login: `u${id}`, name: null, email: null, avatarUrl: null },
        { ownerGithubId: 1, allowedGithubIds: [2] },
      )
      return { id: row.id, login: row.login, displayName: null, avatarUrl: null, status: row.status }
    })
    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const idx = Number(req.headers['x-test-user'])
      if (users[idx]) { req.session.user = users[idx]; signInFully(db, req.session, req.session.user.id) }
      next()
    })
    app.use(createPairingRouter(db, CONFIG, {}, { precreateLimit: { limit: 2, windowMs: 60_000 } }))
    const server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => { resolve(s) })
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/machines/pair/precreate`
    const call = (user: number) => fetch(url, {
      method: 'POST', headers: { 'x-test-user': String(user), 'Content-Type': 'application/json' }, body: '{}',
    }).then(r => r.status)

    try {
      expect([await call(0), await call(0), await call(0)]).toEqual([200, 200, 429])
      // A different user has their own budget
      expect(await call(1)).toBe(200)
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      db.close()
    }
  })
})
