/**
 * Workspace endpoints (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 1):
 * create/list/rename/delete workspaces, manage members, and the admin view
 * of a workspace's machines and audit log.
 *
 * Also exports `createRequireWorkspace`, which resolves the workspace a
 * request acts in for routes that are not addressed by workspace id
 * (machine list, pairing, share list).
 *
 * A workspace the caller is not an active member of reads as 404 on every
 * id-addressed route: its existence is not the caller's business.
 */

import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import { canCreateWorkspaces, createRequireActiveUser, ensureRecentAuth } from './relay-auth-routes.js'
import { hasSecondFactor } from './mfa.js'
import { BOOTSTRAP_WORKSPACE_ID, getUserById, listMachines } from './control-plane-db.js'
import type { WorkspaceRole } from './control-plane-db.js'
import {
  WORKSPACE_ROLES,
  can,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  getMembership,
  getWorkspace,
  isPrivilegedRole,
  listMembers,
  listUserWorkspaces,
  normalizeWorkspaceName,
  removeMember,
  renameWorkspace,
  setRequireMfa,
  transferMachine,
  updateMember,
} from './workspaces.js'
import type { Membership, MembershipStatus } from './workspaces.js'
import { listAuditEvents, recordAuditEvent } from './audit.js'
import { removeMachine } from './pairing.js'
import type { BrowserHub } from './browser-hub.js'
import type { ConnectorHub } from './connector-hub.js'

declare module 'express-serve-static-core' {
  interface Request {
    /** The caller's active membership in the workspace this request acts in. */
    workspace?: Membership
  }
}

/** Header the hosted frontend sends with the workspace the tab is in. */
export const WORKSPACE_HEADER = 'x-codekin-workspace'

/**
 * Resolve the workspace for a request (after requireActiveUser). An explicit
 * header must name a workspace the caller is an active member of; without
 * one, the caller's default workspace is used (see listUserWorkspaces).
 */
export function createRequireWorkspace(db: Database.Database) {
  return function requireWorkspace(req: Request, res: Response, next: NextFunction): void {
    const userId = req.session.user?.id
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const requested = req.get(WORKSPACE_HEADER)
    const membership = requested
      ? getActiveMembership(db, requested, userId)
      : (() => {
          const first = listUserWorkspaces(db, userId).at(0)
          return first ? getActiveMembership(db, first.id, userId) : undefined
        })()
    if (!membership) {
      res.status(403).json({ error: requested ? 'not_a_member' : 'no_workspace' })
      return
    }
    req.workspace = membership
    next()
  }
}

const MEMBER_STATUSES: MembershipStatus[] = ['active', 'suspended']

export interface WorkspaceRouterDeps {
  db: Database.Database
  config: RelayConfig
  browserHub?: BrowserHub
  connectorHub?: ConnectorHub
}

