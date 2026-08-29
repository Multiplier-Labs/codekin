/** Tests for the device-link REST endpoints (auth boundaries + session minting). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { createDeviceLinkRouter } from './device-link-routes.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { SessionUser } from './relay-auth-routes.js'

const CONFIG = {
  publicUrl: 'https://app.example.com',
} as RelayConfig

describe('device link routes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let activeUser: SessionUser

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const row = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    activeUser = {
      id: row.id,
      login: row.login,
      displayName: null,
      avatarUrl: null,
      role: row.role,
      status: row.status,
    }

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    // Test hook: mark the session as the active user when the header is set
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'active') req.session.user = activeUser
      next()
    })
    app.use(createDeviceLinkRouter(db, CONFIG))
    // Exposes what the session cookie resolves to, like /api/me would
    app.get('/whoami', (req, res) => {
      res.json({ user: req.session.user ?? null })
    })
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

  async function startLink(): Promise<{ requestId: string; linkUrl: string; expiresAt: number }> {
    const res = await fetch(`${baseUrl}/api/auth/device-link/start`, {
      method: 'POST',
      headers: asUser,
    })
    expect(res.status).toBe(200)
    return res.json() as Promise<{ requestId: string; linkUrl: string; expiresAt: number }>
  }

  /** The code as the scanning device reads it: the URL fragment. */
  function codeFromLinkUrl(linkUrl: string): string {
    expect(linkUrl).toMatch(/^https:\/\/app\.example\.com\/link#/)
    return linkUrl.split('#')[1]
  }

  it('start and status require an active user', async () => {
    expect((await fetch(`${baseUrl}/api/auth/device-link/start`, { method: 'POST', headers: anon })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/auth/device-link/x/status`, { headers: anon })).status).toBe(401)
  })

  it('full flow: start → complete mints a session for the new device', async () => {
    const { requestId, linkUrl } = await startLink()

    const completeRes = await fetch(`${baseUrl}/api/auth/device-link/complete`, {
      method: 'POST',
      headers: anon,
      body: JSON.stringify({ code: codeFromLinkUrl(linkUrl) }),
    })
    expect(completeRes.status).toBe(200)
    const { user } = await completeRes.json() as { user: SessionUser }
    expect(user.id).toBe(activeUser.id)

    // The Set-Cookie from complete is a working session on its own
    const cookie = completeRes.headers.get('set-cookie')
    expect(cookie).toBeTruthy()
    const whoami = await fetch(`${baseUrl}/whoami`, {
      headers: { cookie: cookie!.split(';')[0] },
    })
    const identity = await whoami.json() as { user: SessionUser | null }
    expect(identity.user?.id).toBe(activeUser.id)

    // The desktop's polling dialog sees the claim
    const statusRes = await fetch(`${baseUrl}/api/auth/device-link/${requestId}/status`, { headers: asUser })
    expect(await statusRes.json()).toEqual({ status: 'claimed' })

    const kinds = listAuditEvents(db, {}).map(e => e.kind)
    expect(kinds).toContain('device_link_created')
    expect(kinds).toContain('device_linked')
  })

  it('a replayed code cannot mint a second session', async () => {
    const { linkUrl } = await startLink()
    const code = codeFromLinkUrl(linkUrl)
    const body = JSON.stringify({ code })
    expect((await fetch(`${baseUrl}/api/auth/device-link/complete`, { method: 'POST', headers: anon, body })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/auth/device-link/complete`, { method: 'POST', headers: anon, body })).status).toBe(404)
  })

  it('refuses codes minted by a user who has since been disabled', async () => {
    const { linkUrl } = await startLink()
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(activeUser.id)

    const res = await fetch(`${baseUrl}/api/auth/device-link/complete`, {
      method: 'POST',
      headers: anon,
      body: JSON.stringify({ code: codeFromLinkUrl(linkUrl) }),
    })
    expect(res.status).toBe(403)
  })

  it('unknown codes 404, missing codes 400', async () => {
    expect(
      (await fetch(`${baseUrl}/api/auth/device-link/complete`, {
        method: 'POST', headers: anon, body: JSON.stringify({ code: 'nope' }),
      })).status,
    ).toBe(404)
    expect(
      (await fetch(`${baseUrl}/api/auth/device-link/complete`, {
        method: 'POST', headers: anon, body: JSON.stringify({}),
      })).status,
    ).toBe(400)
  })

  it("another user's status poll cannot see the request", async () => {
    const { requestId } = await startLink()
    const other = upsertUserFromGithub(
      db,
      { id: 2, login: 'member', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    )
    activeUser = { ...activeUser, id: other.id, login: other.login }
    const res = await fetch(`${baseUrl}/api/auth/device-link/${requestId}/status`, { headers: asUser })
    expect(res.status).toBe(404)
  })
})
