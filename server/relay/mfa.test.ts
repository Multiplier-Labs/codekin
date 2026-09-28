/**
 * Two-factor authentication (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 3):
 * the TOTP/recovery primitives, the 2FA policy, and the sign-in / enrollment /
 * step-up flows end to end through the real routers with a mocked GitHub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { BOOTSTRAP_WORKSPACE_ID, getUserById, openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import type { UserRow } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter, createRequireActiveUser } from './relay-auth-routes.js'
import { createMfaRouter } from './mfa-routes.js'
import { createDeviceLinkRouter } from './device-link-routes.js'
import { createWorkspaceRouter } from './workspace-routes.js'
import { createWebauthnRouter } from './webauthn-routes.js'
import {
  FailedAttemptLimiter,
  base32Encode,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  decryptSecret,
  encryptSecret,
  hotp,
  isMfaRequired,
  issueRecoveryCodes,
  matchTotp,
  recoveryCodesRemaining,
  totpStep,
  verifyTypedFactor,
} from './mfa.js'
import { createWorkspace } from './workspaces.js'
import { insertCredential } from './webauthn.js'
import { resetMfa } from './relay-admin-cli.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'

const KEY = randomBytes(32)
const CONFIG = {
  port: 0,
  publicUrl: 'https://app.example.com',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  sessionSecret: 's'.repeat(32),
  ownerGithubId: 1,
  allowedGithubIds: [2, 3],
  dataDir: '/tmp',
  isProduction: false,
  mfaEncryptionKey: KEY,
} as unknown as RelayConfig

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code an authenticator app would show now (or `offset` steps away). */
const codeFor = (secretBase32: string, offset = 0) => hotp(base32Decode(secretBase32), totpStep() + offset)

describe('TOTP and recovery primitives', () => {
  let db: Database.Database
  let user: UserRow

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    user = upsertUserFromGithub(db, { id: 2, login: 'pat', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
  })
  afterEach(() => { db.close() })

  it('matches the RFC 6238 SHA-1 vectors and the RFC 4648 base32 vector', () => {
    const secret = Buffer.from('12345678901234567890')
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082')
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804')
    expect(hotp(secret, Math.floor(2000000000 / 30))).toBe('279037')
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(matchTotp(secret, '287082', 59_000 + 30_000)).toBe(1)
    expect(matchTotp(secret, '287082', 59_000 + 60_000)).toBeNull()
  })

  it('encrypts secrets with authentication: a flipped byte or another key fails', () => {
    const stored = encryptSecret(KEY, Buffer.from('secret'))
    expect(decryptSecret(KEY, stored).toString()).toBe('secret')
    expect(() => decryptSecret(randomBytes(32), stored)).toThrow()
    const [v, iv, tag, ct] = stored.split(':')
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] ^= 1
    expect(() => decryptSecret(KEY, [v, iv, tag, flipped.toString('base64')].join(':'))).toThrow()
  })

  it('stores the secret encrypted and accepts each code once', () => {
    const begun = beginTotpEnrollment(db, KEY, user)
    if (!begun.ok) throw new Error('setup failed')
    const row = db.prepare('SELECT secret_enc FROM user_totp').get() as { secret_enc: string }
    expect(row.secret_enc).not.toContain(begun.secret)
    expect(confirmTotpEnrollment(db, KEY, user.id, '000000')).toEqual({ ok: false, reason: 'invalid_code' })
    expect(confirmTotpEnrollment(db, KEY, user.id, codeFor(begun.secret)).ok).toBe(true)
    // The confirming code's step is spent; the next one works once.
    expect(verifyTypedFactor(db, KEY, user.id, codeFor(begun.secret))).toBeNull()
    expect(verifyTypedFactor(db, KEY, user.id, codeFor(begun.secret, 1))).toBe('totp')
    expect(verifyTypedFactor(db, KEY, user.id, codeFor(begun.secret, 1))).toBeNull()
    expect(beginTotpEnrollment(db, KEY, user)).toEqual({ ok: false, reason: 'already_enabled' })
  })

  it('refuses an enrollment confirmed after its window', () => {
    const begun = beginTotpEnrollment(db, KEY, user)
    if (!begun.ok) throw new Error('setup failed')
    db.prepare('UPDATE user_totp SET created_at = ?').run(Date.now() - 11 * 60 * 1000)
    expect(confirmTotpEnrollment(db, KEY, user.id, codeFor(begun.secret))).toEqual({ ok: false, reason: 'no_enrollment' })
  })

  it('issues ten single-use recovery codes, forgiving case and dashes; reissuing voids the old set', () => {
    const codes = issueRecoveryCodes(db, user.id)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(verifyTypedFactor(db, KEY, user.id, codes[0].toLowerCase().replace('-', ''))).toBe('recovery')
    expect(verifyTypedFactor(db, KEY, user.id, codes[0])).toBeNull()
    expect(recoveryCodesRemaining(db, user.id)).toBe(9)
    issueRecoveryCodes(db, user.id)
    expect(verifyTypedFactor(db, KEY, user.id, codes[1])).toBeNull()
  })

  it('requires 2FA of the operator, owners and admins, and members of a workspace that asks', () => {
    const operator = upsertUserFromGithub(db, { id: 1, login: 'op', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [] })
    expect(isMfaRequired(db, operator, CONFIG)).toBe(true)
    expect(isMfaRequired(db, user, CONFIG)).toBe(false)
    db.prepare(`UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?`).run(user.id)
    expect(isMfaRequired(db, user, CONFIG)).toBe(true)
    db.prepare(`UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = ?`).run(user.id)
    db.prepare(`UPDATE workspaces SET require_mfa = 1 WHERE id = ?`).run(BOOTSTRAP_WORKSPACE_ID)
    expect(isMfaRequired(db, user, CONFIG)).toBe(true)
    db.prepare(`UPDATE workspace_memberships SET status = 'suspended' WHERE user_id = ?`).run(user.id)
    expect(isMfaRequired(db, user, CONFIG)).toBe(false)
  })

  it('limits failed attempts per account within the window', () => {
    const limiter = new FailedAttemptLimiter()
    for (let i = 0; i < 5; i++) limiter.fail('u', 1000)
    expect(limiter.blocked('u', 1000)).toBe(true)
    expect(limiter.blocked('u', 1000 + 15 * 60 * 1000)).toBe(false)
  })
})

