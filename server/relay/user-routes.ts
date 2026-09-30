/**
 * Platform account administration (operator only).
 *
 * Roles belong to workspaces now (workspace-routes.ts); what remains here is
 * account-level and cuts across every workspace: the operator (the account
 * configured as OWNER_GITHUB_ID) can list accounts, disable or re-enable one
 * — the platform kill switch — and allow an account to create workspaces.
 * This is the only way to *set* status: the login upsert only ever upgrades,
 * so an account that should lose access can only be corrected here.
 *
 * The operator account is untouchable, and no one may change their own
 * access, so a mistake cannot lock the operator out.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import { createRequireActiveUser, createRequireRecentAuth, isOperator } from './relay-auth-routes.js'
import { getUserById, listUsers } from './control-plane-db.js'
import type { UserStatus, UserRow } from './control-plane-db.js'
import { recordAuditEvent } from './audit.js'
import type { BrowserHub } from './browser-hub.js'
import type { RelayConfig } from './relay-config.js'
import { revokePendingDeviceLinks } from './device-link.js'
import type { SqliteSessionStore } from './sqlite-session-store.js'

/** The slice of the session store this router needs (kept narrow for tests). */
type SessionRevoker = Pick<SqliteSessionStore, 'destroyUserSessions'>

const ASSIGNABLE_STATUSES: UserStatus[] = ['active', 'pending', 'disabled']

interface AdminUserView {
  id: string
  githubId: number
  login: string
  displayName: string | null
  avatarUrl: string | null
  status: UserStatus
  canCreateWorkspaces: boolean
  isOperator: boolean
}

function toAdminView(row: UserRow, config: RelayConfig): AdminUserView {
  const operator = isOperator(row, config)
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
    canCreateWorkspaces: operator || row.can_create_workspaces === 1,
    isOperator: operator,
  }
}

export function createUserRouter(
  db: Database.Database,
  config: RelayConfig,
  browserHub?: BrowserHub,
  store?: SessionRevoker,
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)
  const requireRecentAuth = createRequireRecentAuth(db)

  const requireOperator = (actorId: string): boolean => {
    const actor = getUserById(db, actorId)
    return actor !== undefined && isOperator(actor, config)
  }

  /** Every account on the platform. */
  router.get('/api/users', requireActiveUser, (req, res) => {
    const actor = req.session.user!
    if (!requireOperator(actor.id)) {
      res.status(403).json({ error: 'Only the platform operator can list accounts' })
      return
    }
    res.json({ users: listUsers(db).map(u => toAdminView(u, config)) })
  })

  /** Change an account's platform status and/or workspace-creation permission. */
  router.patch('/api/users/:id', requireActiveUser, requireRecentAuth, (req, res) => {
    const actor = req.session.user!
    if (!requireOperator(actor.id)) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        actorUserId: actor.id,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata: { stage: 'user_update', target: String(req.params.id) },
      })
      res.status(403).json({ error: 'Only the platform operator can change account access' })
      return
    }

    const target = getUserById(db, String(req.params.id))
    if (!target) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    // The operator is defined by config: never let it be disabled, or a
    // mistake could lock the platform out (disabled is sticky across logins).
    if (isOperator(target, config) || target.id === actor.id) {
      res.status(400).json({ error: 'The operator account cannot be changed here' })
      return
    }

    const body = req.body as { status?: unknown; canCreateWorkspaces?: unknown }
    let nextStatus = target.status
    let nextCanCreate = target.can_create_workspaces

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !ASSIGNABLE_STATUSES.includes(body.status as UserStatus)) {
        res.status(400).json({ error: `status must be one of: ${ASSIGNABLE_STATUSES.join(', ')}` })
        return
      }
      nextStatus = body.status as UserStatus
    }
    if (body.canCreateWorkspaces !== undefined) {
      if (typeof body.canCreateWorkspaces !== 'boolean') {
        res.status(400).json({ error: 'canCreateWorkspaces must be a boolean' })
        return
      }
      nextCanCreate = body.canCreateWorkspaces ? 1 : 0
    }

    if (nextStatus === target.status && nextCanCreate === target.can_create_workspaces) {
      res.json({ user: toAdminView(target, config) })
      return
    }

    db.prepare(
      `UPDATE users SET status = ?, can_create_workspaces = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(nextStatus, nextCanCreate, target.id)

    // Access just changed under the target's feet. requireActiveUser catches
    // their next REST call, but an open relay socket resolved its standing at
    // hello — drop it so a disabled user stops immediately.
    browserHub?.reauthorize({ userId: target.id })

    // Losing active status must also burn the stored cookies. requireActiveUser
    // already refuses them while the account is down, but the rows survive a
    // 30-day rolling lifetime: leaving them in place means re-activating the
    // account silently revives every cookie ever issued to it, including any
    // the revocation was meant to cut off.
    let destroyedSessions = 0
    if (nextStatus !== 'active') {
      destroyedSessions = store?.destroyUserSessions(target.id) ?? 0
      revokePendingDeviceLinks(db, target.id)
    }

    recordAuditEvent(db, {
      kind: 'user_updated',
      actorUserId: actor.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: {
        target: target.login,
        targetUserId: target.id,
        status: nextStatus,
        previousStatus: target.status,
        canCreateWorkspaces: nextCanCreate === 1,
        destroyedSessions,
      },
    })

    const updated = getUserById(db, target.id)!
    res.json({ user: toAdminView(updated, config) })
  })

  return router
}
