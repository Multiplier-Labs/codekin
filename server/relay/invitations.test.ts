/**
 * Workspace invitations (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 2):
 * issuing and managing them, and accepting through the real GitHub OAuth
 * callback against a mocked GitHub — including the negative cases the plan
 * requires (wrong recipient, expired, revoked, replayed, inviter lost rights).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { BOOTSTRAP_WORKSPACE_ID, getUserById, openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import type { UserRow } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter } from './relay-auth-routes.js'
import { createInvitationRouter } from './invitation-routes.js'
import { acceptInvitation, createInvitation } from './invitations.js'
import { createWorkspace, getActiveMembership } from './workspaces.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'

const CONFIG = {
  port: 0,
  publicUrl: 'https://app.example.com',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  sessionSecret: 's'.repeat(32),
  ownerGithubId: 1,
  allowedGithubIds: [],
  dataDir: '/tmp',
  isProduction: false,
} as unknown as RelayConfig

interface GithubPersona {
  id: number
  login: string
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>
}

/** Mocked GitHub: token exchange, profile, emails, and public user lookup. */
function githubMock(state: { signIn: GithubPersona; directory: Record<string, number> }) {
  return vi.fn((url: RequestInfo | URL) => {
    const u = String(url)
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    if (u.includes('login/oauth/access_token')) return json({ access_token: 'gh-token' })
    if (u.endsWith('/user')) return json({ id: state.signIn.id, login: state.signIn.login, name: null, email: null, avatar_url: null })
    if (u.endsWith('/user/emails')) return json(state.signIn.emails ?? [])
    const lookup = /\/users\/([^/]+)$/.exec(u)
    if (lookup) {
      const login = decodeURIComponent(lookup[1])
      const id = state.directory[login.toLowerCase()]
      return id === undefined ? json({ message: 'Not Found' }, 404) : json({ id, login, type: 'User' })
    }
    return Promise.reject(new Error(`Unexpected URL: ${u}`))
  }) as unknown as typeof fetch
}

