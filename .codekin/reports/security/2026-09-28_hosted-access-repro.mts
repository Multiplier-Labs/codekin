/** Audit-only reproductions of existing behavior, NOT desired regression assertions.
 * Run from repo root: server/node_modules/.bin/tsx .codekin/reports/security/2026-09-28_hosted-access-repro.mts
 * Uses an in-memory DB, synthetic users, loopback HTTP, and a fake browser socket.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { openControlPlaneDb, upsertUserFromGithub, getUserById } from '../../../server/relay/control-plane-db.ts'
import { createRelayAuthRouter, toSessionUser } from '../../../server/relay/relay-auth-routes.ts'
import { createDeviceLinkRouter } from '../../../server/relay/device-link-routes.ts'
import { createShareRouter } from '../../../server/relay/share-routes.ts'
import { createPairingRouter } from '../../../server/relay/pairing-routes.ts'
import { createUserRouter } from '../../../server/relay/user-routes.ts'
import { SqliteSessionStore } from '../../../server/relay/sqlite-session-store.ts'
import { BrowserHub } from '../../../server/relay/browser-hub.ts'
import { resolveMachineAccess, listSharesFor } from '../../../server/relay/shares.ts'

const require = createRequire(new URL('../../../server/package.json', import.meta.url))
const express = require('express')
const session = require('express-session')
const db = openControlPlaneDb(':memory:')
const store = new SqliteSessionStore(db)
const config = { publicUrl: 'https://audit.invalid', ownerGithubId: 1 }
const addUser = (id: number) => upsertUserFromGithub(db,
  { id, login: `audit-${id}`, name: null, email: null, avatarUrl: null },
  { ownerGithubId: 1, allowedGithubIds: [2, 3] })
const owner = addUser(1)
const viewer = addUser(2)
const outsider = addUser(3)
db.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.id)
db.prepare("INSERT INTO organizations (id, name) VALUES ('other', 'Other')").run()
db.prepare("UPDATE users SET organization_id = 'other' WHERE id = ?").run(outsider.id)
db.prepare("INSERT INTO machines (id, organization_id, owner_user_id, display_name) VALUES ('m', 'org-default', ?, 'Audit')").run(owner.id)

let forwarded = 0
const connectorStub = {
  isOnline: () => true,
  sendRequest: async () => { forwarded++; return { response: { status: 200, body: '{}' } } },
  closeChannel: () => {},
}
const hub = new BrowserHub(db, connectorStub as never)
const app = express()
app.use(express.json())
app.use(session({ secret: 'audit-only-secret-not-used-in-production', store, resave: false, saveUninitialized: false }))
// Local fixture route; never installed in the product.
app.post('/fixture/:id', (req: any, res: any) => {
  req.session.user = toSessionUser(getUserById(db, req.params.id)!)
  res.json({ ok: true })
})
app.use(createRelayAuthRouter({ db, config: config as never, store,
  disconnectUser: (id, reason) => hub.disconnectUser(id, reason) }))
app.use(createDeviceLinkRouter(db, config as never))
app.use(createShareRouter(db, hub))
app.use(createPairingRouter(db, config as never))
app.use(createUserRouter(db, config as never, hub, store))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
async function call(path: string, cookie = '', body?: unknown, method = 'POST') {
  return fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function login(id: string) {
  return (await call(`/fixture/${id}`)).headers.get('set-cookie')!.split(';')[0]
}
class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  send() {}
  close() { this.readyState = 3; this.emit('close') }
}
try {
  let cookie = await login(owner.id)
  const socket = new FakeSocket()
  hub.handleConnection(socket as never, toSessionUser(owner))
  socket.emit('message', JSON.stringify({ version: 1, kind: 'hello', payload: { machineId: 'm' } }))
  assert.equal(hub.clientCount, 1)
  assert.equal((await call('/api/auth/logout', cookie)).status, 200)
  hub.reauthorize()
  assert.equal(socket.readyState, 1)
  socket.emit('message', JSON.stringify({ version: 1, kind: 'request', id: 'r', payload: { method: 'GET', path: '/api/health' } }))
  assert.equal(forwarded, 1)
  console.log('CONFIRMED: an established browser socket forwards requests after ordinary logout and reauthorization.')
  socket.close()

  cookie = await login(owner.id)
  const link = await (await call('/api/auth/device-link/start', cookie)).json()
  assert.equal((await call('/api/auth/logout-all', cookie)).status, 200)
  const claim = await call('/api/auth/device-link/complete', '', { code: link.linkUrl.split('#')[1] })
  assert.equal(claim.status, 200)
  assert.equal((await claim.json()).user.id, owner.id)
  console.log('CONFIRMED: an unclaimed device link creates a new authenticated session after logout-all.')

  cookie = await login(owner.id)
  const share = await call('/api/shares', cookie, { machineId: 'm', localSessionId: 's', granteeLogin: outsider.login, role: 'viewer', expiresAt: 'not-a-date' })
  assert.equal(share.status, 201)
  assert.equal(resolveMachineAccess(db, outsider, 'm').kind, 'grantee')
  assert.equal(listSharesFor(db, outsider.id, new Date('2100-01-01')).length, 1)
  console.log('CONFIRMED: cross-organization share accepted; invalid expiry remains valid in year 2100 (synthetic second org).')
  assert.equal((await call(`/api/users/${outsider.id}`, cookie, { status: 'disabled' }, 'PATCH')).status, 200)
  console.log('CONFIRMED: default-org owner can change another organization user (synthetic second org).')

  const viewerCookie = await login(viewer.id)
  const pair = await call('/api/machines/pair/precreate', viewerCookie, { displayName: 'Viewer machine' })
  assert.equal(pair.status, 200)
  const machineId = (await pair.json()).machineId
  assert.equal(resolveMachineAccess(db, getUserById(db, viewer.id)!, machineId).kind, 'owner')
  console.log('CONFIRMED: global viewer can pair a machine and receives unrestricted machine-owner access.')
} finally {
  hub.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(resolve))
  store.close()
  db.close()
}