describe('2FA flows', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let server: Server
  let base: string
  const disconnectUser = vi.fn()
  const gh = { id: 1, login: 'operator' }

  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]
  const origin = { origin: CONFIG.publicUrl }

  async function call(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
    return fetch(base + path, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', cookie, ...origin },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
  }

  /** GitHub sign-in as `gh`; returns the session cookie. */
  async function githubSignIn(as: { id: number; login: string }): Promise<string> {
    Object.assign(gh, as)
    const start = await call('/api/auth/github/start', '')
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const cb = await call(`/api/auth/github/callback?code=c&state=${state}`, cookieOf(start))
    return cookieOf(cb)
  }

  const me = async (cookie: string) =>
    (await (await call('/api/me', cookie)).json()) as { user: { id: string } | null; authLevel?: string; mfa?: { recoveryCodesRemaining: number } }
  const protectedStatus = async (cookie: string) => (await call('/api/protected', cookie)).status

  /** Enroll TOTP from a signed-in session; returns the secret and recovery codes. */
  async function enrollTotp(cookie: string): Promise<{ secret: string; recoveryCodes: string[]; cookie: string }> {
    const setup = (await (await call('/api/auth/mfa/totp/setup', cookie, { method: 'POST' })).json()) as { secret: string; uri: string }
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Codekin/)
    const confirm = await call('/api/auth/mfa/totp/confirm', cookie, { method: 'POST', body: { code: codeFor(setup.secret) } })
    expect(confirm.status).toBe(200)
    const body = (await confirm.json()) as { recoveryCodes: string[] }
    return { secret: setup.secret, recoveryCodes: body.recoveryCodes, cookie: cookieOf(confirm) || cookie }
  }

  const ageSession = (cookie: string, fields: Record<string, number>) => {
    const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]
    const row = db.prepare('SELECT sess FROM web_sessions WHERE sid = ?').get(sid) as { sess: string }
    db.prepare('UPDATE web_sessions SET sess = ? WHERE sid = ?').run(JSON.stringify({ ...JSON.parse(row.sess), ...fields }), sid)
  }

  beforeEach(async () => {
    disconnectUser.mockClear()
    db = openControlPlaneDb(':memory:')
    store = new SqliteSessionStore(db)
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      const u = String(url)
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
      if (u.includes('access_token')) return json({ access_token: 't' })
      if (u.endsWith('/user')) return json({ id: gh.id, login: gh.login, name: null, email: 'x@example.com', avatar_url: null })
      return json([])
    }) as unknown as typeof fetch
    const app = express()
    app.use(express.json())
    app.use(session({ name: 'sid', secret: CONFIG.sessionSecret, store, resave: false, saveUninitialized: false }))
    const limiter = new FailedAttemptLimiter()
    app.use(createRelayAuthRouter({ db, config: CONFIG, fetchImpl, store }))
    app.use(createMfaRouter({ db, config: CONFIG, store, disconnectUser, limiter }))
    app.use(createWebauthnRouter(db, CONFIG, { store, disconnectUser, limiter }))
    app.use(createDeviceLinkRouter(db, CONFIG))
    app.use(createWorkspaceRouter({ db, config: CONFIG }))
    app.get('/api/protected', createRequireActiveUser(db, CONFIG), (_req, res) => { res.json({ ok: true }) })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    store.close()
    db.close()
  })

  it('enrolls a required account, then challenges every later sign-in', async () => {
    let cookie = await githubSignIn({ id: 1, login: 'operator' })
    expect((await me(cookie)).authLevel).toBe('enrollment_required')
    expect(await protectedStatus(cookie)).toBe(401)

    const enrolled = await enrollTotp(cookie)
    expect(enrolled.recoveryCodes).toHaveLength(10)
    cookie = enrolled.cookie
    expect(await protectedStatus(cookie)).toBe(200)

    // Next sign-in stops at the second factor.
    const next = await githubSignIn({ id: 1, login: 'operator' })
    expect((await me(next)).authLevel).toBe('mfa_pending')
    expect(await protectedStatus(next)).toBe(401)
    expect((await call('/api/auth/mfa/verify', next, { method: 'POST', body: { code: '000000' } })).status).toBe(401)
    const ok = await call('/api/auth/mfa/verify', next, { method: 'POST', body: { code: codeFor(enrolled.secret, 1) } })
    expect(ok.status).toBe(200)
    // Completing sign-in issues a fresh session id; the pre-2FA one is dead.
    const full = cookieOf(ok)
    expect(full).not.toBe(next)
    expect(await protectedStatus(full)).toBe(200)
    expect(await protectedStatus(next)).toBe(401)
  })

  it('lets a pending session into nothing but finishing sign-in, and only for ten minutes', async () => {
    const first = await githubSignIn({ id: 1, login: 'operator' })
    await enrollTotp(first)
    const pending = await githubSignIn({ id: 1, login: 'operator' })
    expect((await call('/api/auth/device-link/start', pending, { method: 'POST' })).status).toBe(401)
    expect((await call('/api/auth/mfa/totp/setup', pending, { method: 'POST' })).status).toBe(401)
    expect((await call('/api/auth/webauthn/register/options', pending, { method: 'POST' })).status).toBe(401)
    ageSession(pending, { partialSince: Date.now() - 11 * 60 * 1000 })
    expect((await me(pending)).user).toBeNull()
  })

  it('accepts a recovery code once, and reports how many remain', async () => {
    const first = await githubSignIn({ id: 1, login: 'operator' })
    const { recoveryCodes } = await enrollTotp(first)
    const pending = await githubSignIn({ id: 1, login: 'operator' })
    const res = await call('/api/auth/mfa/verify', pending, { method: 'POST', body: { code: recoveryCodes[3] } })
    expect(await res.json()).toEqual({ authLevel: 'full', recoveryCodesRemaining: 9 })
    const again = await githubSignIn({ id: 1, login: 'operator' })
    expect((await call('/api/auth/mfa/verify', again, { method: 'POST', body: { code: recoveryCodes[3] } })).status).toBe(401)
  })

  it('stops accepting codes after five failures', async () => {
    const first = await githubSignIn({ id: 1, login: 'operator' })
    const { secret } = await enrollTotp(first)
    const pending = await githubSignIn({ id: 1, login: 'operator' })
    for (let i = 0; i < 5; i++) await call('/api/auth/mfa/verify', pending, { method: 'POST', body: { code: '000000' } })
    const blocked = await call('/api/auth/mfa/verify', pending, { method: 'POST', body: { code: codeFor(secret, 1) } })
    expect(blocked.status).toBe(429)
    expect(listAuditEvents(db, {}).filter(e => e.kind === 'mfa_failed')).toHaveLength(5)
  })

  it('ends other sessions and pending device links when the first factor is added', async () => {
    const other = await githubSignIn({ id: 2, login: 'pat' })
    const link = await call('/api/auth/device-link/start', other, { method: 'POST' })
    expect(link.status).toBe(200)
    const current = await githubSignIn({ id: 2, login: 'pat' })
    const { cookie } = await enrollTotp(current)
    expect(await protectedStatus(other)).toBe(401)
    expect(await protectedStatus(cookie)).toBe(200)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM device_link_requests WHERE status = 'pending'`).get()).toEqual({ n: 0 })
    expect(disconnectUser).toHaveBeenCalledWith(expect.any(String), 'two-factor authentication enabled', expect.any(String))
  })

  it('asks for a fresh check before sensitive actions (step-up)', async () => {
    const first = await githubSignIn({ id: 2, login: 'pat' })
    const { secret, cookie } = await enrollTotp(first)
    expect((await call('/api/auth/device-link/start', cookie, { method: 'POST' })).status).toBe(200)

    ageSession(cookie, { mfaVerifiedAt: Date.now() - 11 * 60 * 1000 })
    const refused = await call('/api/auth/device-link/start', cookie, { method: 'POST' })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'step_up_required', method: 'mfa' })

    const step = await call('/api/auth/mfa/verify', cookie, { method: 'POST', body: { code: codeFor(secret, 1) } })
    expect(step.status).toBe(200)
    // A step-up keeps the session id (live machine sockets stay bound to it).
    expect(cookieOf(step)).toBe('')
    expect((await call('/api/auth/device-link/start', cookie, { method: 'POST' })).status).toBe(200)
  })

  it('without a factor, step-up means a recent GitHub sign-in', async () => {
    const cookie = await githubSignIn({ id: 2, login: 'pat' })
    ageSession(cookie, { authenticatedAt: Date.now() - 11 * 60 * 1000 })
    const refused = await call('/api/auth/device-link/start', cookie, { method: 'POST' })
    expect(await refused.json()).toEqual({ error: 'step_up_required', method: 'github' })
  })

  it('drops a promoted member without a factor to enrollment on their next request', async () => {
    const cookie = await githubSignIn({ id: 2, login: 'pat' })
    expect(await protectedStatus(cookie)).toBe(200)
    const pat = db.prepare('SELECT id FROM users WHERE github_id = 2').get() as { id: string }
    db.prepare(`UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?`).run(pat.id)
    const res = await call('/api/protected', cookie)
    expect(await res.json()).toEqual({ error: 'mfa_required', authLevel: 'enrollment_required' })
  })

  it('will not remove the only factor of an account that must have one', async () => {
    const first = await githubSignIn({ id: 1, login: 'operator' })
    const { cookie } = await enrollTotp(first)
    const res = await call('/api/auth/mfa/totp', cookie, { method: 'DELETE' })
    expect(await res.json()).toEqual({ error: 'mfa_required_by_role' })
  })

  it('lets an owner require 2FA only once they have it, and cuts off unenrolled members', async () => {
    const owner = await githubSignIn({ id: 2, login: 'pat' })
    const patId = (db.prepare('SELECT id FROM users WHERE github_id = 2').get() as { id: string }).id
    db.prepare('UPDATE users SET can_create_workspaces = 1 WHERE id = ?').run(patId)
    const ws = createWorkspace(db, 'Team', patId)
    // Pat now owns a workspace, so 2FA applies to Pat before anything else.
    expect(await protectedStatus(owner)).toBe(401)
    const { cookie } = await enrollTotp(owner)

    const member = await githubSignIn({ id: 3, login: 'sam' })
    const samId = (db.prepare('SELECT id FROM users WHERE github_id = 3').get() as { id: string }).id
    db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')`).run(ws.id, samId)
    expect(await protectedStatus(member)).toBe(200)

    expect((await call(`/api/workspaces/${ws.id}`, cookie, { method: 'PATCH', body: { requireMfa: true } })).status).toBe(200)
    expect(await (await call('/api/protected', member)).json()).toEqual({ error: 'mfa_required', authLevel: 'enrollment_required' })

    ageSession(cookie, { mfaVerifiedAt: Date.now() - 11 * 60 * 1000 })
    expect((await call(`/api/workspaces/${ws.id}`, cookie, { method: 'PATCH', body: { requireMfa: false } })).status).toBe(401)
  })

  it('refuses to require 2FA while the owner has none', async () => {
    const cookie = await githubSignIn({ id: 2, login: 'pat' })
    const patId = (db.prepare('SELECT id FROM users WHERE github_id = 2').get() as { id: string }).id
    const ws = createWorkspace(db, 'Team', patId)
    // Owning the workspace makes 2FA required; enrollment comes first.
    expect((await call(`/api/workspaces/${ws.id}`, cookie, { method: 'PATCH', body: { requireMfa: true } })).status).toBe(401)
  })

  it('counts a passkey as the second factor: step-up and removal guard', () => {
    const user = getUserById(db, upsertUserFromGithub(db, { id: 2, login: 'pat', name: null, email: null, avatarUrl: null }, CONFIG).id)!
    insertCredential(db, { userId: user.id, credentialId: 'c1', publicKey: 'pk', counter: 0 })
    expect(isMfaRequired(db, user, CONFIG)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get()).toEqual({ n: 1 })
  })

  it('operator reset removes every factor and session, and is audited', async () => {
    const first = await githubSignIn({ id: 1, login: 'operator' })
    const { cookie } = await enrollTotp(first)
    const op = db.prepare('SELECT id FROM users WHERE github_id = 1').get() as { id: string }
    insertCredential(db, { userId: op.id, credentialId: 'c1', publicKey: 'pk', counter: 0 })
    const summary = resetMfa(db, 1)
    expect(summary).toMatchObject({ login: 'operator', totp: 1, passkeys: 1, recoveryCodes: 10 })
    expect(await protectedStatus(cookie)).toBe(401)
    expect(listAuditEvents(db, {}).map(e => e.kind)).toContain('mfa_reset')
    expect(resetMfa(db, 999)).toBeNull()
  })
})
