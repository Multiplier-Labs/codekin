/**
 * Tests for the WebAuthn REST endpoints: auth boundaries, challenge
 * lifecycle, and the user-status checks around login. The cryptographic
 * ceremony itself is @simplewebauthn/server's, exercised here only to the
 * point of rejection — producing a valid attestation requires an
 * authenticator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { createWebauthnRouter } from './webauthn-routes.js'
import { insertCredential, listPasskeys } from './webauthn.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { SessionUser } from './relay-auth-routes.js'

const CONFIG = {
  publicUrl: 'https://app.example.com',
} as RelayConfig

describe('webauthn routes', () => {
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
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'active') req.session.user = activeUser
      next()
    })
    app.use(createWebauthnRouter(db, CONFIG))
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

  it('registration endpoints and passkey management require an active user', async () => {
    for (const path of ['/api/auth/webauthn/register/options', '/api/auth/webauthn/register/verify']) {
      expect((await fetch(`${baseUrl}${path}`, { method: 'POST', headers: anon })).status).toBe(401)
    }
    expect((await fetch(`${baseUrl}/api/auth/passkeys`, { headers: anon })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/auth/passkeys/x`, { method: 'DELETE', headers: anon })).status).toBe(401)
  })

  it('registration options carry the RP derived from PUBLIC_URL and known credentials to exclude', async () => {
    insertCredential(db, { userId: activeUser.id, credentialId: 'existing', publicKey: 'pk', counter: 0 })
    const res = await fetch(`${baseUrl}/api/auth/webauthn/register/options`, { method: 'POST', headers: asUser })
    expect(res.status).toBe(200)
    const { options } = await res.json() as {
      options: { rp: { id: string }; challenge: string; excludeCredentials?: Array<{ id: string }> }
    }
    expect(options.rp.id).toBe('app.example.com')
    expect(options.challenge.length).toBeGreaterThan(10)
    expect(options.excludeCredentials?.map(c => c.id)).toContain('existing')
  })

  it('register verify without pending options is a 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers: asUser, body: JSON.stringify({ response: { id: 'x' } }),
    })
    expect(res.status).toBe(400)
  })

  it('a forged registration response is rejected, and the challenge is single-use', async () => {
    const optionsRes = await fetch(`${baseUrl}/api/auth/webauthn/register/options`, { method: 'POST', headers: asUser })
    const cookie = optionsRes.headers.get('set-cookie')!.split(';')[0]
    const headers = { ...asUser, cookie }

    const verifyRes = await fetch(`${baseUrl}/api/auth/webauthn/register/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        response: {
          id: 'forged', rawId: 'forged', type: 'public-key',
          response: { clientDataJSON: 'e30', attestationObject: 'e30' },
          clientExtensionResults: {},
        },
      }),
    })
    expect(verifyRes.status).toBe(400)
    expect(listPasskeys(db, activeUser.id)).toHaveLength(0)

    // The failed attempt consumed the challenge
    const retry = await fetch(`${baseUrl}/api/auth/webauthn/register/verify`, {
      method: 'POST', headers, body: JSON.stringify({ response: { id: 'forged' } }),
    })
    expect((await retry.json() as { error: string }).error).toBe('No registration in progress')
  })

  it('login options are anonymous and leave the credential choice to the authenticator', async () => {
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/options`, { method: 'POST', headers: anon })
    expect(res.status).toBe(200)
    const { options } = await res.json() as {
      options: { rpId: string; challenge: string; allowCredentials?: unknown[]; userVerification: string }
    }
    expect(options.rpId).toBe('app.example.com')
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials ?? []).toHaveLength(0)
    // The anonymous challenge session is real: a cookie must come back
    expect(res.headers.get('set-cookie')).toBeTruthy()
  })

  it('login verify without pending options is a 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: anon, body: JSON.stringify({ response: { id: 'x' } }),
    })
    expect(res.status).toBe(400)
  })

  async function loginChallengeCookie(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/options`, { method: 'POST', headers: anon })
    return res.headers.get('set-cookie')!.split(';')[0]
  }

  function assertionBody(id: string): string {
    return JSON.stringify({
      response: {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' },
        clientExtensionResults: {},
      },
    })
  }

  it('login verify with an unknown credential is a 401', async () => {
    const cookie = await loginChallengeCookie()
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { ...anon, cookie }, body: assertionBody('unknown'),
    })
    expect(res.status).toBe(401)
  })

  it('login verify for a disabled user is a 403 before any crypto runs', async () => {
    insertCredential(db, { userId: activeUser.id, credentialId: 'cred-1', publicKey: 'pk', counter: 0 })
    db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(activeUser.id)
    const cookie = await loginChallengeCookie()
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { ...anon, cookie }, body: assertionBody('cred-1'),
    })
    expect(res.status).toBe(403)
  })

  it('a forged assertion for a real credential is a 401 and mints no session', async () => {
    insertCredential(db, { userId: activeUser.id, credentialId: 'cred-1', publicKey: 'cGs', counter: 0 })
    const cookie = await loginChallengeCookie()
    const res = await fetch(`${baseUrl}/api/auth/webauthn/login/verify`, {
      method: 'POST', headers: { ...anon, cookie }, body: assertionBody('cred-1'),
    })
    expect(res.status).toBe(401)
    expect(listAuditEvents(db, {}).map(e => e.kind)).not.toContain('passkey_login')
  })

  it('lists and deletes own passkeys, with audit', async () => {
    const passkey = insertCredential(db, {
      userId: activeUser.id, credentialId: 'cred-1', publicKey: 'pk', counter: 0, label: 'Phone',
    })

    const listRes = await fetch(`${baseUrl}/api/auth/passkeys`, { headers: asUser })
    const { passkeys } = await listRes.json() as { passkeys: Array<{ id: string; label: string | null }> }
    expect(passkeys).toEqual([expect.objectContaining({ id: passkey.id, label: 'Phone' })])

    const delRes = await fetch(`${baseUrl}/api/auth/passkeys/${passkey.id}`, { method: 'DELETE', headers: asUser })
    expect(delRes.status).toBe(200)
    expect(listPasskeys(db, activeUser.id)).toHaveLength(0)
    expect(listAuditEvents(db, {}).map(e => e.kind)).toContain('passkey_removed')
  })

  it("cannot delete another user's passkey", async () => {
    const other = upsertUserFromGithub(
      db,
      { id: 2, login: 'member', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    )
    const passkey = insertCredential(db, { userId: other.id, credentialId: 'cred-2', publicKey: 'pk', counter: 0 })
    const res = await fetch(`${baseUrl}/api/auth/passkeys/${passkey.id}`, { method: 'DELETE', headers: asUser })
    expect(res.status).toBe(404)
    expect(listPasskeys(db, other.id)).toHaveLength(1)
  })
})
