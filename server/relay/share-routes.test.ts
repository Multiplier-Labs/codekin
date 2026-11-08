/** Tests for the share REST endpoints: grantee resolution and live revocation. */
import { signInFully } from './__fixtures__/auth.js'
import { BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { createShareRouter } from './share-routes.js'
import { createHash } from 'crypto'
import { GRANT_ACTION, grantPayload } from './intent-actions.js'
import type { GrantBody } from './intent-actions.js'
import { signedGrantsFor } from './shares.js'
import { upsertDeviceKey } from './device-keys.js'
import { generateMachineKeyPair } from './machine-identity.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { UserRow } from './control-plane-db.js'
import type { BrowserHub } from './browser-hub.js'
import type { SessionShare } from './shares.js'
import type { QuotaLimits } from './quotas.js'

const POLICY = { ownerGithubId: 1, allowedGithubIds: [2] }

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    login: row.login,
    displayName: null,
    avatarUrl: null,
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
  let limits: QuotaLimits = {}

  beforeEach(async () => {
    reauthorize.mockClear()
    limits = {}
    db = openControlPlaneDb(':memory:')
    owner = upsertUserFromGithub(db, { id: 1, login: 'owner', name: null, email: null, avatarUrl: null }, POLICY)
    guest = upsertUserFromGithub(db, { id: 2, login: 'guest', name: null, email: null, avatarUrl: null }, POLICY)

    const { userCode, deviceCode } = startPairing(db, { hostname: 'box', platform: 'linux' })
    approvePairing(db, userCode, owner.id, BOOTSTRAP_WORKSPACE_ID, 'Box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed')
    machineId = complete.machineId

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'owner') { req.session.user = toSessionUser(owner); signInFully(db, req.session, req.session.user.id) }
      next()
    })
    app.use(createShareRouter(db, { reauthorize, refreshGrants: vi.fn() } as unknown as BrowserHub, undefined, { limitsFor: () => limits }))
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

  describe('signed grants (signed-intents spec §6.7)', () => {
    const grantFor = (share: SessionShare, over: Partial<GrantBody> = {}) => {
      const grant: GrantBody = {
        grantId: share.id, sessionId: 's1', granteeUserId: guest.id, permissions: ['view'], granteeKeys: [],
        expiresAt: Date.now() + 24 * 60 * 60_000, ...over,
      }
      const text = JSON.stringify(grant)
      const body = JSON.stringify({
        v: 1, machineId, sessionId: 's1', action: GRANT_ACTION, nonce: 'n'.repeat(22), ts: Date.now(), keyId: 'k',
        payloadHash: createHash('sha256').update(grantPayload(text)).digest('base64url'),
      })
      return { grant: text, intent: { body, sig: 'AAAA' } }
    }
    const put = (shareId: string, payload: unknown, headers = asOwner) =>
      fetch(`${baseUrl}/api/shares/${shareId}/grant`, { method: 'PUT', headers, body: JSON.stringify(payload) })

    it('stores a grant that describes the share, and hands it to the grantee principal', async () => {
      const share = await createShare()
      const signed = grantFor(share)
      const res = await put(share.id, signed)
      expect(res.status).toBe(200)
      const stored = ((await res.json()) as { share: { signedGrant: { expiresAt: number; permissions: string[] } } }).share
      expect(stored.signedGrant?.permissions).toEqual(['view'])
      expect(signedGrantsFor(db, guest.id, machineId)).toEqual([signed])
      expect(signedGrantsFor(db, owner.id, machineId)).toEqual([])
    })

    it('refuses a grant that does not describe the share', async () => {
      const share = await createShare()
      for (const bad of [
        grantFor(share, { grantId: 'other' }),
        grantFor(share, { sessionId: 's2' }),
        grantFor(share, { granteeUserId: owner.id }),
        grantFor(share, { permissions: ['view', 'send_prompt'] }),
        grantFor(share, { expiresAt: Date.now() + 40 * 24 * 60 * 60_000 }),
        { ...grantFor(share), intent: { ...grantFor(share).intent, body: grantFor(share, { permissions: [] }).intent.body } },
      ]) {
        expect((await put(share.id, bad)).status).toBe(400)
      }
      expect(signedGrantsFor(db, guest.id, machineId)).toEqual([])
      // Only the owner who shared can sign.
      expect((await put(share.id, grantFor(share), { 'Content-Type': 'application/json' } as typeof asOwner)).status).toBe(401)
    })

    it('drops the grant when the share permissions change, so the owner signs again', async () => {
      const share = await createShare()
      await put(share.id, grantFor(share))
      const patched = await fetch(`${baseUrl}/api/shares/${share.id}`, { method: 'PATCH', headers: asOwner, body: JSON.stringify({ role: 'viewer' }) })
      expect(patched.status).toBe(200)
      expect(signedGrantsFor(db, guest.id, machineId)).toEqual([])
    })

    it('shows the owner the grantee devices to sign', async () => {
      const share = await createShare()
      const spki = generateMachineKeyPair().publicKey
      upsertDeviceKey(db, guest.id, spki, 'Pixel Chrome')
      const res = await fetch(`${baseUrl}/api/shares/${share.id}/grantee-keys`, { headers: asOwner })
      expect(await res.json()).toEqual({ keys: [expect.objectContaining({ spki, label: 'Pixel Chrome' })] })
    })
  })

  it('creates a share for an unambiguous grantee login', async () => {
    const share = await createShare()
    expect(share.granteeUserId).toBe(guest.id)
  })

  it('caps how many people one session is shared with, but still lets an existing share change', async () => {
    limits = { sharesPerSession: 1 }
    await createShare()
    const third = upsertUserFromGithub(db, { id: 4, login: 'third', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2, 4] })
    expect(third.status).toBe('active')
    const refused = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: asOwner,
      body: JSON.stringify({ machineId, localSessionId: 's1', granteeLogin: 'third', role: 'viewer' }),
    })
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: 'quota_exceeded', quota: 'sharesPerSession', limit: 1 })

    // Re-sharing with the same person updates their share; it takes no new slot.
    await createShare()
  })

  it('refuses a grantee login held by more than one account', async () => {
    // A rename left a stale row with the same login as a newer account; a
    // grant must not silently land on whichever row the query returned.
    const stale = upsertUserFromGithub(db, { id: 3, login: 'guest', name: null, email: null, avatarUrl: null }, POLICY)
    db.prepare(`UPDATE users SET login = ?, status = 'active' WHERE github_id = 2`).run('guest')
    // Both accounts are members, so the workspace-scoped lookup is ambiguous.
    db.prepare(`INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role) VALUES ('org-default', ?, 'member')`).run(stale.id)
    db.prepare(`INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role)
                SELECT 'org-default', id, 'member' FROM users WHERE github_id = 2`).run()

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
