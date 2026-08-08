/**
 * Machine registry endpoints.
 *
 * A user sees the machines they own, plus any machine holding a session
 * shared with them — the latter marked as such, since what they can do
 * there is limited to the shared sessions.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { listMachines } from './control-plane-db.js'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { listSharesFor } from './shares.js'
import type { ConnectorHub } from './connector-hub.js'

export function createMachineRouter(db: Database.Database, hub?: ConnectorHub): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)

  router.get('/api/machines', requireActiveUser, (req, res) => {
    const user = req.session.user!
    const sharedMachineIds = new Set(listSharesFor(db, user.id).map(share => share.machineId))

    const machines = listMachines(db)
      .filter(m => m.owner_user_id === user.id || sharedMachineIds.has(m.id))
      .map(m => ({
        id: m.id,
        displayName: m.display_name,
        hostname: m.hostname,
        platform: m.platform,
        connectorVersion: m.connector_version,
        localCodekinVersion: m.local_codekin_version,
        status: m.status,
        lastSeenAt: m.last_seen_at,
        access: m.owner_user_id === user.id ? 'owner' : 'shared',
        connectorOutdated: hub?.isOutdated(m.id) ?? false,
        sessions: hub?.sessionSummary(m.id) ?? null,
      }))
    res.json({ machines })
  })

  return router
}
