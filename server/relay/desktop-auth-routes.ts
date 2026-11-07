/**
 * REST endpoints for the desktop app's hosted locations
 * (docs/DESKTOP-APP-TAURI-PLAN.md, Phase 4a).
 *
 * - `GET /api/relay/info`: public identity probe, so the app can tell a
 *   Codekin relay from any other https site before saving it as a location.
 * - `GET /api/auth/desktop/start`: opened by the app in the system browser.
 *   Records the request and sends the browser to the approval page.
 * - `GET /api/auth/desktop/requests/:id` + `POST …/approve`: the approval
 *   page, fully signed in and with a recent check, mints the one-time code
 *   and gets the `codekin://auth` URL to hand back to the app.
 * - `POST /api/auth/desktop/claim`: a form POST from the app's bundled page,
 *   inside the location's webview. Code + PKCE verifier are the credential,
 *   so this one route is exempt from the same-origin mutation guard.
 * - `GET/DELETE /api/me/desktop-sessions`: list and sign out desktop apps.
 *
 * Everything lives under /api: deployments proxy only /api and /relay to the
 * relay (docs/SELF-HOSTED-RELAY.md), the rest is the static web app.
 */

import express, { Router } from 'express'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import type { SqliteSessionStore } from './sqlite-session-store.js'
import {
  createRequireActiveUser,
  createRequireRecentAuth,
  establishSession,
  requestAuditMeta,
} from './relay-auth-routes.js'
import { getUserById } from './control-plane-db.js'
import {
  approveDesktopAuth,
  claimDesktopAuth,
  getDesktopAuthStatus,
  isValidRequestId,
  sessionHandle,
  startDesktopAuth,
} from './desktop-auth.js'
import { recordAuditEvent } from './audit.js'
import { codekinPackageVersion } from './relay-credential.js'

/** The one route the mutation origin guard lets through from other origins. */
export const DESKTOP_CLAIM_PATH = '/api/auth/desktop/claim'

/** Fixed, never taken from the request (an open redirect into a custom scheme otherwise). */
const APP_CALLBACK = 'codekin://auth'

/**
 * The app's webview identifies itself in its user agent. Claims from anything
 * else are refused: the route is open cross-origin, and without this a web
 * page could post an attacker's own code and verifier from a victim's
 * browser, signing that browser in as the attacker (login CSRF). A page can't
 * change its browser's user agent.
 */
const DESKTOP_UA_TOKEN = 'CodekinDesktop/'

export interface DesktopAuthRouterDeps {
  db: Database.Database
  config: RelayConfig
  store?: SqliteSessionStore
  disconnectSession?: (sessionId: string, reason: string) => void
}

export function createDesktopAuthRouter({ db, config, store, disconnectSession }: DesktopAuthRouterDeps): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)
  const requireRecentAuth = createRequireRecentAuth(db)
  const origin = new URL(config.publicUrl).origin
  const version = codekinPackageVersion()

  // Constant apart from the configured name; nothing about who is asking.
  router.get('/api/relay/info', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ app: 'codekin-relay', version, name: config.name ?? new URL(config.publicUrl).host })
  })

  router.get('/api/auth/desktop/start', (req, res) => {
    const started = startDesktopAuth(db, {
      state: req.query.state,
      codeChallenge: req.query.code_challenge,
      method: req.query.code_challenge_method,
    })
    if (!started.ok) {
      res.redirect('/?auth_error=desktop_request_invalid')
      return
    }
    res.redirect(`/desktop-auth?request=${started.requestId}`)
  })

  router.get('/api/auth/desktop/requests/:id', requireActiveUser, (req, res) => {
    const id = req.params.id
    const status = isValidRequestId(id) ? getDesktopAuthStatus(db, id) : null
    if (!status) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json({ status, relayName: config.name ?? new URL(config.publicUrl).host })
  })

  // Signing an app in as this user: a fresh check first, like device linking.
  router.post('/api/auth/desktop/requests/:id/approve', requireActiveUser, requireRecentAuth, (req, res) => {
    const id = req.params.id
    const userId = req.session.user?.id ?? ''
    if (!isValidRequestId(id)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const result = approveDesktopAuth(db, id, userId, {
      mfaVerifiedAt: req.session.mfaVerifiedAt ?? null,
      ip: req.ip ?? null,
    })
    if (result.status !== 'approved') {
      res.status(result.status === 'not_found' ? 404 : 410).json({ error: result.status })
      return
    }
    recordAuditEvent(db, {
      kind: 'desktop_auth_approved',
      actorUserId: userId,
      ...requestAuditMeta(req),
      metadata: { requestId: id },
    })
    const params = new URLSearchParams({ relay: origin, code: result.code, state: result.state })
    res.json({ redirectUrl: `${APP_CALLBACK}?${params.toString()}` })
  })

  router.post(
    DESKTOP_CLAIM_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    (req, res, next) => {
      void (async () => {
        const body = (req.body ?? {}) as { code?: unknown; code_verifier?: unknown }
        const userAgent = req.get('user-agent') ?? null
        if (!userAgent?.includes(DESKTOP_UA_TOKEN)) {
          res.redirect(303, '/?auth_error=desktop_claim_failed')
          return
        }
        const result = claimDesktopAuth(db, body.code, body.code_verifier, { ip: req.ip ?? null, userAgent })
        if (result.status !== 'complete') {
          res.redirect(303, `/?auth_error=${result.status === 'expired' ? 'desktop_claim_expired' : 'desktop_claim_failed'}`)
          return
        }
        // Approval proved who; whether the account may still sign in is the database's call.
        const user = getUserById(db, result.userId)
        if (!user || user.status !== 'active') {
          res.redirect(303, '/?auth_error=access_not_allowed')
          return
        }
        await establishSession(req, user, 'desktop', 'full', {
          client: 'desktop',
          clientUserAgent: userAgent?.slice(0, 256),
          mfaVerifiedAt: result.mfaVerifiedAt ?? undefined,
        })
        recordAuditEvent(db, {
          kind: 'desktop_signed_in',
          actorUserId: user.id,
          ...requestAuditMeta(req),
          metadata: { requestId: result.requestId },
        })
        res.redirect(303, '/')
      })().catch(next)
    },
  )

  router.get('/api/me/desktop-sessions', requireActiveUser, (req, res) => {
    const userId = req.session.user?.id ?? ''
    const sessions = (store?.listUserSessions(userId) ?? [])
      .filter(s => s.session.client === 'desktop')
      .map(s => ({
        id: sessionHandle(s.sid),
        signedInAt: s.session.authenticatedAt ?? null,
        // The cookie rolls: the row's expiry minus its lifetime is the last request.
        lastActiveAt: s.session.cookie.originalMaxAge ? s.expire - s.session.cookie.originalMaxAge : null,
        userAgent: s.session.clientUserAgent ?? null,
        current: s.sid === req.sessionID,
      }))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    res.json({ sessions })
  })

  router.delete('/api/me/desktop-sessions/:id', requireActiveUser, (req, res, next) => {
    const userId = req.session.user?.id ?? ''
    const target = (store?.listUserSessions(userId) ?? []).find(
      s => s.session.client === 'desktop' && sessionHandle(s.sid) === req.params.id,
    )
    if (!target || !store) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    store.destroy(target.sid, err => {
      if (err) {
        next(err)
        return
      }
      disconnectSession?.(target.sid, 'desktop app signed out')
      recordAuditEvent(db, { kind: 'desktop_session_revoked', actorUserId: userId, ...requestAuditMeta(req) })
      res.json({ success: true })
    })
  })

  return router
}
