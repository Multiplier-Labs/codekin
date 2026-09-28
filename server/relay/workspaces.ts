/**
 * Workspaces and memberships (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 1).
 *
 * A workspace is the tenant boundary: machines, shares and audit events each
 * belong to exactly one, and every standing a user has inside it comes from
 * an active membership there. Roles are per workspace; a user's platform
 * status (users.status) is the operator's kill switch across all of them.
 *
 * Authorization is `can(role, action)` against one matrix, never ad-hoc role
 * comparisons in route handlers.
 */

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import type { UserRow, WorkspaceRole } from './control-plane-db.js'

export type MembershipStatus = 'active' | 'suspended'

export const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer']

export type WorkspaceAction =
  /** Register a machine into the workspace (it becomes the actor's). */
  | 'machine.pair'
  /** Share sessions of one's own machines. */
  | 'machine.share'
  /** See every machine's metadata; remove or transfer any machine. Never drives sessions. */
  | 'machine.oversee'
  | 'member.list'
  /** Invite members and viewers (inviting an admin also needs member.manage_privileged). */
  | 'member.invite'
  /** Suspend, remove or re-role members and viewers. */
  | 'member.manage'
  /** The same for admins and owners, and granting those roles. */
  | 'member.manage_privileged'
  | 'audit.workspace'
  | 'workspace.edit'
  | 'workspace.delete'

const MATRIX: Record<WorkspaceAction, readonly WorkspaceRole[]> = {
  'machine.pair': ['owner', 'admin', 'member'],
  'machine.share': ['owner', 'admin', 'member'],
  'machine.oversee': ['owner', 'admin'],
  'member.list': ['owner', 'admin', 'member', 'viewer'],
  'member.invite': ['owner', 'admin'],
  'member.manage': ['owner', 'admin'],
  'member.manage_privileged': ['owner'],
  'audit.workspace': ['owner', 'admin'],
  'workspace.edit': ['owner'],
  'workspace.delete': ['owner'],
}

export function can(role: WorkspaceRole | null | undefined, action: WorkspaceAction): boolean {
  return role != null && MATRIX[action].includes(role)
}

const PRIVILEGED: readonly WorkspaceRole[] = ['owner', 'admin']

export function isPrivilegedRole(role: WorkspaceRole): boolean {
  return PRIVILEGED.includes(role)
}

export interface WorkspaceRow {
  id: string
  name: string
  require_mfa: number
  created_by_user_id: string | null
  created_at: string
  deleted_at: string | null
}

export interface Membership {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  status: MembershipStatus
}

interface MembershipRow {
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  status: MembershipStatus
  created_at: string
}

function toMembership(row: MembershipRow): Membership {
  return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role, status: row.status }
}

export function getWorkspace(db: Database.Database, workspaceId: string): WorkspaceRow | undefined {
  return db
    .prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL')
    .get(workspaceId) as WorkspaceRow | undefined
}

/** A membership regardless of its status, in a live workspace. */
export function getMembership(db: Database.Database, workspaceId: string, userId: string): Membership | undefined {
  const row = db
    .prepare(
      `SELECT m.* FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
    )
    .get(workspaceId, userId) as MembershipRow | undefined
  return row ? toMembership(row) : undefined
}

/** The membership that confers standing: active, in a live workspace. */
export function getActiveMembership(db: Database.Database, workspaceId: string, userId: string): Membership | undefined {
  const membership = getMembership(db, workspaceId, userId)
  return membership?.status === 'active' ? membership : undefined
}

export interface UserWorkspace {
  id: string
  name: string
  role: WorkspaceRole
  requireMfa: boolean
}

/**
 * The workspaces a user can enter, bootstrap first and then oldest
 * membership first — also the order the default workspace is picked in.
 */
export function listUserWorkspaces(db: Database.Database, userId: string): UserWorkspace[] {
  const rows = db
    .prepare(
      `SELECT w.id, w.name, w.require_mfa, m.role FROM workspace_memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.status = 'active' AND w.deleted_at IS NULL
       ORDER BY (w.id = ?) DESC, m.created_at, w.id`,
    )
    .all(userId, BOOTSTRAP_WORKSPACE_ID) as Array<{ id: string; name: string; require_mfa: number; role: WorkspaceRole }>
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role, requireMfa: r.require_mfa === 1 }))
}

export const MAX_WORKSPACE_NAME = 64

/** Trimmed, non-empty, bounded; null when unusable. */
export function normalizeWorkspaceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ')
  if (!name || name.length > MAX_WORKSPACE_NAME) return null
  return name
}

/** Create a workspace with its creator as the sole owner, atomically. */
export function createWorkspace(db: Database.Database, name: string, ownerUserId: string): WorkspaceRow {
  const id = randomUUID()
  db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, created_by_user_id) VALUES (?, ?, ?)').run(id, name, ownerUserId)
    db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')`).run(
      id,
      ownerUserId,
    )
  })()
  return getWorkspace(db, id) as WorkspaceRow
}

export function renameWorkspace(db: Database.Database, workspaceId: string, name: string): void {
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ? AND deleted_at IS NULL').run(name, workspaceId)
}

/**
 * Soft-delete a workspace. Its memberships stop conferring anything and its
 * shares are dropped; machine rows are kept for the audit trail but become
 * unreachable (access requires an active membership in a live workspace).
 * Returns the ids of its machines so callers can drop live sockets.
 */
