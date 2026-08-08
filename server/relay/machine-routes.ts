/**
 * Machine registry endpoints (read-only for now; pairing lands in the
 * connector phase).
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { listMachines } from './control-plane-db.js'
import { requireActiveUser } from './relay-auth-routes.js'

export function createMachineRouter(db: Database.Database): Router {
  const router = Router()

  router.get('/api/machines', requireActiveUser, (_req, res) => {
    const machines = listMachines(db).map(m => ({
      id: m.id,
      displayName: m.display_name,
      hostname: m.hostname,
      platform: m.platform,
      connectorVersion: m.connector_version,
      localCodekinVersion: m.local_codekin_version,
      status: m.status,
      lastSeenAt: m.last_seen_at,
    }))
    res.json({ machines })
  })

  return router
}
