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
import { upsertUserFromGithub, getUserById, isGithubAccountAllowed, getUserPreferences, setUserPreferences } from './control-plane-db.js'
import type { UserPreferences } from './control-plane-db.js'
import type { GithubProfile, UserStatus, UserRow } from './control-plane-db.js'
import type { SqliteSessionStore } from './sqlite-session-store.js'
import { validateReturnTo } from './return-to.js'
import { recordAuditEvent } from './audit.js'
import { revokePendingDeviceLinks } from './device-link.js'
import { getActiveMembership, listUserWorkspaces } from './workspaces.js'
import { acceptInvitation, checkInvitation } from './invitations.js'
import {
  PARTIAL_SESSION_TTL_MS,
  STEP_UP_WINDOW_MS,
  authLevelAfterSignIn,
  hasSecondFactor,
  isMfaRequired,
  mfaStatus,
} from './mfa.js'
import type { AuthLevel } from './mfa.js'
import type { GithubIdentity } from './invitations.js'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

/** Workspace and machine ids are opaque tokens; this bounds what gets stored. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The subset of the user stored in the web session and returned by /api/me.
 * Roles are per workspace and are never cached here.
 */
export interface SessionUser {
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  status: UserStatus
}

/** The platform operator (OWNER_GITHUB_ID): creates workspaces, manages accounts. */
export function isOperator(user: Pick<UserRow, 'github_id'>, config: Pick<RelayConfig, 'ownerGithubId'>): boolean {
  return config.ownerGithubId > 0 && user.github_id === config.ownerGithubId
}

export function canCreateWorkspaces(user: UserRow, config: Pick<RelayConfig, 'ownerGithubId'>): boolean {
  return user.status === 'active' && (isOperator(user, config) || user.can_create_workspaces === 1)
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser
    oauthState?: string
    /** Validated same-origin path to land on after the OAuth round trip. */
    oauthReturnTo?: string
    /** How this session was signed in; the basis for MFA assurance and step-up. */
    authMethod?: AuthMethod
    /** Epoch ms of sign-in. Bounds the session's absolute lifetime. */
    authenticatedAt?: number
    /** How far sign-in has got (see mfa.ts). Absent on sessions from before 2FA. */
    authLevel?: AuthLevel
    /** Epoch ms the current half-signed-in state began; it expires after PARTIAL_SESSION_TTL_MS. */
    partialSince?: number
    /** Epoch ms of the last second-factor check, for step-up on sensitive actions. */
    mfaVerifiedAt?: number
  }
}

export type AuthMethod = 'github' | 'passkey' | 'device_link'

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function sessionCallback(resolve: () => void, reject: (err: Error) => void) {
  return (err: unknown) => {
    if (err) reject(toError(err))
    else resolve()
  }
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save(sessionCallback(resolve, reject))
  })
}

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate(sessionCallback(resolve, reject))
  })
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy(sessionCallback(resolve, reject))
  })
}

/**
 * The one way a request becomes signed in. Every login path (GitHub OAuth,
 * passkey, device link) ends here, so a new session always gets a fresh id
 * (session fixation) and the same sign-in metadata.
 */
export async function establishSession(
  req: Request,
  user: UserRow,
  method: AuthMethod,
  level: AuthLevel = 'full',
): Promise<void> {
  await regenerateSession(req)
  const now = Date.now()
  req.session.user = toSessionUser(user)
  req.session.authMethod = method
  req.session.authenticatedAt = now
  req.session.authLevel = level
  if (level !== 'full') req.session.partialSince = now
  // A passkey sign-in is itself a second-factor check.
  if (method === 'passkey') req.session.mfaVerifiedAt = now
  await saveSession(req)
}

/**
 * Record a successful second-factor check. Completing sign-in (a partial
 * session becoming full) gets a fresh session id, like any privilege change;
 * a step-up on an already-full session keeps its id, so the machine sockets
 * bound to it stay connected.
 */
export async function markMfaVerified(req: Request): Promise<void> {
  if (req.session.authLevel !== 'full') {
    const { user, authMethod, authenticatedAt } = req.session
    await regenerateSession(req)
    req.session.user = user
    req.session.authMethod = authMethod
    req.session.authenticatedAt = authenticatedAt
  }
  req.session.authLevel = 'full'
  delete req.session.partialSince
  req.session.mfaVerifiedAt = Date.now()
  await saveSession(req)
}

/**
 * The session's effective auth level, or null when a half-signed-in session
 * has run out of time. Sessions from before 2FA are held to what a fresh
 * GitHub sign-in would face, and a full session whose account has since
 * become subject to 2FA (promoted, or a workspace now requires it) without
 * having a factor drops to enrollment.
 */