export function deleteWorkspace(db: Database.Database, workspaceId: string): string[] {
  return db.transaction(() => {
    db.prepare(`UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(workspaceId)
    db.prepare('DELETE FROM session_shares WHERE workspace_id = ?').run(workspaceId)
    return (db.prepare('SELECT id FROM machines WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>).map(
      r => r.id,
    )
  })()
}

export interface WorkspaceMember {
  userId: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  role: WorkspaceRole
  status: MembershipStatus
  /** Platform status; a disabled account has no standing anywhere. */
  accountStatus: UserRow['status']
  joinedAt: string
}

export function listMembers(db: Database.Database, workspaceId: string): WorkspaceMember[] {
  const rows = db
    .prepare(
      `SELECT m.user_id, m.role, m.status, m.created_at, u.login, u.display_name, u.avatar_url, u.status AS account_status
       FROM workspace_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? ORDER BY u.login COLLATE NOCASE`,
    )
    .all(workspaceId) as Array<{
    user_id: string
    role: WorkspaceRole
    status: MembershipStatus
    created_at: string
    login: string
    display_name: string | null
    avatar_url: string | null
    account_status: UserRow['status']
  }>
  return rows.map(r => ({
    userId: r.user_id,
    login: r.login,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    role: r.role,
    status: r.status,
    accountStatus: r.account_status,
    joinedAt: r.created_at,
  }))
}

/** Active owners other than `exceptUserId`, whose accounts are also active. */
function otherActiveOwners(db: Database.Database, workspaceId: string, exceptUserId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM workspace_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.role = 'owner' AND m.status = 'active'
         AND u.status = 'active' AND m.user_id != ?`,
    )
    .get(workspaceId, exceptUserId) as { n: number }
  return row.n
}

export type MemberChangeResult =
  | { ok: true; membership: Membership; previous: Membership }
  | { ok: false; reason: 'not_found' | 'last_owner' }

/**
 * Change a member's role and/or status. Refused when it would leave the
 * workspace without an active owner; the check and the write share one
 * transaction so two concurrent demotions cannot both pass it.
 */
export function updateMember(
  db: Database.Database,
  workspaceId: string,
  userId: string,
  change: { role?: WorkspaceRole; status?: MembershipStatus },
): MemberChangeResult {
  return db.transaction((): MemberChangeResult => {
    const previous = getMembership(db, workspaceId, userId)
    if (!previous) return { ok: false, reason: 'not_found' }
    const role = change.role ?? previous.role
    const status = change.status ?? previous.status
    const losesOwnership = previous.role === 'owner' && previous.status === 'active' && (role !== 'owner' || status !== 'active')
    if (losesOwnership && otherActiveOwners(db, workspaceId, userId) === 0) {
      return { ok: false, reason: 'last_owner' }
    }
    db.prepare(
      `UPDATE workspace_memberships SET role = ?, status = ?, updated_at = datetime('now')
       WHERE workspace_id = ? AND user_id = ?`,
    ).run(role, status, workspaceId, userId)
    return { ok: true, membership: { ...previous, role, status }, previous }
  })()
}

export type MemberRemovalResult =
  | { ok: true; previous: Membership; quarantinedMachineIds: string[] }
  | { ok: false; reason: 'not_found' | 'last_owner' }

/**
 * Remove a member (or let them leave). Their machines in the workspace are
 * quarantined — unreachable until an admin transfers or removes them — and
 * every share in the workspace to or from them is dropped. Their account and
 * their other workspaces are untouched.
 */
export function removeMember(db: Database.Database, workspaceId: string, userId: string): MemberRemovalResult {
  return db.transaction((): MemberRemovalResult => {
    const previous = getMembership(db, workspaceId, userId)
    if (!previous) return { ok: false, reason: 'not_found' }
    if (previous.role === 'owner' && previous.status === 'active' && otherActiveOwners(db, workspaceId, userId) === 0) {
      return { ok: false, reason: 'last_owner' }
    }
    db.prepare('DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId)
    db.prepare(
      'DELETE FROM session_shares WHERE workspace_id = ? AND (grantee_user_id = ? OR shared_by_user_id = ?)',
    ).run(workspaceId, userId, userId)
    const machineIds = (
      db
        .prepare('SELECT id FROM machines WHERE workspace_id = ? AND owner_user_id = ? AND quarantined_at IS NULL')
        .all(workspaceId, userId) as Array<{ id: string }>
    ).map(r => r.id)
    db.prepare(
      `UPDATE machines SET quarantined_at = datetime('now')
       WHERE workspace_id = ? AND owner_user_id = ? AND quarantined_at IS NULL`,
    ).run(workspaceId, userId)
    return { ok: true, previous, quarantinedMachineIds: machineIds }
  })()
}

export type MachineTransferResult =
  | { ok: true }
  | { ok: false; reason: 'machine_not_found' | 'invalid_owner' }

/**
 * Hand a machine to another member (and lift any quarantine). The new owner
 * must be able to hold machines there. Shares the old owner made on it are
 * dropped: they were that person's decisions about their own sessions.
 */
export function transferMachine(
  db: Database.Database,
  workspaceId: string,
  machineId: string,
  newOwnerUserId: string,
): MachineTransferResult {
  return db.transaction((): MachineTransferResult => {
    const machine = db
      .prepare('SELECT owner_user_id FROM machines WHERE id = ? AND workspace_id = ?')
      .get(machineId, workspaceId) as { owner_user_id: string } | undefined
    if (!machine) return { ok: false, reason: 'machine_not_found' }
    const target = getActiveMembership(db, workspaceId, newOwnerUserId)
    if (!target || !can(target.role, 'machine.pair')) return { ok: false, reason: 'invalid_owner' }
    if (machine.owner_user_id !== newOwnerUserId) {
      db.prepare('DELETE FROM session_shares WHERE machine_id = ?').run(machineId)
    }
    db.prepare('UPDATE machines SET owner_user_id = ?, quarantined_at = NULL WHERE id = ?').run(newOwnerUserId, machineId)
    return { ok: true }
  })()
}
