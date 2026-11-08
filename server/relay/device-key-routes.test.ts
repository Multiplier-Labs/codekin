/** Tests for the relay's device key registry and its routes (signed-intents spec §4.2). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { signInFully } from './__fixtures__/auth.js'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { createDeviceKeyRouter } from './device-key-routes.js'
import { listDeviceKeys, upsertDeviceKey } from './device-keys.js'
import { generateMachineKeyPair, keyIdForSpki } from './machine-identity.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'

describe('device key registry', () => {
  let db: Database.Database
  let server: Server
  let base: string
  let alice: string
  let bob: string

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const policy = { ownerGithubId: 1, allowedGithubIds: [2] }
    alice = upsertUserFromGithub(db, { id: 1, login: 'alice', name: null, email: null, avatarUrl: null }, policy).id
    bob = upsertUserFromGithub(db, { id: 2, login: 'bob', name: null, email: null, avatarUrl: null }, policy).id
    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const as = req.headers['x-test-user']
      const id = as === 'alice' ? alice : as === 'bob' ? bob : null
      if (id) {
        req.session.user = { id, login: String(as), displayName: null, avatarUrl: null, status: 'active' }
        signInFully(db, req.session, id)
      }
      next()
    })
    app.use(createDeviceKeyRouter(db, { publicUrl: 'https://relay.test' } as RelayConfig))
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => { resolve(s) }) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device-keys`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  it('records only valid P-256 keys, once per user and key', () => {
    const spki = generateMachineKeyPair().publicKey
    expect(upsertDeviceKey(db, alice, spki, 'Safari · iPhone')).toBe(keyIdForSpki(spki))
    expect(upsertDeviceKey(db, alice, spki, 'Safari · iPhone (renamed)')).toBe(keyIdForSpki(spki))
    expect(upsertDeviceKey(db, alice, 'AAAA', 'bad')).toBeNull()
    expect(listDeviceKeys(db, alice)).toEqual([expect.objectContaining({ label: 'Safari · iPhone (renamed)', spki })])
  })

  it('lists and removes only the caller’s own keys', async () => {
    const mine = upsertDeviceKey(db, alice, generateMachineKeyPair().publicKey, 'Mine')!
    upsertDeviceKey(db, bob, generateMachineKeyPair().publicKey, 'Bob’s')
    expect((await fetch(base)).status).toBe(401)

    const listed = await (await fetch(base, { headers: { 'x-test-user': 'alice' } })).json() as { keys: Array<{ keyId: string }> }
    expect(listed.keys.map(k => k.keyId)).toEqual([mine])

    expect((await fetch(`${base}/${mine}`, { method: 'DELETE', headers: { 'x-test-user': 'bob' } })).status).toBe(404)
    expect((await fetch(`${base}/${mine}`, { method: 'DELETE', headers: { 'x-test-user': 'alice' } })).status).toBe(200)
    expect(listDeviceKeys(db, alice)).toEqual([])
    expect(listAuditEvents(db, { kinds: ['device_key_removed'] })).toHaveLength(1)
  })
})
