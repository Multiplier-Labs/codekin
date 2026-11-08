/** Tests for mint-session: staging-only, and the cookie it prints signs a request in fully. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { listAuditEvents } from './audit.js'
import { mintSession, SESSION_COOKIE } from './relay-admin-cli.js'

const SECRET = 'x'.repeat(40)
const STAGING = { staging: true, sessionSecret: SECRET, publicUrl: 'http://127.0.0.1' }

describe('mint-session', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    upsertUserFromGithub(db, { id: 1, login: 'owner', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    upsertUserFromGithub(db, { id: 2, login: 'tester', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    store = new SqliteSessionStore(db)
    const app = express()
    // The relay's own session settings, so the test proves the cookie is one it accepts.
    app.use(session({ name: SESSION_COOKIE, secret: SECRET, store, resave: false, saveUninitialized: false, rolling: true }))
    app.get('/whoami', createRequireActiveUser(db, { ownerGithubId: 1 }), (req, res) => {
      res.json({ login: req.session.user?.login, authLevel: req.session.authLevel })
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => { resolve() }))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    store.close()
    db.close()
  })

  it('refuses unless the relay is configured as staging', () => {
    expect(() => mintSession(db, { ...STAGING, staging: false }, 2)).toThrow('RELAY_STAGING=1')
    expect(db.prepare('SELECT count(*) AS n FROM web_sessions').get()).toEqual({ n: 0 })
  })

  it('prints a cookie that signs the account in fully, and audits it', async () => {
    const minted = mintSession(db, STAGING, 2)!
    expect(minted.login).toBe('tester')
    expect(minted.cookie.startsWith(`${SESSION_COOKIE}=s%3A`)).toBe(true)
    const res = await fetch(`${baseUrl}/whoami`, { headers: { cookie: minted.cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ login: 'tester', authLevel: 'full' })
    expect(listAuditEvents(db, {}).some(e => e.kind === 'session_minted')).toBe(true)
  })

  it('holds an account that needs 2FA to the same policy as a real sign-in', async () => {
    // The owner must have a second factor; without one, a minted session is
    // sent to enrollment just like a GitHub sign-in would be.
    const minted = mintSession(db, STAGING, 1)!
    const res = await fetch(`${baseUrl}/whoami`, { headers: { cookie: minted.cookie } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'mfa_required', authLevel: 'enrollment_required' })
  })

  it('rejects a tampered cookie, unknown accounts and silly lifetimes', async () => {
    const minted = mintSession(db, STAGING, 2)!
    const tampered = minted.cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))
    expect((await fetch(`${baseUrl}/whoami`, { headers: { cookie: tampered } })).status).toBe(401)
    expect(mintSession(db, STAGING, 999)).toBeNull()
    expect(() => mintSession(db, STAGING, 2, 0)).toThrow('--hours')
    expect(() => mintSession(db, STAGING, 2, 25)).toThrow('--hours')
  })
})
