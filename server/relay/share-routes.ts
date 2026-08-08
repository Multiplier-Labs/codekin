/**
 * Share and audit endpoints (spec §8).
 *
 * Only a machine's owner may share its sessions, and only the user who
 * created a share may change or revoke it — sharing does not grant the power
 * to re-share.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { requireActiveUser } from './relay-auth-routes.js'
import {
  SHARE_ROLES,
  deleteShare,
  getShare,
  listSharesBy,
  listSharesFor,
  normalizePermissions,
  updateSharePermissions,
  upsertShare,
} from './shares.js'
import type { SessionPermission, ShareRole } from './shares.js'
import { listAuditEvents, recordAuditEvent } from './audit.js'

/** Resolve the permission set from either a role name or an explicit list. */
function resolvePermissions(body: { role?: unknown; permissions?: unknown }): SessionPermission[] | null {
  if (typeof body.role === 'string') {
    const role = body.role as ShareRole
    if (!(role in SHARE_ROLES)) return null
    return [...SHARE_ROLES[role]]
  }
  const permissions = normalizePermissions(body.permissions)
  return permissions.length > 0 ? permissions : null
}

export function createShareRouter(db: Database.Database): Router {
  const router = Router()

  /** Shares this user created, plus those granted to them. */
  router.get('/api/shares', requireActiveUser, (req, res) => {
    const user = req.session.user!
    res.json({
      shared: listSharesBy(db, user.id),
      receivedShares: listSharesFor(db, user.id),
    })
  })

  router.post('/api/shares', requireActiveUser, (req, res) => {
    const user = req.session.user!
    const body = req.body as {
      machineId?: unknown
      localSessionId?: unknown
      granteeLogin?: unknown
      role?: unknown
      permissions?: unknown
      expiresAt?: unknown
    }

    if (typeof body.machineId !== 'string' || typeof body.localSessionId !== 'string') {
      res.status(400).json({ error: 'machineId and localSessionId are required' })
      return
    }

    const machine = db.prepare('SELECT owner_user_id FROM machines WHERE id = ?').get(body.machineId) as
      | { owner_user_id: string }
      | undefined
    if (!machine) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    // Sharing is not transitive: only the owner may hand out access.
    if (machine.owner_user_id !== user.id) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        actorUserId: user.id,
        machineId: body.machineId,
        ip: req.ip ?? null,
        metadata: { stage: 'share_create' },
      })
      res.status(403).json({ error: 'Only the machine owner can share its sessions' })
      return
    }

    if (typeof body.granteeLogin !== 'string') {
      res.status(400).json({ error: 'granteeLogin is required' })
      return
    }
    const grantee = db
      .prepare('SELECT id, status FROM users WHERE lower(login) = lower(?)')
      .get(body.granteeLogin) as { id: string; status: string } | undefined
    if (!grantee) {
      res.status(404).json({ error: 'No such user has signed in yet' })
      return
    }
    if (grantee.id === user.id) {
      res.status(400).json({ error: 'You already own this session' })
      return
    }
    if (grantee.status !== 'active') {
      res.status(400).json({ error: 'That user does not have access yet' })
      return
    }

    const permissions = resolvePermissions(body)
    if (!permissions) {
      res.status(400).json({ error: 'Provide a valid role or permission list' })
      return
    }

    const share = upsertShare(db, {
      machineId: body.machineId,
      localSessionId: body.localSessionId,
      sharedByUserId: user.id,
      granteeUserId: grantee.id,
      permissions,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    })

    recordAuditEvent(db, {
      kind: 'session_shared',
      actorUserId: user.id,
      machineId: share.machineId,
      localSessionId: share.localSessionId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { grantee: body.granteeLogin, permissions: permissions.join(',') },
    })

    res.status(201).json({ share })
  })

  router.patch('/api/shares/:shareId', requireActiveUser, (req, res) => {
    const user = req.session.user!
    const shareId = String(req.params.shareId)
    const share = getShare(db, shareId)
    if (!share) {
      res.status(404).json({ error: 'Share not found' })
      return
    }
    if (share.sharedByUserId !== user.id) {
      res.status(403).json({ error: 'Only the user who shared this session can change it' })
      return
    }

    const body = req.body as { role?: unknown; permissions?: unknown; expiresAt?: unknown }
    const permissions = resolvePermissions(body)
    if (!permissions) {
      res.status(400).json({ error: 'Provide a valid role or permission list' })
      return
    }

    const updated = updateSharePermissions(
      db,
      share.id,
      permissions,
      typeof body.expiresAt === 'string' ? body.expiresAt : body.expiresAt === null ? null : undefined,
    )

    recordAuditEvent(db, {
      kind: 'session_shared',
      actorUserId: user.id,
      machineId: share.machineId,
      localSessionId: share.localSessionId,
      ip: req.ip ?? null,
      metadata: { updated: true, permissions: permissions.join(',') },
    })

    res.json({ share: updated })
  })

  router.delete('/api/shares/:shareId', requireActiveUser, (req, res) => {
    const user = req.session.user!
    const shareId = String(req.params.shareId)
    const share = getShare(db, shareId)
    if (!share) {
      res.status(404).json({ error: 'Share not found' })
      return
    }
    if (share.sharedByUserId !== user.id) {
      res.status(403).json({ error: 'Only the user who shared this session can revoke it' })
      return
    }

    deleteShare(db, share.id)
    recordAuditEvent(db, {
      kind: 'session_unshared',
      actorUserId: user.id,
      machineId: share.machineId,
      localSessionId: share.localSessionId,
      ip: req.ip ?? null,
      metadata: { grantee: share.granteeUserId },
    })

    res.json({ ok: true })
  })

  /**
   * Audit log. A user sees their own actions; a machine's owner additionally
   * sees everything that happened on their machines.
   */
  router.get('/api/audit-events', requireActiveUser, (req, res) => {
    const user = req.session.user!
    const machineId = typeof req.query.machineId === 'string' ? req.query.machineId : undefined
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined

    if (machineId) {
      const machine = db.prepare('SELECT owner_user_id FROM machines WHERE id = ?').get(machineId) as
        | { owner_user_id: string }
        | undefined
      if (!machine || machine.owner_user_id !== user.id) {
        res.status(403).json({ error: 'Only the machine owner can read its audit log' })
        return
      }
      res.json({ events: listAuditEvents(db, { machineId, limit }) })
      return
    }

    res.json({ events: listAuditEvents(db, { actorUserId: user.id, limit }) })
  })

  return router
}
