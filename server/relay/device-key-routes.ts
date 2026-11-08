/**
 * The signed-in user's browser keys as the relay has seen them
 * (signed-intents spec §4.2, §6.9 "Account → Devices"):
 *
 *   GET    /api/device-keys          this user's registered keys
 *   POST   /api/device-keys          { spki, label } register this browser's key
 *   DELETE /api/device-keys/:keyId   drop one from the registry
 *
 * Removing a key here does not remove it from any machine; that takes the
 * machine's own Settings or `codekin relay devices revoke` (or, from slice 5,
 * a signed `device_revoke` intent).
 */

import { Router } from 'express'
import type { Request } from 'express'
import type Database from 'better-sqlite3'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { listDeviceKeys, removeDeviceKey, upsertDeviceKey } from './device-keys.js'
import { recordAuditEvent } from './audit.js'
import type { RelayConfig } from './relay-config.js'

export function createDeviceKeyRouter(db: Database.Database, config: RelayConfig): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)

  // requireActiveUser guarantees a session user; this only satisfies the types.
  const userOf = (req: Request): string => req.session.user?.id ?? ''

  router.get('/api/device-keys', requireActiveUser, (req, res) => {
    res.json({ keys: listDeviceKeys(db, userOf(req)) })
  })

  /**
   * Register this browser's key, so an owner sharing a session with this user
   * can name it in the grant (§6.7). A hint like the rest of the registry:
   * the owner signs it after seeing its label, and only the owner's grant
   * gives it any authority.
   */
  router.post('/api/device-keys', requireActiveUser, (req, res) => {
    const body = req.body as { spki?: unknown; label?: unknown }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 64) : ''
    const keyId = upsertDeviceKey(db, userOf(req), body.spki, label || 'Browser')
    if (!keyId) {
      res.status(400).json({ error: 'spki must be a P-256 public key' })
      return
    }
    res.json({ keyId })
  })

  router.delete('/api/device-keys/:keyId', requireActiveUser, (req, res) => {
    const userId = userOf(req)
    const keyId = String(req.params.keyId)
    if (!removeDeviceKey(db, userId, keyId)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    recordAuditEvent(db, { kind: 'device_key_removed', actorUserId: userId, metadata: { keyId } })
    res.json({ removed: true })
  })

  return router
}
