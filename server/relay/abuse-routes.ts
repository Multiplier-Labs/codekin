/**
 * The operator's abuse review queue (docs/RELAY-HARDENING.md §6):
 * `GET /api/admin/abuse-flags` lists flags, `POST .../:id/resolve` closes one.
 * Platform operator only, at full auth level; resolving also needs a recent
 * second factor. Disabling the machine's owner is a separate, deliberate
 * action in the existing account controls.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { getUserById } from './control-plane-db.js'
import { createRequireActiveUser, createRequireRecentAuth, isOperator } from './relay-auth-routes.js'
import type { RelayConfig } from './relay-config.js'
import { listAbuseFlags, resolveAbuseFlag } from './abuse-signals.js'

export function createAbuseRouter(
  db: Database.Database,
  config: Pick<RelayConfig, 'ownerGithubId'>,
  onResolved: () => void = () => {},
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)
  const requireRecentAuth = createRequireRecentAuth(db)
  const operator = (userId: string | undefined): boolean => {
    const actor = getUserById(db, userId ?? '')
    return actor !== undefined && isOperator(actor, config)
  }

  router.get('/api/admin/abuse-flags', requireActiveUser, (req, res) => {
    if (!operator(req.session.user?.id)) {
      res.status(403).json({ error: 'Only the platform operator can review abuse flags' })
      return
    }
    const status = req.query.status === 'all' ? 'all' : 'open'
    res.set('Cache-Control', 'no-store').json({ flags: listAbuseFlags(db, status) })
  })

  router.post('/api/admin/abuse-flags/:id/resolve', requireActiveUser, requireRecentAuth, (req, res) => {
    const actorId = req.session.user?.id ?? ''
    if (!operator(actorId)) {
      res.status(403).json({ error: 'Only the platform operator can resolve abuse flags' })
      return
    }
    const note = typeof (req.body as { note?: unknown } | undefined)?.note === 'string' ? (req.body as { note: string }).note.trim() : ''
    if (!note) {
      res.status(400).json({ error: 'A note saying what was decided is required' })
      return
    }
    const flag = resolveAbuseFlag(db, String(req.params.id), actorId, note)
    if (!flag) {
      res.status(404).json({ error: 'No open flag with that id' })
      return
    }
    onResolved()
    res.json({ flag })
  })

  return router
}
