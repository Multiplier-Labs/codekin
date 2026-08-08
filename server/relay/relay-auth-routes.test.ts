/** End-to-end tests for the GitHub OAuth flow with a mocked GitHub and a real express app. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import { openControlPlaneDb } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter, requireActiveUser } from './relay-auth-routes.js'
import type { RelayConfig } from './relay-config.js'

const CONFIG: RelayConfig = {
  port: 0,
  publicUrl: 'https://app.example.com',
  githubClientId: 'client-id',
  githubClientSecret: 'client-secret',
  sessionSecret: 's'.repeat(32),
  ownerGithubLogin: 'alari76',
  allowedGithubLogins: ['alari76'],
  dataDir: '/tmp',
  isProduction: false,
}

/** Mocked GitHub: token exchange + profile fetch. */
function githubFetchMock(profile: { id: number; login: string }) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-token' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.endsWith('/user')) {
      return new Response(
        JSON.stringify({ ...profile, name: 'Name', email: null, avatar_url: 'https://a/b.png' }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (u.endsWith('/user/emails')) {
      return new Response(JSON.stringify([{ email: 'p@example.com', primary: true }]), {
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected URL: ${u}`)
  }) as unknown as typeof fetch
}

describe('relay auth routes', () => {
  let db: Database.Database
  let store: SqliteSessionStore
  let server: Server
  let baseUrl: string

  async function start(fetchImpl: typeof fetch) {
    db = openControlPlaneDb(':memory:')
    store = new SqliteSessionStore(db)
    const app = express()
    app.use(express.json())
    app.use(
      session({
        name: 'codekin_relay_sid',
        secret: CONFIG.sessionSecret,
        store,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', maxAge: 60_000 },
      }),
    )
    app.use(createRelayAuthRouter({ db, config: CONFIG, fetchImpl }))
    app.get('/api/protected', requireActiveUser, (_req, res) => res.json({ ok: true }))
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  }

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    db.close()
  })

  function cookieOf(res: Response): string {
    return (res.headers.get('set-cookie') ?? '').split(';')[0]
  }

  /** Run the full start → callback flow and return the session cookie. */
  async function login(): Promise<string> {
    const startRes = await fetch(`${baseUrl}/api/auth/github/start`, { redirect: 'manual' })
    expect(startRes.status).toBe(302)
    const location = new URL(startRes.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/auth/github/callback')
    const state = location.searchParams.get('state') ?? ''
    const cookie = cookieOf(startRes)

    const cbRes = await fetch(
      `${baseUrl}/api/auth/github/callback?code=abc&state=${state}`,
      { redirect: 'manual', headers: { cookie } },
    )
    expect(cbRes.status).toBe(302)
    expect(cbRes.headers.get('location')).toBe('/')
    // Session was regenerated at login — a fresh cookie is issued
    const newCookie = cookieOf(cbRes)
    expect(newCookie).not.toBe('')
    return newCookie
  }

  it('signs in an allowlisted user as active and serves /api/me', async () => {
    await start(githubFetchMock({ id: 1, login: 'alari76' }))
    const cookie = await login()

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { cookie } })
    const me = (await meRes.json()) as { user: { login: string; role: string; status: string } }
    expect(me.user.login).toBe('alari76')
    expect(me.user.role).toBe('owner')
    expect(me.user.status).toBe('active')

    const prot = await fetch(`${baseUrl}/api/protected`, { headers: { cookie } })
    expect(prot.status).toBe(200)
  })

  it('signs in a non-allowlisted user as pending and blocks protected routes with 403', async () => {
    await start(githubFetchMock({ id: 2, login: 'stranger' }))
    const cookie = await login()

    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json()) as {
      user: { status: string }
    }
    expect(me.user.status).toBe('pending')

    const prot = await fetch(`${baseUrl}/api/protected`, { headers: { cookie } })
    expect(prot.status).toBe(403)
  })

  it('rejects a callback with a mismatched state', async () => {
    await start(githubFetchMock({ id: 1, login: 'alari76' }))
    const startRes = await fetch(`${baseUrl}/api/auth/github/start`, { redirect: 'manual' })
    const cookie = cookieOf(startRes)
    const cbRes = await fetch(`${baseUrl}/api/auth/github/callback?code=abc&state=wrong`, {
      redirect: 'manual',
      headers: { cookie },
    })
    expect(cbRes.status).toBe(302)
    expect(cbRes.headers.get('location')).toContain('auth_error=state_mismatch')
  })

  it('rejects a callback with no session at all', async () => {
    await start(githubFetchMock({ id: 1, login: 'alari76' }))
    const cbRes = await fetch(`${baseUrl}/api/auth/github/callback?code=abc&state=x`, {
      redirect: 'manual',
    })
    expect(cbRes.headers.get('location')).toContain('auth_error=state_mismatch')
  })

  it('returns user: null from /api/me when signed out, and 401 from protected routes', async () => {
    await start(githubFetchMock({ id: 1, login: 'alari76' }))
    const me = (await (await fetch(`${baseUrl}/api/me`)).json()) as { user: null }
    expect(me.user).toBeNull()
    expect((await fetch(`${baseUrl}/api/protected`)).status).toBe(401)
  })

  it('logout destroys the session', async () => {
    await start(githubFetchMock({ id: 1, login: 'alari76' }))
    const cookie = await login()
    await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } })
    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json()) as { user: null }
    expect(me.user).toBeNull()
  })
})