export function currentAuthLevel(
  db: Database.Database,
  req: Request,
  user: UserRow,
  config?: Pick<RelayConfig, 'ownerGithubId'>,
): AuthLevel | null {
  const policy = config ?? { ownerGithubId: 0 }
  const now = Date.now()
  let level = req.session.authLevel
  if (level === undefined) {
    level = authLevelAfterSignIn(db, user, policy, 'github')
    req.session.authLevel = level
    if (level !== 'full') req.session.partialSince = now
  }
  if (level === 'full' && !hasSecondFactor(db, user.id) && isMfaRequired(db, user, policy)) {
    level = 'enrollment_required'
    req.session.authLevel = level
    req.session.partialSince = now
  }
  if (level !== 'full' && now - (req.session.partialSince ?? 0) > PARTIAL_SESSION_TTL_MS) return null
  return level
}

export function requestAuditMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }
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
  store?: SqliteSessionStore
  disconnectUser?: (userId: string, reason: string) => void
  /** Close the browser sockets opened under one web session. */
  disconnectSession?: (sessionId: string, reason: string) => void
}

export function createRelayAuthRouter({
  db,
  config,
  fetchImpl = fetch,
  store,
  disconnectUser,
  disconnectSession,
}: AuthRouterDeps): Router {
  const router = Router()

  const loginFailed = (req: Request, res: Response, code: string, detail: { githubId?: number } = {}) => {
    recordAuditEvent(db, {
      kind: 'login_failed',
      ...requestAuditMeta(req),
      metadata: { method: 'github', reason: code, ...detail },
    })
    failLogin(res, code)
  }

  // Public, unauthenticated: what the sign-in page may say before OAuth.
  // Admission is always by allowlist (owner + ALLOWED_GITHUB_IDS), so the
  // instance is invitation-only; the access-request route is optional config.
  // Nothing here depends on who is asking, so it cannot reveal whether a
  // particular GitHub account is allowlisted.
  router.get('/api/auth/config', (_req, res) => {
    res.json({
      inviteOnly: true,
      ...(config.accessRequestUrl ? { accessUrl: config.accessRequestUrl } : {}),
    })
  })

  router.get('/api/auth/github/start', (req, res, next) => {
    const state = randomBytes(16).toString('hex')
    req.session.oauthState = state
    // Kept server-side next to the state, never round-tripped through GitHub.
    const returnTo = validateReturnTo(req.query.returnTo)
    if (returnTo) req.session.oauthReturnTo = returnTo
    else delete req.session.oauthReturnTo
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
        loginFailed(req, res, 'state_mismatch')
        return
      }
      delete req.session.oauthState
      // Read before regenerateSession() wipes it; re-validated on the way out.
      const returnTo = validateReturnTo(req.session.oauthReturnTo) ?? '/'
      delete req.session.oauthReturnTo
      // Parked by POST /api/invitations/prepare; this sign-in accepts it.
      const inviteToken = req.session.pendingInviteToken
      delete req.session.pendingInviteToken

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
        loginFailed(req, res, 'token_exchange_failed')
        return
      }
      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        loginFailed(req, res, tokenData.error || 'token_exchange_failed')
        return
      }

      // Fetch the profile; the token is discarded after this block.
      const ghHeaders = {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      }
      const userRes = await fetchImpl(GITHUB_USER_URL, { headers: ghHeaders })
      if (!userRes.ok) {
        loginFailed(req, res, 'profile_fetch_failed')
        return
      }
      const gh = (await userRes.json()) as {
        id: number
        login: string
        name: string | null
        email: string | null
        avatar_url: string | null
      }

      // An email-bound invitation is matched against the addresses GitHub
      // itself has verified, never the profile's self-declared one.
      let email = gh.email
      let verifiedEmails: string[] = []
      if (!email || inviteToken) {
        const emailsRes = await fetchImpl(GITHUB_EMAILS_URL, { headers: ghHeaders })
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified?: boolean }>
          verifiedEmails = emails.filter(e => e.verified === true).map(e => e.email)
          if (!email && emails.length > 0) {
            email = (emails.find(e => e.primary) ?? emails[0]).email
          }
        }
      }
      const identity: GithubIdentity = { githubId: gh.id, verifiedEmails }
      const invite = inviteToken ? checkInvitation(db, inviteToken, identity) : null
      if (invite && !invite.ok) {
        recordAuditEvent(db, {
          kind: 'invitation_rejected',
          ...requestAuditMeta(req),
          metadata: { reason: invite.reason, githubId: gh.id },
        })
        loginFailed(req, res, invite.reason, { githubId: gh.id })
        return
      }

      const profile: GithubProfile = {
        id: gh.id,
        login: gh.login,
        name: gh.name,
        email,
        avatarUrl: gh.avatar_url,
      }
      const accessPolicy = {
        ownerGithubId: config.ownerGithubId,
        allowedGithubIds: config.allowedGithubIds,
      }
      const existing = db.prepare('SELECT id, status FROM users WHERE github_id = ?').get(profile.id) as
        | { id: string; status: UserStatus }
        | undefined
      // Admission is by allowlist, and a row that never got past `pending` is
      // not an admission: it is the residue of a login the policy already
      // refused. Gating on `!existing` alone would grandfather those rows in
      // forever, so an identity the allowlist rejects can never accumulate a
      // standing exemption by having knocked once. An `active` or `disabled`
      // row is a real decision someone made, and is left to upsert to honour.
      // A valid invitation for this very identity is the other way in.
      const provisional = !existing || existing.status === 'pending'
      if (provisional && !isGithubAccountAllowed(profile.id, accessPolicy) && !invite?.ok) {
        await destroySession(req)
        loginFailed(req, res, 'access_not_allowed', { githubId: profile.id })
        return
      }
      const user = upsertUserFromGithub(db, profile, accessPolicy, { admitViaInvitation: invite?.ok === true })

      // Accept before settling the auth level: joining as an admin, or into a
      // workspace that requires 2FA, changes what this sign-in must complete.
      // A disabled account signs in (it sees the no-access screen) but joins nothing.
      let destination = returnTo
      if (inviteToken && user.status === 'active') {
        const accepted = acceptInvitation(db, inviteToken, user.id, identity)
        if (accepted.ok) {
          recordAuditEvent(db, {
            kind: 'invitation_accepted',
            workspaceId: accepted.workspaceId,
            actorUserId: user.id,
            ...requestAuditMeta(req),
            metadata: { role: accepted.role, alreadyMember: accepted.alreadyMember },
          })
          destination = `/?joined=${encodeURIComponent(accepted.workspaceId)}`
        } else {
          recordAuditEvent(db, {
            kind: 'invitation_rejected',
            actorUserId: user.id,
            ...requestAuditMeta(req),
            metadata: { reason: accepted.reason },
          })
          destination = `/?auth_error=${accepted.reason}`
        }
      }

      const level = authLevelAfterSignIn(db, user, config, 'github')
      await establishSession(req, user, 'github', level)
      recordAuditEvent(db, {
        kind: 'login',
        actorUserId: user.id,
        ...requestAuditMeta(req),
        metadata: { method: 'github', authLevel: level },
      })
      res.redirect(destination)
    })().catch(() => { loginFailed(req, res, 'login_failed'); })
  })

  router.post('/api/auth/logout', (req, res, next) => {
    const sessionId = req.sessionID
    const userId = req.session.user?.id ?? null
    destroySession(req)
      .then(() => {
        // The HTTP session is gone; sockets it opened must not outlive it.
        disconnectSession?.(sessionId, 'logged out')
        if (userId) recordAuditEvent(db, { kind: 'logout', actorUserId: userId, ...requestAuditMeta(req) })
        res.clearCookie('codekin_relay_sid')
        res.json({ success: true })
      })
      .catch(next)
  })

  router.post('/api/auth/logout-all', (req, res, next) => {
    const userId = req.session.user?.id
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    try {
      const destroyed = store?.destroyUserSessions(userId) ?? 0
      // An unclaimed device-link code would otherwise mint a fresh session
      // after "log out everywhere".
      const linksRevoked = revokePendingDeviceLinks(db, userId)
      disconnectUser?.(userId, 'all sessions logged out')
      recordAuditEvent(db, {
        kind: 'logout_all',
        actorUserId: userId,
        ...requestAuditMeta(req),
        metadata: { sessions: destroyed, deviceLinks: linksRevoked },
      })
      destroySession(req)
        .then(() => {
          res.clearCookie('codekin_relay_sid')
          res.json({ success: true, destroyed })
        })
        .catch(next)
    } catch (err) {
      next(err)
    }
  })

  // Refreshed from the DB like requireActiveUser, so the UI never renders a
  // role or status the server no longer honours.
  router.get('/api/me', (req, res) => {
    const sessionUser = req.session.user
    const current = sessionUser ? getUserById(db, sessionUser.id) : undefined
    if (sessionUser && !current) delete req.session.user
    if (!current) {
      res.json({ user: null })
      return
    }
    req.session.user = toSessionUser(current)
    const active = current.status === 'active'
    const authLevel = active ? currentAuthLevel(db, req, current, config) : 'full'
    if (authLevel === null) {
      // The window to finish signing in closed; start over.
      destroySession(req)
        .then(() => { res.json({ user: null }) })
        .catch(() => { res.json({ user: null }) })
      return
    }
    const full = active && authLevel === 'full'
    res.json({
      user: req.session.user,
      authLevel,
      mfa: active ? mfaStatus(db, current, config) : null,
      // Workspace facts only once fully signed in.
      workspaces: full ? listUserWorkspaces(db, current.id) : [],
      isOperator: full && isOperator(current, config),
      canCreateWorkspaces: full && canCreateWorkspaces(current, config),
      preferences: full ? getUserPreferences(db, current.id) : null,
    })
  })

  // Where the hosted app resumes for this user — the workspace a new tab
  // opens in and the machine a reload reconnects to. Kept here rather than in
  // browser storage so it follows the user across devices. Each key is
  // optional; null clears it.
  router.put('/api/me/preferences', createRequireActiveUser(db, config), (req, res) => {
    const userId = req.session.user?.id ?? ''
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Partial<UserPreferences> = {}
    for (const key of ['workspaceId', 'machineId'] as const) {
      if (!(key in body)) continue
      const value = body[key]
      if (value !== null && (typeof value !== 'string' || !ID_RE.test(value))) {
        res.status(400).json({ error: `invalid ${key}` })
        return
      }
      patch[key] = value
    }
    // Only a workspace the user can actually open is worth remembering.
    if (patch.workspaceId && !getActiveMembership(db, patch.workspaceId, userId)) {
      res.status(400).json({ error: 'not_a_member' })
      return
    }
    res.json({ preferences: setUserPreferences(db, userId, patch) })
  })

  return router
}

