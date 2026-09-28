/**
 * Two-factor endpoints (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 3).
 *
 * `verify` serves both the second step of a GitHub sign-in (mfa_pending →
 * full) and step-up on a full session. Enrollment runs from either a full
 * session or the enrollment_required state a sign-in lands in when 2FA is
 * required but not set up. Passkey counterparts live in webauthn-routes.ts.
 * Everything here is under /api/auth, so it also inherits the per-IP limit.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import {
  createRequireActiveUser,
  createRequireRecentAuth,
  createRequireSignedIn,
  markMfaVerified,
  requestAuditMeta,
} from './relay-auth-routes.js'
import { getUserById } from './control-plane-db.js'
import type { UserRow } from './control-plane-db.js'
import {
  FailedAttemptLimiter,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  deleteRecoveryCodes,
  disableTotp,
  hasSecondFactor,
  hasTotp,
  isMfaRequired,
  issueRecoveryCodes,
  mfaStatus,
  passkeyCount,
  recoveryCodesRemaining,
  verifyTypedFactor,
} from './mfa.js'
import { revokePendingDeviceLinks } from './device-link.js'
import { recordAuditEvent } from './audit.js'
import type { SqliteSessionStore } from './sqlite-session-store.js'

export interface MfaRouterDeps {
  db: Database.Database
  config: RelayConfig
  store?: Pick<SqliteSessionStore, 'destroyUserSessions'>
  /** Close a user's sockets, sparing one web session's. */
  disconnectUser?: (userId: string, reason: string, exceptSessionId?: string) => void
  /** Shared with the passkey step-up so both count against one budget. */
  limiter?: FailedAttemptLimiter
}

/**
 * The account just gained its first second factor. Sessions and device-link
 * codes issued without one were never checked against it: end them, except
 * the session doing the enrolling.
 */
export function secureAfterFirstFactor(deps: Pick<MfaRouterDeps, 'db' | 'store' | 'disconnectUser'>, req: Request, userId: string): void {
  deps.store?.destroyUserSessions(userId, req.sessionID)
  revokePendingDeviceLinks(deps.db, userId)
  deps.disconnectUser?.(userId, 'two-factor authentication enabled', req.sessionID)
}

