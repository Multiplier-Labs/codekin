/**
 * WebAuthn passkey endpoints (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §5).
 *
 * Registration (signed-in): options → navigator.credentials.create →
 * verify. Login (signed-out): options with no allowCredentials — the
 * discoverable-credential flow, so no username is asked — → verify, which
 * mints a session exactly like the OAuth callback: user status re-read from
 * the DB, session regenerated. PUBLIC_URL is the expected origin and its
 * hostname the RP id; challenges live in the express session.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type Database from 'better-sqlite3'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers'
import type { RelayConfig } from './relay-config.js'
import {
  createRequireActiveUser,
  regenerateSession,
  saveSession,
  toSessionUser,
} from './relay-auth-routes.js'
import { getUserById } from './control-plane-db.js'
import {
  listPasskeys,
  listCredentialRows,
  getCredentialByCredentialId,
  insertCredential,
  recordCredentialUse,
  deletePasskey,
  parseTransports,
} from './webauthn.js'
import { recordAuditEvent } from './audit.js'

declare module 'express-session' {
  interface SessionData {
    webauthnRegChallenge?: string
    webauthnAuthChallenge?: string
  }
}

const RP_NAME = 'Codekin'

function auditMeta(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }
}

export function createWebauthnRouter(db: Database.Database, config: RelayConfig): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)
  const rpID = new URL(config.publicUrl).hostname
  const expectedOrigin = config.publicUrl

  router.post('/api/auth/webauthn/register/options', requireActiveUser, (req, res, next) => {
    void (async () => {
      // requireActiveUser just refreshed this from the DB
      const user = req.session.user
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID,
        userName: user.login,
        userDisplayName: user.displayName ?? user.login,
        userID: isoUint8Array.fromUTF8String(user.id),
        attestationType: 'none',
        excludeCredentials: listCredentialRows(db, user.id).map(row => ({
          id: row.credential_id,
          transports: parseTransports(row) as AuthenticatorTransportFuture[] | undefined,
        })),
        // A platform authenticator with a discoverable credential and user
        // verification is what makes login a single biometric prompt.
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
      })
      req.session.webauthnRegChallenge = options.challenge
      await saveSession(req)
      res.json({ options })
    })().catch(next)
  })

  router.post('/api/auth/webauthn/register/verify', requireActiveUser, (req, res, next) => {
    void (async () => {
      const user = req.session.user
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const body = (req.body ?? {}) as { response?: unknown; label?: unknown }
      const expectedChallenge = req.session.webauthnRegChallenge
      delete req.session.webauthnRegChallenge
      if (!expectedChallenge || !body.response || typeof body.response !== 'object') {
        res.status(400).json({ error: 'No registration in progress' })
        return
      }

      let verified = false
      let registrationInfo
      try {
        const result = await verifyRegistrationResponse({
          response: body.response as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin,
          expectedRPID: rpID,
        })
        verified = result.verified
        registrationInfo = result.registrationInfo
      } catch {
        // Malformed/forged attestations throw; to the client both are one thing
      }
      if (!verified || !registrationInfo) {
        res.status(400).json({ error: 'Passkey could not be verified' })
        return
      }

      const { credential } = registrationInfo
      const label = typeof body.label === 'string' ? body.label.slice(0, 64) : null
      const passkey = insertCredential(db, {
        userId: user.id,
        credentialId: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
        label,
      })
      recordAuditEvent(db, {
        kind: 'passkey_registered',
        actorUserId: user.id,
        ...auditMeta(req),
        metadata: { passkeyId: passkey.id },
      })
      res.json({ passkey })
    })().catch(next)
  })

  router.post('/api/auth/webauthn/login/options', (req, res, next) => {
    void (async () => {
      // Empty allowCredentials: the authenticator offers its discoverable
      // credentials, so the server never needs to know who is asking.
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
      })
      req.session.webauthnAuthChallenge = options.challenge
      await saveSession(req)
      res.json({ options })
    })().catch(next)
  })

  router.post('/api/auth/webauthn/login/verify', (req, res, next) => {
    void (async () => {
      const body = (req.body ?? {}) as { response?: unknown }
      const expectedChallenge = req.session.webauthnAuthChallenge
      delete req.session.webauthnAuthChallenge
      const response = body.response as AuthenticationResponseJSON | undefined
      if (!expectedChallenge || !response || typeof response !== 'object' || typeof response.id !== 'string') {
        res.status(400).json({ error: 'No login in progress' })
        return
      }

      const row = getCredentialByCredentialId(db, response.id)
      if (!row) {
        res.status(401).json({ error: 'Unknown passkey' })
        return
      }
      const user = getUserById(db, row.user_id)
      if (!user || user.status !== 'active') {
        res.status(403).json({ error: 'Access not granted' })
        return
      }

      let verified = false
      let newCounter = row.counter
      try {
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin,
          expectedRPID: rpID,
          credential: {
            id: row.credential_id,
            publicKey: isoBase64URL.toBuffer(row.public_key),
            counter: row.counter,
            transports: parseTransports(row) as AuthenticatorTransportFuture[] | undefined,
          },
        })
        verified = result.verified
        newCounter = result.authenticationInfo.newCounter
      } catch {
        // Bad signatures throw; same 401 as an unknown credential
      }
      if (!verified) {
        res.status(401).json({ error: 'Passkey could not be verified' })
        return
      }

      recordCredentialUse(db, row.id, newCounter)
      // Fresh session id before granting the session (fixation), same as the
      // OAuth callback.
      await regenerateSession(req)
      req.session.user = toSessionUser(user)
      await saveSession(req)
      recordAuditEvent(db, {
        kind: 'passkey_login',
        actorUserId: user.id,
        ...auditMeta(req),
        metadata: { passkeyId: row.id },
      })
      res.json({ user: req.session.user })
    })().catch(next)
  })

  router.get('/api/auth/passkeys', requireActiveUser, (req, res) => {
    const userId = req.session.user?.id ?? ''
    res.json({ passkeys: listPasskeys(db, userId) })
  })

  router.delete('/api/auth/passkeys/:id', requireActiveUser, (req, res) => {
    const userId = req.session.user?.id ?? ''
    const passkeyId = typeof req.params.id === 'string' ? req.params.id : ''
    // Deleting the last passkey is fine: GitHub OAuth remains the recovery path.
    if (!passkeyId || !deletePasskey(db, userId, passkeyId)) {
      res.status(404).json({ error: 'Passkey not found' })
      return
    }
    recordAuditEvent(db, {
      kind: 'passkey_removed',
      actorUserId: userId,
      ...auditMeta(req),
      metadata: { passkeyId },
    })
    res.json({ success: true })
  })

  return router
}
