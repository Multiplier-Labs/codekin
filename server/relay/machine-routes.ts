/**
 * Machine registry endpoints.
 *
 * Within the current workspace, a user sees the machines they own plus any
 * machine holding a session shared with them — the latter marked as such,
 * since what they can do there is limited to the shared sessions.
 * Quarantined machines (owner left the workspace) are not listed here; the
 * admin view in workspace-routes.ts shows them.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { listMachines } from './control-plane-db.js'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { createRequireWorkspace } from './workspace-routes.js'
import { listSharesFor } from './shares.js'
import { getMachineSetupStates, isSetupPending, sweepOrphanMachines } from './pairing.js'
import type { ConnectorHub } from './connector-hub.js'
import type { RelayConfig } from './relay-config.js'

export function createMachineRouter(db: Database.Database, hub?: ConnectorHub, config?: Pick<RelayConfig, 'ownerGithubId'>): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)
  const requireWorkspace = createRequireWorkspace(db)

  router.get('/api/machines', requireActiveUser, requireWorkspace, (req, res) => {
    const user = req.session.user!
    const workspace = req.workspace!
    // Lazily drop machines whose install command expired unclaimed, so a
    // reload never shows a stale "Unnamed machine" that can never connect.
    sweepOrphanMachines(db)
    const setupStates = getMachineSetupStates(db)
    const sharedMachineIds = new Set(
      listSharesFor(db, user.id, new Date(), workspace.workspaceId).map(share => share.machineId),
    )

    const machines = listMachines(db, workspace.workspaceId)
      .filter(m => m.quarantined_at === null)
      .filter(m => m.owner_user_id === user.id || sharedMachineIds.has(m.id))
      .map(m => {
        const setup = setupStates.get(m.id)
        const setupPending = isSetupPending(setup)
        return {
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
          // Created by an install command that has not been run yet; the UI
          // offers resume/regenerate/cancel rather than "offline".
          setupPending,
          pairingExpiresAt: setup && setupPending ? setup.pendingPairingExpiresAt : null,
        }
      })
    res.json({ workspaceId: workspace.workspaceId, machines })
  })

  return router
}
