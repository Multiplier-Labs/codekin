/** Tests for GET /api/machines: setup-pending state and lazy orphan sweep. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, listMachines } from './control-plane-db.js'
import { createMachineRouter } from './machine-routes.js'
import { precreatePairing, completePairing } from './pairing.js'
import type { SessionUser } from './relay-auth-routes.js'

interface ListedMachine {
  id: string
  status: string
  setupPending: boolean
  pairingExpiresAt: number | null
}

describe('machine routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let user: SessionUser

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const row = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    user = { id: row.id, login: row.login, displayName: null, avatarUrl: null, role: row.role, status: row.status }

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'active') req.session.user = user
      next()
    })
    app.use(createMachineRouter(db))
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  async function list(): Promise<ListedMachine[]> {
    const res = await fetch(`${baseUrl}/api/machines`, { headers: { 'x-test-user': 'active' } })
    expect(res.status).toBe(200)
    return ((await res.json()) as { machines: ListedMachine[] }).machines
  }

  it('marks an unclaimed install command as setup-pending with its expiry', async () => {
    const pre = precreatePairing(db, user.id)
    const [machine] = await list()
    expect(machine.id).toBe(pre.machineId)
    expect(machine.setupPending).toBe(true)
    expect(machine.pairingExpiresAt).toBe(pre.expiresAt)
  })

  it('a claimed machine is no longer setup-pending', async () => {
    const pre = precreatePairing(db, user.id)
    completePairing(db, pre.pairingToken, { hostname: 'laptop' })
    const [machine] = await list()
    expect(machine.setupPending).toBe(false)
    expect(machine.pairingExpiresAt).toBeNull()
  })

  it('sweeps expired unclaimed machines before listing, but keeps paired ones', async () => {
    const paired = precreatePairing(db, user.id)
    completePairing(db, paired.pairingToken, { hostname: 'laptop' })
    const abandoned = precreatePairing(db, user.id)

    // Only the clock moves: the expired precreate disappears on the next list.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)

    const machines = await list()
    expect(machines.map(m => m.id)).toEqual([paired.machineId])
    expect(listMachines(db).map(m => m.id)).not.toContain(abandoned.machineId)
  })
})