describe('workspace invitations', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let server: Server
  let base: string
  let owner: UserRow
  let admin: UserRow
  let member: UserRow
  const gh = { signIn: { id: 0, login: '' } as GithubPersona, directory: {} as Record<string, number> }

  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]

  async function call(path: string, opts: { as?: UserRow; method?: string; body?: unknown; cookie?: string } = {}) {
    return fetch(base + path, {
      method: opts.method ?? 'GET',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.as ? { 'x-test-user': opts.as.id } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
  }

  async function invite(body: Record<string, unknown>, as: UserRow = owner, workspaceId = BOOTSTRAP_WORKSPACE_ID) {
    const res = await call(`/api/workspaces/${workspaceId}/invitations`, { as, method: 'POST', body })
    return { res, data: (await res.json()) as { inviteUrl?: string; invitation?: { id: string }; error?: string } }
  }
  const tokenOf = (url: string) => url.split('#')[1]

  /** The landing page's path: prepare, then the GitHub round trip. Returns the callback redirect. */
  async function acceptAs(persona: GithubPersona, token: string): Promise<{ location: string; cookie: string }> {
    gh.signIn = persona
    const prepared = await call('/api/invitations/prepare', { method: 'POST', body: { token } })
    if (prepared.status !== 200) return { location: `prepare:${prepared.status}`, cookie: '' }
    const cookie = cookieOf(prepared)
    const startRes = await call('/api/auth/github/start', { cookie })
    const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const cb = await call(`/api/auth/github/callback?code=c&state=${state}`, { cookie })
    return { location: cb.headers.get('location') ?? '', cookie: cookieOf(cb) }
  }

  const addUser = (id: number, login: string) =>
    upsertUserFromGithub(db, { id, login, name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2, 3] })

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    store = new SqliteSessionStore(db)
    owner = addUser(1, 'owner')
    admin = addUser(2, 'admin')
    member = addUser(3, 'member')
    db.prepare(`UPDATE workspace_memberships SET role = 'admin' WHERE user_id = ?`).run(admin.id)
    gh.directory = { newbie: 100, stranger: 200, member: 3 }

    const app = express()
    app.use(express.json())
    app.use(session({ name: 'sid', secret: 's'.repeat(32), store, resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const id = req.headers['x-test-user']
      if (typeof id === 'string') {
        const row = getUserById(db, id)!
        req.session.user = { id: row.id, login: row.login, displayName: null, avatarUrl: null, status: row.status }
      }
      next()
    })
    const fetchImpl = githubMock(gh)
    app.use(createRelayAuthRouter({ db, config: CONFIG, fetchImpl, store }))
    app.use(createInvitationRouter({ db, config: CONFIG, fetchImpl }))
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

  describe('issuing', () => {
    it('issues a GitHub-bound link, resolving the username to its immutable id', async () => {
      const { res, data } = await invite({ githubLogin: '@Newbie', role: 'member' })
      expect(res.status).toBe(201)
      expect(data.inviteUrl).toMatch(/^https:\/\/app\.example\.com\/invite#[A-Za-z0-9_-]{43}$/)
      const row = db.prepare('SELECT invitee_github_id, token_hash FROM workspace_invitations').get() as {
        invitee_github_id: number
        token_hash: string
      }
      expect(row.invitee_github_id).toBe(100)
      expect(row.token_hash).not.toContain(tokenOf(data.inviteUrl!))
    })

    it('refuses members, admin-invites-admin, unknown users, existing members and bad input', async () => {
      expect((await invite({ githubLogin: 'newbie', role: 'member' }, member)).res.status).toBe(403)
      expect((await invite({ githubLogin: 'newbie', role: 'admin' }, admin)).res.status).toBe(403)
      expect((await invite({ githubLogin: 'newbie', role: 'owner' })).res.status).toBe(400)
      expect((await invite({ githubLogin: 'ghost', role: 'member' })).data.error).toBe('github_user_not_found')
      expect((await invite({ githubLogin: 'member', role: 'member' })).data.error).toBe('already_member')
      expect((await invite({ email: 'not-an-email', role: 'member' })).data.error).toBe('invalid_email')
      expect((await invite({ email: 'a@b.co', githubLogin: 'newbie', role: 'member' })).res.status).toBe(400)
      expect((await invite({ githubLogin: 'newbie', role: 'member' }, owner, 'no-such-ws')).res.status).toBe(404)
    })

    it('keeps one live link per recipient, lists pending ones, and resends with a new token', async () => {
      const first = await invite({ email: 'Pat@Example.com', role: 'viewer' })
      const second = await invite({ email: 'pat@example.com', role: 'member' })
      const list = (await (await call(`/api/workspaces/${BOOTSTRAP_WORKSPACE_ID}/invitations`, { as: admin })).json()) as {
        invitations: Array<{ id: string; role: string; email: string }>
      }
      expect(list.invitations).toEqual([expect.objectContaining({ id: second.data.invitation!.id, role: 'member', email: 'pat@example.com' })])

      const resent = await call(`/api/workspaces/${BOOTSTRAP_WORKSPACE_ID}/invitations/${second.data.invitation!.id}/resend`, { as: owner, method: 'POST' })
      const resentUrl = ((await resent.json()) as { inviteUrl: string }).inviteUrl
      expect(resentUrl).not.toBe(second.data.inviteUrl)
      for (const stale of [first.data.inviteUrl!, second.data.inviteUrl!]) {
        expect((await call('/api/invitations/prepare', { method: 'POST', body: { token: tokenOf(stale) } })).status).toBe(410)
      }
      expect((await call('/api/invitations/prepare', { method: 'POST', body: { token: tokenOf(resentUrl) } })).status).toBe(200)
    })

    it('previews a link without disclosing the bound email', async () => {
      const { data } = await invite({ email: 'secret@example.com', role: 'member' })
      const res = await call('/api/invitations/lookup', { method: 'POST', body: { token: tokenOf(data.inviteUrl!) } })
      const { invitation } = (await res.json()) as { invitation: Record<string, unknown> }
      expect(invitation).toMatchObject({ workspaceName: 'Multiplier Labs', inviterLogin: 'owner', role: 'member', boundTo: 'email', status: 'pending' })
      expect(JSON.stringify(invitation)).not.toContain('secret@example.com')
      expect((await call('/api/invitations/lookup', { method: 'POST', body: { token: 'nope' } })).status).toBe(404)
    })
  })

  describe('accepting through GitHub sign-in', () => {
    it('admits a new, non-allowlisted account into the inviting workspace only', async () => {
      const { data } = await invite({ githubLogin: 'newbie', role: 'viewer' })
      const { location } = await acceptAs({ id: 100, login: 'newbie' }, tokenOf(data.inviteUrl!))
      expect(location).toBe(`/?joined=${BOOTSTRAP_WORKSPACE_ID}`)
      const user = db.prepare('SELECT id, status FROM users WHERE github_id = 100').get() as { id: string; status: string }
      expect(user.status).toBe('active')
      expect(getActiveMembership(db, BOOTSTRAP_WORKSPACE_ID, user.id)?.role).toBe('viewer')
      expect(listAuditEvents(db, { workspaceId: BOOTSTRAP_WORKSPACE_ID }).map(e => e.kind)).toContain('invitation_accepted')
    })

    it('adds an existing account to another workspace', async () => {
      const other = createWorkspace(db, 'Other', owner.id)
      const { data } = await invite({ githubLogin: 'member', role: 'member' }, owner, other.id)
      const { location } = await acceptAs({ id: 3, login: 'member' }, tokenOf(data.inviteUrl!))
      expect(location).toBe(`/?joined=${other.id}`)
      expect(getActiveMembership(db, other.id, member.id)?.role).toBe('member')
      expect(getActiveMembership(db, BOOTSTRAP_WORKSPACE_ID, member.id)?.role).toBe('member')
    })

    it('matches an email invitation only against GitHub-verified addresses', async () => {
      const { data } = await invite({ email: 'pat@example.com', role: 'member' })
      const token = tokenOf(data.inviteUrl!)
      const unverified = await acceptAs({ id: 300, login: 'pat', emails: [{ email: 'Pat@example.com', primary: true, verified: false }] }, token)
      expect(unverified.location).toBe('/?auth_error=invite_mismatch')
      expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE github_id = 300').get()).toEqual({ n: 0 })

      const verified = await acceptAs({ id: 300, login: 'pat', emails: [{ email: 'PAT@example.com', primary: false, verified: true }] }, token)
      expect(verified.location).toBe(`/?joined=${BOOTSTRAP_WORKSPACE_ID}`)
    })

    it('refuses a GitHub-bound link opened by a different account, and keeps it usable', async () => {
      const { data } = await invite({ githubLogin: 'newbie', role: 'member' })
      const token = tokenOf(data.inviteUrl!)
      expect((await acceptAs({ id: 200, login: 'stranger' }, token)).location).toBe('/?auth_error=invite_mismatch')
      expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE github_id = 200').get()).toEqual({ n: 0 })
      expect((await acceptAs({ id: 100, login: 'newbie' }, token)).location).toBe(`/?joined=${BOOTSTRAP_WORKSPACE_ID}`)
    })

    it('is single-use', async () => {
      const { data } = await invite({ githubLogin: 'newbie', role: 'member' })
      const token = tokenOf(data.inviteUrl!)
      await acceptAs({ id: 100, login: 'newbie' }, token)
      expect((await acceptAs({ id: 100, login: 'newbie' }, token)).location).toBe('prepare:410')
      // Even a token smuggled past prepare cannot be consumed twice.
      const user = db.prepare('SELECT id FROM users WHERE github_id = 100').get() as { id: string }
      expect(acceptInvitation(db, token, user.id, { githubId: 100, verifiedEmails: [] })).toEqual({ ok: false, reason: 'invite_invalid' })
    })

    it('refuses expired and revoked links', async () => {
      const expired = await invite({ githubLogin: 'newbie', role: 'member' })
      db.prepare('UPDATE workspace_invitations SET expires_at = ?').run(Date.now() - 1)
      expect((await acceptAs({ id: 100, login: 'newbie' }, tokenOf(expired.data.inviteUrl!))).location).toBe('prepare:410')

      const revoked = await invite({ githubLogin: 'stranger', role: 'member' })
      const del = await call(`/api/workspaces/${BOOTSTRAP_WORKSPACE_ID}/invitations/${revoked.data.invitation!.id}`, { as: admin, method: 'DELETE' })
      expect(del.status).toBe(200)
      expect((await acceptAs({ id: 200, login: 'stranger' }, tokenOf(revoked.data.inviteUrl!))).location).toBe('prepare:410')
    })

    it('stops working once the inviter loses the right to invite', async () => {
      const { data } = await invite({ githubLogin: 'newbie', role: 'member' }, admin)
      db.prepare(`UPDATE workspace_memberships SET role = 'member' WHERE user_id = ?`).run(admin.id)
      expect((await acceptAs({ id: 100, login: 'newbie' }, tokenOf(data.inviteUrl!))).location).toBe('prepare:410')
    })

    it('fails closed if the invitation dies between prepare and the callback', async () => {
      const { data } = await invite({ githubLogin: 'newbie', role: 'member' })
      const token = tokenOf(data.inviteUrl!)
      gh.signIn = { id: 100, login: 'newbie' }
      const cookie = cookieOf(await call('/api/invitations/prepare', { method: 'POST', body: { token } }))
      db.prepare(`UPDATE workspace_invitations SET revoked_at = datetime('now')`).run()
      const startRes = await call('/api/auth/github/start', { cookie })
      const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''
      const cb = await call(`/api/auth/github/callback?code=c&state=${state}`, { cookie })
      expect(cb.headers.get('location')).toBe('/?auth_error=invite_invalid')
      expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE github_id = 100').get()).toEqual({ n: 0 })
    })

    it('does not reinstate a suspended member, and never admits a disabled account', () => {
      db.prepare(`UPDATE workspace_memberships SET status = 'suspended' WHERE user_id = ?`).run(member.id)
      const again = createInvitation(db, {
        workspaceId: BOOTSTRAP_WORKSPACE_ID,
        role: 'admin',
        recipient: { github: { id: 3, login: 'member' } },
        invitedByUserId: owner.id,
      })
      expect(again.ok).toBe(true)
      const result = acceptInvitation(db, again.ok ? again.token : '', member.id, { githubId: 3, verifiedEmails: [] })
      expect(result).toMatchObject({ ok: true, alreadyMember: true })
      expect(getActiveMembership(db, BOOTSTRAP_WORKSPACE_ID, member.id)).toBeUndefined()
    })
  })
})
