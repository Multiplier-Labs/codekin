/**
 * GitHub OAuth authentication for the hosted control plane.
 *
 * Hand-rolled web-application flow (no library), modeled on Gitnook's
 * implementation with its load-bearing details: explicit session.save()
 * before the OAuth redirect (state would otherwise be lost), and
 * session.regenerate() after login (session fixation). Unlike Gitnook we
 * only need identity: the GitHub access token is used once to fetch the
 * profile and never stored.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import { upsertUserFromGithub } from './control-plane-db.js'
import type { GithubProfile, UserRole, UserStatus } from './control-plane-db.js'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

/** The subset of the user stored in the web session and returned by /api/me. */
export interface SessionUser {
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser
    oauthState?: string
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function sessionCallback(resolve: () => void, reject: (err: Error) => void) {
  return (err: unknown) => {
    if (err) reject(toError(err))
    else resolve()
  }
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save(sessionCallback(resolve, reject))
  })
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate(sessionCallback(resolve, reject))
  })
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy(sessionCallback(resolve, reject))
  })
}

/** Redirect to the SPA with an error code it can render on the login screen. */
function failLogin(res: Response, code: string): void {
  res.redirect(`/?auth_error=${encodeURIComponent(code)}`)
}

export interface AuthRouterDeps {
  db: Database.Database
  config: RelayConfig
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function createRelayAuthRouter({ db, config, fetchImpl = fetch }: AuthRouterDeps): Router {
  const router = Router()

  router.get('/api/auth/github/start', (req, res, next) => {
    const state = randomBytes(16).toString('hex')
    req.session.oauthState = state
    // Explicit save before the redirect: the default lifecycle may not flush
    // the session in time, and a lost state fails every callback.
    saveSession(req)
      .then(() => {
        const params = new URLSearchParams({
          client_id: config.githubClientId,
          redirect_uri: `${config.publicUrl}/api/auth/github/callback`,
          scope: 'read:user user:email',
          state,
        })
        res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`)
      })
      .catch(next)
  })

  router.get('/api/auth/github/callback', (req, res) => {
    void (async () => {
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''

      if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
        failLogin(res, 'state_mismatch')
        return
      }
      delete req.session.oauthState

      // Exchange the code for an access token
      const tokenRes = await fetchImpl(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
        }),
      })
      if (!tokenRes.ok) {
        failLogin(res, 'token_exchange_failed')
        return
      }
      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        failLogin(res, tokenData.error || 'token_exchange_failed')
        return
      }

      // Fetch the profile; the token is discarded after this block.
      const ghHeaders = {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      }
      const userRes = await fetchImpl(GITHUB_USER_URL, { headers: ghHeaders })
      if (!userRes.ok) {
        failLogin(res, 'profile_fetch_failed')
        return
      }
      const gh = (await userRes.json()) as {
        id: number
        login: string
        name: string | null
        email: string | null
        avatar_url: string | null
      }

      let email = gh.email
      if (!email) {
        const emailsRes = await fetchImpl(GITHUB_EMAILS_URL, { headers: ghHeaders })
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean }>
          if (emails.length > 0) {
            email = (emails.find(e => e.primary) ?? emails[0]).email
          }
        }
      }

      const profile: GithubProfile = {
        id: gh.id,
        login: gh.login,
        name: gh.name,
        email,
        avatarUrl: gh.avatar_url,
      }
      const user = upsertUserFromGithub(db, profile, {
        ownerGithubLogin: config.ownerGithubLogin,
        allowedGithubLogins: config.allowedGithubLogins,
      })

      // Fresh session id after privilege change (session fixation)
      await regenerateSession(req)
      req.session.user = {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        role: user.role,
        status: user.status,
      }
      await saveSession(req)
      res.redirect('/')
    })().catch(() => { failLogin(res, 'login_failed'); })
  })

  router.post('/api/auth/logout', (req, res, next) => {
    destroySession(req)
      .then(() => {
        res.clearCookie('codekin_relay_sid')
        res.json({ success: true })
      })
      .catch(next)
  })

  router.get('/api/me', (req, res) => {
    res.json({ user: req.session.user ?? null })
  })

  return router
}

/**
 * Guard for routes that require a signed-in, active user.
 * 401 when not signed in; 403 when signed in but pending/disabled.
 */
export function requireActiveUser(req: Request, res: Response, next: () => void): void {
  const user = req.session.user
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  if (user.status !== 'active') {
    res.status(403).json({ error: 'Access not granted', status: user.status })
    return
  }
  next()
}
