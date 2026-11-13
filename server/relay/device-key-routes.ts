/**
 * The signed-in user's browser keys as the relay has seen them
 * (signed-intents spec §4.2):
 *
 *   POST   /api/device-keys          { spki, label } register this browser's key
 */

import { Router } from 'express'
import type { Request } from 'express'
import type Database from 'better-sqlite3'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { upsertDeviceKey } from './device-keys.js'
import type { RelayConfig } from './relay-config.js'

export function createDeviceKeyRouter(db: Database.Database, config: RelayConfig): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)

  // requireActiveUser guarantees a session user; this only satisfies the types.
  const userOf = (req: Request): string => req.session.user?.id ?? ''

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

  return router
}