/**
 * The signed-in, active account behind a request, refreshed from the DB, or
 * null after an error response has been sent (401 not signed in; 403
 * pending/disabled).
 *
 * Status is re-read on every request rather than taken from the session. The
 * session holds a snapshot written at login and rolls for 30 days, so trusting
 * it would leave a disabled user with working access until their cookie
 * happened to expire. The refreshed row is written back to the session so
 * downstream handlers and /api/me agree with the DB.
 */
function activeAccount(db: Database.Database, req: Request, res: Response): UserRow | null {
  const sessionUser = req.session.user
  if (!sessionUser) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  const current = getUserById(db, sessionUser.id)
  if (!current) {
    // The account was deleted out from under a live session.
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  // Refresh before the status check, not after: a user who has just been
  // disabled should see that in /api/me too, not a stale "active".
  req.session.user = toSessionUser(current)
  // Sessions from before sign-in times were recorded start their absolute
  // lifetime now rather than being exempt from it forever.
  req.session.authenticatedAt ??= Date.now()
  if (current.status !== 'active') {
    res.status(403).json({ error: 'Access not granted', status: current.status })
    return null
  }
  return current
}

/**
 * Guard for routes that need a fully signed-in, active user: 401 with
 * `mfa_required` (and the level) while a second factor or 2FA enrollment is
 * outstanding.
 */
export function createRequireActiveUser(db: Database.Database, config?: Pick<RelayConfig, 'ownerGithubId'>) {
  return function requireActiveUser(req: Request, res: Response, next: () => void): void {
    const current = activeAccount(db, req, res)
    if (!current) return
    const level = currentAuthLevel(db, req, current, config)
    if (level === null) {
      res.status(401).json({ error: 'session_expired' })
      return
    }
    if (level !== 'full') {
      res.status(401).json({ error: 'mfa_required', authLevel: level })
      return
    }
    next()
  }
}

/**
 * Guard for the routes that finish signing in (second factor, enrollment):
 * an active user at any auth level, as long as a half-signed-in session is
 * still within its window.
 */
export function createRequireSignedIn(db: Database.Database, config?: Pick<RelayConfig, 'ownerGithubId'>) {
  return function requireSignedIn(req: Request, res: Response, next: () => void): void {
    const current = activeAccount(db, req, res)
    if (!current) return
    if (currentAuthLevel(db, req, current, config) === null) {
      res.status(401).json({ error: 'session_expired' })
      return
    }
    next()
  }
}

/**
 * Step-up for sensitive actions (after one of the guards above). With a
 * second factor enrolled it must have been checked in the last ten minutes;
 * without one, the GitHub sign-in itself must be that recent. 401
 * `step_up_required` otherwise, naming which of the two the client should ask for.
 */
export function createRequireRecentAuth(db: Database.Database) {
  return function requireRecentAuth(req: Request, res: Response, next: () => void): void {
    if (ensureRecentAuth(db, req, res)) next()
  }
}

/** The step-up check as a predicate, for actions that need it only sometimes. Sends the 401 when false. */
export function ensureRecentAuth(db: Database.Database, req: Request, res: Response): boolean {
  const userId = req.session.user?.id ?? ''
  const enrolled = hasSecondFactor(db, userId)
  const since = enrolled ? req.session.mfaVerifiedAt : req.session.authenticatedAt
  if (since === undefined || Date.now() - since > STEP_UP_WINDOW_MS) {
    res.status(401).json({ error: 'step_up_required', method: enrolled ? 'mfa' : 'github' })
    return false
  }
  return true
}

/** Project a user row down to what the session and /api/me carry. */
export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
  }
}