export function createMfaRouter(deps: MfaRouterDeps): Router {
  const { db, config } = deps
  const limiter = deps.limiter ?? new FailedAttemptLimiter()
  const router = Router()
  const requireSignedIn = createRequireSignedIn(db, config)
  const requireActiveUser = createRequireActiveUser(db, config)
  const requireRecentAuth = createRequireRecentAuth(db)

  const userIdOf = (req: Request) => req.session.user?.id ?? ''
  /** Behind the guards the account exists; this only narrows the type. */
  const accountOf = (req: Request) => getUserById(db, userIdOf(req)) as UserRow

  /** Enrollment is for a full session or one sent to enroll — not one owing a second factor. */
  const notPendingSecondFactor = (req: Request, res: Response, next: () => void) => {
    if (req.session.authLevel === 'mfa_pending') {
      res.status(401).json({ error: 'mfa_required', authLevel: 'mfa_pending' })
      return
    }
    next()
  }

  router.get('/api/auth/mfa', requireSignedIn, (req, res) => {
    const user = accountOf(req)
    res.json({ authLevel: req.session.authLevel, mfa: mfaStatus(db, user, config) })
  })

  /** Second step of sign-in, or step-up: a TOTP code or a recovery code. */
  router.post('/api/auth/mfa/verify', requireSignedIn, (req, res, next) => {
    void (async () => {
      const userId = userIdOf(req)
      if (req.session.authLevel === 'enrollment_required') {
        res.status(409).json({ error: 'enrollment_required' })
        return
      }
      if (limiter.blocked(userId)) {
        res.status(429).json({ error: 'too_many_attempts' })
        return
      }
      const code = (req.body as { code?: unknown } | undefined)?.code
      const method = typeof code === 'string' && code.length <= 32
        ? verifyTypedFactor(db, config.mfaEncryptionKey, userId, code)
        : null
      if (!method) {
        limiter.fail(userId)
        recordAuditEvent(db, { kind: 'mfa_failed', actorUserId: userId, ...requestAuditMeta(req), metadata: { method: 'code' } })
        res.status(401).json({ error: 'invalid_code' })
        return
      }
      limiter.reset(userId)
      const stage = req.session.authLevel === 'full' ? 'step_up' : 'sign_in'
      await markMfaVerified(req)
      recordAuditEvent(db, { kind: 'mfa_verified', actorUserId: userId, ...requestAuditMeta(req), metadata: { method, stage } })
      res.json({
        authLevel: 'full',
        ...(method === 'recovery' ? { recoveryCodesRemaining: recoveryCodesRemaining(db, userId) } : {}),
      })
    })().catch(next)
  })

  router.post('/api/auth/mfa/totp/setup', requireSignedIn, notPendingSecondFactor, requireRecentAuth, (req, res) => {
    if (!config.mfaEncryptionKey) {
      res.status(503).json({ error: 'totp_unavailable' })
      return
    }
    const user = accountOf(req)
    const result = beginTotpEnrollment(db, config.mfaEncryptionKey, user)
    if (!result.ok) {
      res.status(409).json({ error: result.reason })
      return
    }
    res.json({ secret: result.secret, uri: result.uri })
  })

  /** Confirm with a code from the app; returns the recovery codes, once. */
  router.post('/api/auth/mfa/totp/confirm', requireSignedIn, notPendingSecondFactor, (req, res, next) => {
    void (async () => {
      if (!config.mfaEncryptionKey) {
        res.status(503).json({ error: 'totp_unavailable' })
        return
      }
      const userId = userIdOf(req)
      if (limiter.blocked(userId)) {
        res.status(429).json({ error: 'too_many_attempts' })
        return
      }
      const code = (req.body as { code?: unknown } | undefined)?.code
      const firstFactor = !hasSecondFactor(db, userId)
      const result = typeof code === 'string'
        ? confirmTotpEnrollment(db, config.mfaEncryptionKey, userId, code)
        : ({ ok: false, reason: 'invalid_code' } as const)
      if (!result.ok) {
        if (result.reason === 'invalid_code') limiter.fail(userId)
        res.status(result.reason === 'invalid_code' ? 401 : 409).json({ error: result.reason })
        return
      }
      limiter.reset(userId)
      if (firstFactor) secureAfterFirstFactor(deps, req, userId)
      await markMfaVerified(req)
      recordAuditEvent(db, { kind: 'mfa_enabled', actorUserId: userId, ...requestAuditMeta(req), metadata: { factor: 'totp' } })
      res.json({ recoveryCodes: result.recoveryCodes, authLevel: 'full' })
    })().catch(next)
  })

  router.delete('/api/auth/mfa/totp', requireActiveUser, requireRecentAuth, (req, res) => {
    const user = accountOf(req)
    if (!hasTotp(db, user.id)) {
      res.status(404).json({ error: 'not_enabled' })
      return
    }
    // Removing the only factor of an account that must have one would leave
    // it signed in below what its role requires.
    if (passkeyCount(db, user.id) === 0 && isMfaRequired(db, user, config)) {
      res.status(409).json({ error: 'mfa_required_by_role' })
      return
    }
    disableTotp(db, user.id)
    if (!hasSecondFactor(db, user.id)) deleteRecoveryCodes(db, user.id)
    recordAuditEvent(db, { kind: 'mfa_disabled', actorUserId: user.id, ...requestAuditMeta(req), metadata: { factor: 'totp' } })
    res.json({ success: true })
  })

  router.post('/api/auth/mfa/recovery-codes', requireActiveUser, requireRecentAuth, (req, res) => {
    const userId = userIdOf(req)
    if (!hasSecondFactor(db, userId)) {
      res.status(409).json({ error: 'no_second_factor' })
      return
    }
    const codes = issueRecoveryCodes(db, userId)
    recordAuditEvent(db, { kind: 'mfa_recovery_codes_regenerated', actorUserId: userId, ...requestAuditMeta(req) })
    res.json({ recoveryCodes: codes })
  })

  return router
}
