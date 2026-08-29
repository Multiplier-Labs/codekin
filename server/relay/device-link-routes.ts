/**
 * REST endpoints for device linking (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §4).
 *
 * start/status are called by the signed-in browser that shows the QR and
 * require an active user. complete is called by the new device and is
 * unauthenticated — possession of the single-use code is the credential; it
 * mints a session for the code's creator. All three live under /api/auth and
 * inherit its per-IP rate limit.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import {
  createRequireActiveUser,
  regenerateSession,
  saveSession,
  toSessionUser,
} from './relay-auth-routes.js'
import { getUserById } from './control-plane-db.js'
import { startDeviceLink, getDeviceLinkStatus, completeDeviceLink } from './device-link.js'
import { recordAuditEvent } from './audit.js'

export function createDeviceLinkRouter(db: Database.Database, config: RelayConfig): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)

  router.post('/api/auth/device-link/start', requireActiveUser, (req, res) => {
    const userId = req.session.user?.id ?? ''
    const { requestId, code, expiresAt } = startDeviceLink(db, userId)
    recordAuditEvent(db, {
      kind: 'device_link_created',
      actorUserId: userId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { requestId },
    })
    // The code rides in the URL fragment: it is never sent to the server on
    // page load, so it cannot land in access logs or Referer headers.
    res.json({ requestId, linkUrl: `${config.publicUrl}/link#${code}`, expiresAt })
  })

  router.get('/api/auth/device-link/:requestId/status', requireActiveUser, (req, res) => {
    const userId = req.session.user?.id ?? ''
    const requestId = typeof req.params.requestId === 'string' ? req.params.requestId : ''
    const status = requestId ? getDeviceLinkStatus(db, requestId, userId) : null
    if (!status) {
      res.status(404).json({ error: 'Link request not found' })
      return
    }
    res.json({ status })
  })

  router.post('/api/auth/device-link/complete', (req, res, next) => {
    void (async () => {
      const body = (req.body ?? {}) as { code?: unknown }
      if (typeof body.code !== 'string' || !body.code) {
        res.status(400).json({ error: 'code required' })
        return
      }
      const result = completeDeviceLink(db, body.code, {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      })
      if (result.status === 'expired') {
        res.status(410).json({ error: 'expired' })
        return
      }
      if (result.status === 'not_found') {
        res.status(404).json({ error: 'not_found' })
        return
      }

      // The code only proves who minted it; whether that account may still
      // sign in is the database's call, same as every other auth path.
      const user = getUserById(db, result.createdByUserId)
      if (!user || user.status !== 'active') {
        res.status(403).json({ error: 'Access not granted' })
        return
      }

      // Fresh session id before granting the session (fixation), same as the
      // OAuth callback.
      await regenerateSession(req)
      req.session.user = toSessionUser(user)
      await saveSession(req)
      recordAuditEvent(db, {
        kind: 'device_linked',
        actorUserId: user.id,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata: { requestId: result.requestId },
      })
      res.json({ user: req.session.user })
    })().catch(next)
  })

  return router
}
