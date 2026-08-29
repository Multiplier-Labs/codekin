/**
 * User administration endpoints (spec §7).
 *
 * A signed-in owner or admin can list the org's users and change a user's
 * status (the revocation path: disabling a user cuts their access
 * immediately) or role. This is the only way to *set* status: the login
 * upsert only ever upgrades, so a user granted access by mistake — or one
 * that should lose it — can only be corrected here.
 *
 * The configured owner account is untouchable, and no one may change their
 * own access, so neither a mistake nor a hostile admin can lock the owner out
 * or lock themselves in.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { getUserById, listUsers } from './control-plane-db.js'
import type { UserRole, UserStatus, UserRow } from './control-plane-db.js'
import { recordAuditEvent } from './audit.js'
import type { BrowserHub } from './browser-hub.js'
import type { RelayConfig } from './relay-config.js'

/** Roles allowed to administer other users. */
const MANAGER_ROLES: UserRole[] = ['owner', 'admin']
/**
 * Roles an admin action may assign. `owner` is absent on purpose: ownership
 * follows the configured OWNER_GITHUB_ID, not a hand-set column, so there is
 * exactly one owner and it cannot be created by an API call.
 */
const ASSIGNABLE_ROLES: UserRole[] = ['admin', 'member', 'viewer']
const ASSIGNABLE_STATUSES: UserStatus[] = ['active', 'pending', 'disabled']

interface AdminUserView {
  id: string
  githubId: number
  login: string
  displayName: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
  isOwner: boolean
}

function toAdminView(row: UserRow, config: RelayConfig): AdminUserView {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    isOwner: row.github_id === config.ownerGithubId,
  }
}

export function createUserRouter(
  db: Database.Database,
  config: RelayConfig,
  browserHub?: BrowserHub,
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)

  /** List every user in the org, for the admin management view. */
  router.get('/api/users', requireActiveUser, (req, res) => {
    const actor = req.session.user!
    if (!MANAGER_ROLES.includes(actor.role)) {
      res.status(403).json({ error: 'Only an owner or admin can list users' })
      return
    }
    res.json({ users: listUsers(db).map(u => toAdminView(u, config)) })
  })

  /** Change a user's status and/or role. */
  router.patch('/api/users/:id', requireActiveUser, (req, res) => {
    const actor = req.session.user!
    if (!MANAGER_ROLES.includes(actor.role)) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        actorUserId: actor.id,
        ip: req.ip ?? null,
        metadata: { stage: 'user_update', target: String(req.params.id) },
      })
      res.status(403).json({ error: 'Only an owner or admin can change user access' })
      return
    }

    const target = getUserById(db, String(req.params.id))
    if (!target) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    // The owner is defined by config, not by this column: never let it be
    // disabled or demoted, or a rename/mistake could lock the org's owner out
    // (disabled is sticky across logins, so it would not self-heal).
    if (target.github_id === config.ownerGithubId) {
      res.status(403).json({ error: 'The owner account cannot be changed here' })
      return
    }
    // No self-service: an admin cannot disable themselves into a dead end, nor
    // keep themselves active against the owner's wishes by editing their row.
    if (target.id === actor.id) {
      res.status(400).json({ error: 'You cannot change your own access' })
      return
    }

    const body = req.body as { status?: unknown; role?: unknown }
    let nextStatus = target.status
    let nextRole = target.role

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !ASSIGNABLE_STATUSES.includes(body.status as UserStatus)) {
        res.status(400).json({ error: `status must be one of: ${ASSIGNABLE_STATUSES.join(', ')}` })
        return
      }
      nextStatus = body.status as UserStatus
    }

    if (body.role !== undefined) {
      // Only the owner sets roles; an admin manages access (status), not rank.
      if (actor.role !== 'owner') {
        res.status(403).json({ error: 'Only the owner can change roles' })
        return
      }
      if (typeof body.role !== 'string' || !ASSIGNABLE_ROLES.includes(body.role as UserRole)) {
        res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
        return
      }
      nextRole = body.role as UserRole
    }

    if (nextStatus === target.status && nextRole === target.role) {
      res.json({ user: toAdminView(target, config) })
      return
    }

    db.prepare(
      `UPDATE users SET status = ?, role = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(nextStatus, nextRole, target.id)

    // Access just changed under the target's feet. requireActiveUser catches
    // their next REST call, but an open relay socket resolved its standing at
    // hello — drop it so a disabled or demoted user stops immediately.
    browserHub?.reauthorize({ userId: target.id })

    recordAuditEvent(db, {
      kind: 'user_updated',
      actorUserId: actor.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: {
        target: target.login,
        targetUserId: target.id,
        status: nextStatus,
        role: nextRole,
        previousStatus: target.status,
        previousRole: target.role,
      },
    })

    const updated = getUserById(db, target.id)!
    res.json({ user: toAdminView(updated, config) })
  })

  return router
}