export function createWorkspaceRouter({ db, config, browserHub, connectorHub }: WorkspaceRouterDeps): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db, config)

  const audit = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null })
  /** Behind requireActiveUser, so always a signed-in id. */
  const actorId = (req: Request) => req.session.user?.id ?? ''

  /** The caller's active membership in `:id`, or a 404 already sent. */
  const memberOf = (req: Request, res: Response): Membership | null => {
    const membership = getActiveMembership(db, String(req.params.id), actorId(req))
    if (!membership) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    return membership
  }

  const forbid = (res: Response, error = 'Not permitted in this workspace') => {
    res.status(403).json({ error })
  }

  router.get('/api/workspaces', requireActiveUser, (req, res) => {
    res.json({ workspaces: listUserWorkspaces(db, actorId(req)) })
  })

  router.post('/api/workspaces', requireActiveUser, (req, res) => {
    const actor = getUserById(db, actorId(req))
    if (!actor || !canCreateWorkspaces(actor, config)) {
      forbid(res, 'Creating workspaces is not enabled for this account')
      return
    }
    const name = normalizeWorkspaceName((req.body as { name?: unknown }).name)
    if (!name) {
      res.status(400).json({ error: 'name must be 1–64 characters' })
      return
    }
    const workspace = createWorkspace(db, name, actor.id)
    recordAuditEvent(db, { kind: 'workspace_created', workspaceId: workspace.id, actorUserId: actor.id, ...audit(req) })
    res.status(201).json({ workspace: { id: workspace.id, name: workspace.name, role: 'owner', requireMfa: false } })
  })

  router.get('/api/workspaces/:id', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    const workspace = getWorkspace(db, membership.workspaceId)
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' })
      return
    }
    res.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        requireMfa: workspace.require_mfa === 1,
        createdAt: workspace.created_at,
      },
      role: membership.role,
    })
  })

  /** Rename, and/or require 2FA of every member (`requireMfa`). */
  router.patch('/api/workspaces/:id', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    if (!can(membership.role, 'workspace.edit')) {
      forbid(res)
      return
    }
    const body = req.body as { name?: unknown; requireMfa?: unknown }
    if (body.requireMfa !== undefined) {
      if (typeof body.requireMfa !== 'boolean') {
        res.status(400).json({ error: 'requireMfa must be a boolean' })
        return
      }
      const workspace = getWorkspace(db, membership.workspaceId)
      if (workspace && body.requireMfa !== (workspace.require_mfa === 1)) {
        // Turning it on: the owner must already meet the bar they set.
        if (body.requireMfa && !hasSecondFactor(db, membership.userId)) {
          res.status(409).json({ error: 'enroll_first' })
          return
        }
        // Turning it off lowers everyone's protection: a fresh check first.
        if (!body.requireMfa && !ensureRecentAuth(db, req, res)) return
        setRequireMfa(db, membership.workspaceId, body.requireMfa)
        if (body.requireMfa) {
          // Members without a factor drop to enrollment on their next request;
          // their open machine sockets end now.
          for (const member of listMembers(db, membership.workspaceId)) {
            if (!member.mfaEnabled) browserHub?.disconnectUser(member.userId, 'two-factor authentication required')
          }
        }
        recordAuditEvent(db, {
          kind: 'workspace_security_updated',
          workspaceId: membership.workspaceId,
          actorUserId: membership.userId,
          ...audit(req),
          metadata: { requireMfa: body.requireMfa },
        })
      }
      if (body.name === undefined) {
        res.json({ workspace: { id: membership.workspaceId, requireMfa: body.requireMfa } })
        return
      }
    }
    const name = normalizeWorkspaceName(body.name)
    if (!name) {
      res.status(400).json({ error: 'name must be 1–64 characters' })
      return
    }
    renameWorkspace(db, membership.workspaceId, name)
    recordAuditEvent(db, {
      kind: 'workspace_updated',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      ...audit(req),
      metadata: { name },
    })
    res.json({ workspace: { id: membership.workspaceId, name } })
  })

  router.delete('/api/workspaces/:id', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    if (!can(membership.role, 'workspace.delete')) {
      forbid(res)
      return
    }
    // Allowlisted accounts are admitted into the bootstrap workspace until
    // invitations replace the allowlist; it cannot go away before then.
    if (membership.workspaceId === BOOTSTRAP_WORKSPACE_ID) {
      res.status(400).json({ error: 'The default workspace cannot be deleted' })
      return
    }
    if (!ensureRecentAuth(db, req, res)) return
    const machineIds = deleteWorkspace(db, membership.workspaceId)
    for (const machineId of machineIds) browserHub?.reauthorize({ machineId })
    recordAuditEvent(db, {
      kind: 'workspace_deleted',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      ...audit(req),
    })
    res.json({ success: true })
  })

  router.get('/api/workspaces/:id/members', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    if (!can(membership.role, 'member.list')) {
      forbid(res)
      return
    }
    res.json({ members: listMembers(db, membership.workspaceId) })
  })

  /**
   * May `actor` act on a member currently holding `targetRole`, optionally
   * moving them to `nextRole`? Admins manage members and viewers; only owners
   * touch — or create — admins and owners.
   */
  const mayManage = (actor: Membership, targetRole: WorkspaceRole, nextRole?: WorkspaceRole): boolean => {
    if (!can(actor.role, 'member.manage')) return false
    const privileged = isPrivilegedRole(targetRole) || (nextRole !== undefined && isPrivilegedRole(nextRole))
    return !privileged || can(actor.role, 'member.manage_privileged')
  }

  router.patch('/api/workspaces/:id/members/:userId', requireActiveUser, (req, res) => {
    const actor = memberOf(req, res)
    if (!actor) return
    const targetId = String(req.params.userId)
    if (targetId === actor.userId) {
      res.status(400).json({ error: 'You cannot change your own membership; leave the workspace instead' })
      return
    }
    const target = getMembership(db, actor.workspaceId, targetId)
    if (!target) {
      res.status(404).json({ error: 'Member not found' })
      return
    }

    const body = req.body as { role?: unknown; status?: unknown }
    if (body.role !== undefined && !WORKSPACE_ROLES.includes(body.role as WorkspaceRole)) {
      res.status(400).json({ error: `role must be one of: ${WORKSPACE_ROLES.join(', ')}` })
      return
    }
    if (body.status !== undefined && !MEMBER_STATUSES.includes(body.status as MembershipStatus)) {
      res.status(400).json({ error: `status must be one of: ${MEMBER_STATUSES.join(', ')}` })
      return
    }
    const nextRole = body.role as WorkspaceRole | undefined
    if (!mayManage(actor, target.role, nextRole)) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        ...audit(req),
        metadata: { stage: 'member_update', targetUserId: targetId },
      })
      forbid(res)
      return
    }

    // Granting admin or owner (ownership transfer included) needs a fresh check.
    if (nextRole !== undefined && isPrivilegedRole(nextRole) && nextRole !== target.role && !ensureRecentAuth(db, req, res)) return
    const result = updateMember(db, actor.workspaceId, targetId, {
      role: nextRole,
      status: body.status as MembershipStatus | undefined,
    })
    if (!result.ok) {
      res.status(result.reason === 'last_owner' ? 409 : 404).json({ error: result.reason })
      return
    }
    // Standing on every machine in the workspace derives from the membership.
    browserHub?.reauthorize({ userId: targetId })
    recordAuditEvent(db, {
      kind: 'member_updated',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      ...audit(req),
      metadata: {
        targetUserId: targetId,
        role: result.membership.role,
        status: result.membership.status,
        previousRole: result.previous.role,
        previousStatus: result.previous.status,
      },
    })
    res.json({ membership: result.membership })
  })

  /** Remove a member, or leave (when the target is the caller). */
  router.delete('/api/workspaces/:id/members/:userId', requireActiveUser, (req, res) => {
    const actor = memberOf(req, res)
    if (!actor) return
    const targetId = String(req.params.userId)
    const leaving = targetId === actor.userId
    const target = leaving ? actor : getMembership(db, actor.workspaceId, targetId)
    if (!target) {
      res.status(404).json({ error: 'Member not found' })
      return
    }
    if (!leaving && !mayManage(actor, target.role)) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        ...audit(req),
        metadata: { stage: 'member_remove', targetUserId: targetId },
      })
      forbid(res)
      return
    }

    const result = removeMember(db, actor.workspaceId, targetId)
    if (!result.ok) {
      res.status(result.reason === 'last_owner' ? 409 : 404).json({ error: result.reason })
      return
    }
    browserHub?.reauthorize({ userId: targetId })
    // Grantees on the removed member's machines lose access with them.
    for (const machineId of result.quarantinedMachineIds) browserHub?.reauthorize({ machineId })
    recordAuditEvent(db, {
      kind: 'member_removed',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      ...audit(req),
      metadata: {
        targetUserId: targetId,
        left: leaving,
        previousRole: result.previous.role,
        quarantinedMachines: result.quarantinedMachineIds.length,
      },
    })
    res.json({ success: true, quarantinedMachineIds: result.quarantinedMachineIds })
  })

  /** Admin oversight: every machine in the workspace, metadata only. */
  router.get('/api/workspaces/:id/machines', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    if (!can(membership.role, 'machine.oversee')) {
      forbid(res)
      return
    }
    const owners = new Map(listMembers(db, membership.workspaceId).map(m => [m.userId, m.login]))
    const machines = listMachines(db, membership.workspaceId).map(m => ({
      id: m.id,
      displayName: m.display_name,
      hostname: m.hostname,
      platform: m.platform,
      status: m.status,
      lastSeenAt: m.last_seen_at,
      ownerUserId: m.owner_user_id,
      // A departed owner is no longer a member; their login is still useful.
      ownerLogin: owners.get(m.owner_user_id) ?? getUserById(db, m.owner_user_id)?.login ?? null,
      quarantined: m.quarantined_at !== null,
    }))
    res.json({ machines })
  })

  const machineInWorkspace = (workspaceId: string, machineId: string): boolean =>
    db.prepare('SELECT 1 FROM machines WHERE id = ? AND workspace_id = ?').get(machineId, workspaceId) !== undefined

  router.delete('/api/workspaces/:id/machines/:machineId', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    const machineId = String(req.params.machineId)
    if (!can(membership.role, 'machine.oversee')) {
      forbid(res)
      return
    }
    if (!machineInWorkspace(membership.workspaceId, machineId) || !removeMachine(db, machineId)) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    connectorHub?.disconnectMachine(machineId)
    browserHub?.reauthorize({ machineId })
    recordAuditEvent(db, {
      kind: 'machine_removed',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      machineId,
      ...audit(req),
      metadata: { by: 'workspace_admin' },
    })
    res.json({ success: true })
  })

  router.post('/api/workspaces/:id/machines/:machineId/transfer', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    const machineId = String(req.params.machineId)
    if (!can(membership.role, 'machine.oversee')) {
      forbid(res)
      return
    }
    const newOwner = (req.body as { userId?: unknown }).userId
    if (typeof newOwner !== 'string') {
      res.status(400).json({ error: 'userId is required' })
      return
    }
    const result = transferMachine(db, membership.workspaceId, machineId, newOwner)
    if (!result.ok) {
      res.status(result.reason === 'machine_not_found' ? 404 : 400).json({ error: result.reason })
      return
    }
    browserHub?.reauthorize({ machineId })
    recordAuditEvent(db, {
      kind: 'machine_transferred',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      machineId,
      ...audit(req),
      metadata: { newOwnerUserId: newOwner },
    })
    res.json({ success: true })
  })

  router.get('/api/workspaces/:id/audit', requireActiveUser, (req, res) => {
    const membership = memberOf(req, res)
    if (!membership) return
    if (!can(membership.role, 'audit.workspace')) {
      forbid(res)
      return
    }
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined
    res.json({ events: listAuditEvents(db, { workspaceId: membership.workspaceId, limit }) })
  })

  return router
}
