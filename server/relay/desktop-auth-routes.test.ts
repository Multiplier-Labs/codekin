/** Tests for the desktop-app sign-in handoff routes (Phase 4a). */
import { createHash, randomBytes } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { signInFully } from './__fixtures__/auth.js'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { createDesktopAuthRouter, DESKTOP_CLAIM_PATH } from './desktop-auth-routes.js'
import { createMutationOriginGuard } from './origin-guard.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { DESKTOP_AUTH_CODE_TTL_MS } from './desktop-auth.js'
import { listAuditEvents } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { SessionUser } from './relay-auth-routes.js'

const CONFIG = { publicUrl: 'https://app.example.com', ownerGithubId: 1, name: 'Example' } as RelayConfig

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe('desktop auth routes', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let server: Server
  let baseUrl: string
  let activeUser: SessionUser
  const disconnected: string[] = []

  beforeEach(async () => {
    disconnected.length = 0
    db = openControlPlaneDb(':memory:')
    const row = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    activeUser = { id: row.id, login: row.login, displayName: null, avatarUrl: null, status: row.status }
    store = new SqliteSessionStore(db)

    const app = express()
    app.use(express.json())
    app.use(createMutationOriginGuard(CONFIG.publicUrl, [DESKTOP_CLAIM_PATH]))
    app.use(session({ name: 'sid', secret: 's'.repeat(32), store, resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'active') {
        req.session.user = activeUser
        signInFully(db, req.session, activeUser.id)
      }
      if (req.headers['x-test-stale'] === '1') req.session.mfaVerifiedAt = Date.now() - 60 * 60 * 1000
      next()
    })
    app.use(createDesktopAuthRouter({ db, config: CONFIG, store, disconnectSession: sid => { disconnected.push(sid) } }))
    app.get('/whoami', (req, res) => {
      res.json({ user: req.session.user ?? null, client: req.session.client ?? null, method: req.session.authMethod ?? null })
    })
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
    store.close()
    db.close()
  })

  const asUser = { 'x-test-user': 'active', 'Content-Type': 'application/json', origin: CONFIG.publicUrl }

  async function start(challenge: string, state = randomBytes(16).toString('base64url')): Promise<{ requestId: string; state: string }> {
    const res = await fetch(
      `${baseUrl}/api/auth/desktop/start?state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/^\/desktop-auth\?request=[0-9a-f-]{36}$/)
    return { requestId: location.split('=')[1], state }
  }

  async function approve(requestId: string, headers: Record<string, string> = asUser): Promise<Response> {
    return fetch(`${baseUrl}/api/auth/desktop/requests/${requestId}/approve`, { method: 'POST', headers })
  }

  async function approvedCode(challenge: string): Promise<{ code: string; state: string; redirectUrl: string }> {
    const { requestId, state } = await start(challenge)
    const res = await approve(requestId)
    expect(res.status).toBe(200)
    const { redirectUrl } = (await res.json()) as { redirectUrl: string }
    const url = new URL(redirectUrl)
    return { code: url.searchParams.get('code') ?? '', state, redirectUrl }
  }

  /** The app's bundled page: a cross-origin form POST. */
  async function claim(code: string, verifier: string, userAgent = 'Mozilla/5.0 CodekinDesktop/0.10.0'): Promise<Response> {
    return fetch(`${baseUrl}${DESKTOP_CLAIM_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        origin: 'tauri://localhost',
        'sec-fetch-site': 'cross-site',
        'user-agent': userAgent,
      },
      body: new URLSearchParams({ code, code_verifier: verifier }).toString(),
    })
  }

  it('relay info identifies the relay without auth', async () => {
    const res = await fetch(`${baseUrl}/api/relay/info`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.app).toBe('codekin-relay')
    expect(body.name).toBe('Example')
    expect(typeof body.version).toBe('string')
  })

  it('start rejects a missing or plain challenge', async () => {
    const state = randomBytes(16).toString('base64url')
    for (const query of [`state=${state}`, `state=${state}&code_challenge=${pkce().challenge}&code_challenge_method=plain`, `code_challenge=${pkce().challenge}`]) {
      const res = await fetch(`${baseUrl}/api/auth/desktop/start?${query}`, { redirect: 'manual' })
      expect(res.headers.get('location')).toBe('/?auth_error=desktop_request_invalid')
    }
  })

  it('full flow: start → approve → claim gives the webview a desktop session', async () => {
    const { verifier, challenge } = pkce()
    const { code, state, redirectUrl } = await approvedCode(challenge)
    expect(redirectUrl.startsWith('codekin://auth?')).toBe(true)
    const url = new URL(redirectUrl)
    expect(url.searchParams.get('relay')).toBe('https://app.example.com')
    expect(url.searchParams.get('state')).toBe(state)

    const res = await claim(code, verifier)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const cookie = res.headers.get('set-cookie')!.split(';')[0]
    const who = (await (await fetch(`${baseUrl}/whoami`, { headers: { cookie } })).json()) as {
      user: SessionUser | null; client: string | null; method: string | null
    }
    expect(who.user?.id).toBe(activeUser.id)
    expect(who.client).toBe('desktop')
    expect(who.method).toBe('desktop')

    const kinds = listAuditEvents(db, {}).map(e => e.kind)
    expect(kinds).toContain('desktop_auth_approved')
    expect(kinds).toContain('desktop_signed_in')
  })

  it('a wrong verifier fails and burns the code', async () => {
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(challenge)
    const bad = await claim(code, pkce().verifier)
    expect(bad.headers.get('location')).toBe('/?auth_error=desktop_claim_failed')
    expect(bad.headers.get('set-cookie')).toBeNull()
    const retry = await claim(code, verifier)
    expect(retry.headers.get('location')).toBe('/?auth_error=desktop_claim_failed')
  })

  it('refuses a claim from an ordinary browser (login CSRF), without spending the code', async () => {
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(challenge)
    const res = await claim(code, verifier, 'Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15')
    expect(res.headers.get('location')).toBe('/?auth_error=desktop_claim_failed')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect((await claim(code, verifier)).headers.get('location')).toBe('/')
  })

  it('a code is single use', async () => {
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(challenge)
    expect((await claim(code, verifier)).headers.get('location')).toBe('/')
    expect((await claim(code, verifier)).headers.get('location')).toBe('/?auth_error=desktop_claim_failed')
  })

  it('an expired code does not sign in', async () => {
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(challenge)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + DESKTOP_AUTH_CODE_TTL_MS + 1000)
    const res = await claim(code, verifier)
    expect(res.headers.get('location')).toBe('/?auth_error=desktop_claim_expired')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('approval needs a signed-in user and a recent check, and happens once', async () => {
    const { requestId } = await start(pkce().challenge)
    expect((await approve(requestId, { origin: CONFIG.publicUrl })).status).toBe(401)
    const stale = await approve(requestId, { ...asUser, 'x-test-stale': '1' })
    expect(stale.status).toBe(401)
    expect(((await stale.json()) as { error: string }).error).toBe('step_up_required')
    expect((await approve(requestId)).status).toBe(200)
    expect((await approve(requestId)).status).toBe(410)
  })

  it('approve is refused cross-origin; only claim is exempt', async () => {
    const { requestId } = await start(pkce().challenge)
    const res = await approve(requestId, { ...asUser, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('lists and revokes desktop sessions', async () => {
    const { verifier, challenge } = pkce()
    const { code } = await approvedCode(challenge)
    const cookie = (await claim(code, verifier)).headers.get('set-cookie')!.split(';')[0]

    const list = (await (await fetch(`${baseUrl}/api/me/desktop-sessions`, { headers: asUser })).json()) as {
      sessions: Array<{ id: string; userAgent: string | null; current: boolean }>
    }
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0].userAgent).toContain('CodekinDesktop')
    expect(list.sessions[0].current).toBe(false)
    // The handle is not the session id.
    expect(cookie).not.toContain(list.sessions[0].id)

    const del = await fetch(`${baseUrl}/api/me/desktop-sessions/${list.sessions[0].id}`, { method: 'DELETE', headers: asUser })
    expect(del.status).toBe(200)
    expect(disconnected).toHaveLength(1)
    const who = (await (await fetch(`${baseUrl}/whoami`, { headers: { cookie } })).json()) as { user: unknown }
    expect(who.user).toBeNull()
    expect((await fetch(`${baseUrl}/api/me/desktop-sessions/${list.sessions[0].id}`, { method: 'DELETE', headers: asUser })).status).toBe(404)
  })
})
