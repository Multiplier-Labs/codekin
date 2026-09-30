/**
 * Session sharing and access resolution (spec §6.3, §10).
 *
 * A share grants one user a set of permissions on one session of one
 * machine. Machines themselves are never shared: the owner shares a
 * specific session, and everything the grantee may do is derived from that
 * grant — both here, where the hub gates the connection, and again on the
 * connector, which re-checks before touching the local server.
 */

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { UserRow, WorkspaceRole } from './control-plane-db.js'
import { getActiveMembership } from './workspaces.js'

export type SessionPermission =
  | 'view'
  | 'send_prompt'
  | 'upload_file'
  | 'view_diff'
  | 'approve_readonly_tool'
  | 'approve_mutating_tool'
  | 'approve_shell'
  | 'stop_session'

export const ALL_PERMISSIONS: SessionPermission[] = [
  'view',
  'send_prompt',
  'upload_file',
  'view_diff',
  'approve_readonly_tool',
  'approve_mutating_tool',
  'approve_shell',
  'stop_session',
]

/**
 * Named presets matching the spec's default table (§10). Approving mutating
 * tools and shell commands is deliberately absent from both: those stay with
 * the owner unless granted explicitly.
 */
export const SHARE_ROLES = {
  viewer: ['view', 'view_diff'] as SessionPermission[],
  editor: ['view', 'view_diff', 'send_prompt', 'upload_file', 'approve_readonly_tool'] as SessionPermission[],
} as const

export type ShareRole = keyof typeof SHARE_ROLES

export interface SessionShareRow {
  id: string
  workspace_id: string
  machine_id: string
  local_session_id: string
  shared_by_user_id: string
  grantee_user_id: string | null
  permissions: string
  created_at: string
  expires_at: string | null
}

export interface SessionShare {
  id: string
  workspaceId: string
  machineId: string
  localSessionId: string
  sharedByUserId: string
  granteeUserId: string | null
  permissions: SessionPermission[]
  createdAt: string
  expiresAt: string | null
}

function toShare(row: SessionShareRow): SessionShare {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    machineId: row.machine_id,
    localSessionId: row.local_session_id,
    sharedByUserId: row.shared_by_user_id,
    granteeUserId: row.grantee_user_id,
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

/** Parse the stored permission list, dropping anything unrecognized. */
export function parsePermissions(raw: string): SessionPermission[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is SessionPermission =>
      typeof p === 'string' && (ALL_PERMISSIONS as string[]).includes(p),
    )
  } catch {
    return []
  }
}

/**
 * Normalize a requested permission set: unknown entries are dropped, and
 * `view` is implied by any other permission (there is no meaningful grant
 * that excludes seeing the session it applies to).
 */
export function normalizePermissions(requested: unknown): SessionPermission[] {
  const list = Array.isArray(requested) ? requested : []
  const valid = list.filter((p): p is SessionPermission =>
    typeof p === 'string' && (ALL_PERMISSIONS as string[]).includes(p),
  )
  const unique = [...new Set(valid)]
  if (unique.length > 0 && !unique.includes('view')) unique.unshift('view')
  return unique
}

export interface CreateShareInput {
  machineId: string
  localSessionId: string
  sharedByUserId: string
  granteeUserId: string
  permissions: SessionPermission[]
  expiresAt?: string | null
}

/**
 * Create or replace a grant. One (session, grantee) pair has at most one
 * share, so re-sharing updates the permissions rather than stacking grants
 * that would have to be unioned at check time.
 */
export function upsertShare(db: Database.Database, input: CreateShareInput): SessionShare {
  const existing = db
    .prepare(
      `SELECT * FROM session_shares
       WHERE machine_id = ? AND local_session_id = ? AND grantee_user_id = ?`,
    )
    .get(input.machineId, input.localSessionId, input.granteeUserId) as SessionShareRow | undefined

  if (existing) {
    db.prepare('UPDATE session_shares SET permissions = ?, expires_at = ? WHERE id = ?').run(
      JSON.stringify(input.permissions),
      input.expiresAt ?? null,
      existing.id,
    )
    return getShare(db, existing.id)!
  }

  const id = randomUUID()
  // A share lives in its machine's workspace, always: taken from the machine
  // row here rather than trusted from the caller.
  db.prepare(
    `INSERT INTO session_shares
       (id, workspace_id, machine_id, local_session_id, shared_by_user_id, grantee_user_id, permissions, expires_at)
     SELECT ?, workspace_id, ?, ?, ?, ?, ?, ? FROM machines WHERE id = ?`,
  ).run(
    id,
    input.machineId,
    input.localSessionId,
    input.sharedByUserId,
    input.granteeUserId,
    JSON.stringify(input.permissions),
    input.expiresAt ?? null,
    input.machineId,
  )
  return getShare(db, id)!
}

export function getShare(db: Database.Database, shareId: string): SessionShare | null {
  const row = db.prepare('SELECT * FROM session_shares WHERE id = ?').get(shareId) as
    | SessionShareRow
    | undefined
  return row ? toShare(row) : null
}

export function updateSharePermissions(
  db: Database.Database,
  shareId: string,
  permissions: SessionPermission[],
  expiresAt?: string | null,
): SessionShare | null {
  const existing = getShare(db, shareId)
  if (!existing) return null
  db.prepare('UPDATE session_shares SET permissions = ?, expires_at = ? WHERE id = ?').run(
    JSON.stringify(permissions),
    expiresAt === undefined ? existing.expiresAt : expiresAt,
    shareId,
  )
  return getShare(db, shareId)
}

export function deleteShare(db: Database.Database, shareId: string): boolean {
  return db.prepare('DELETE FROM session_shares WHERE id = ?').run(shareId).changes > 0
}

/** Shares created by a user (what they have shared out), optionally within one workspace. */
export function listSharesBy(db: Database.Database, userId: string, workspaceId?: string): SessionShare[] {
  return (
    db
      .prepare(
        `SELECT * FROM session_shares WHERE shared_by_user_id = ? AND (? IS NULL OR workspace_id = ?)
         ORDER BY created_at DESC`,
      )
      .all(userId, workspaceId ?? null, workspaceId ?? null) as SessionShareRow[]
  ).map(toShare)
}

/** Shares granted to a user (what has been shared with them), unexpired. */
export function listSharesFor(
  db: Database.Database,
  userId: string,
  now = new Date(),
  workspaceId?: string,
): SessionShare[] {
  return (
    db
      // `created_at` is second-granular, so it alone leaves same-second rows in
      // an order SQLite does not promise; `id` breaks the tie deterministically.
      .prepare(
        `SELECT * FROM session_shares WHERE grantee_user_id = ? AND (? IS NULL OR workspace_id = ?)
         ORDER BY created_at DESC, id DESC`,
      )
      .all(userId, workspaceId ?? null, workspaceId ?? null) as SessionShareRow[]
  )
    .map(toShare)
    .filter(share => !isExpired(share, now))
}

/**
 * Fails closed: a stored value that does not parse as a time is treated as
 * already expired, never as "no expiry".
 */
export function isExpired(share: SessionShare, now = new Date()): boolean {
  if (share.expiresAt === null) return false
  const at = new Date(share.expiresAt).getTime()
  return !Number.isFinite(at) || at <= now.getTime()
}

export type ParsedExpiry = { ok: true; value: string | null | undefined } | { ok: false }

/**
 * Validate a client-supplied share expiry. `undefined` means "not given"
 * (PATCH keeps the current value), `null` means "never". Anything else must
 * be a parseable time in the future and is normalized to ISO-8601.
 */
export function parseShareExpiry(value: unknown, now = new Date()): ParsedExpiry {
  if (value === undefined || value === null) return { ok: true, value }
  if (typeof value !== 'string') return { ok: false }
  const at = new Date(value).getTime()
  if (!Number.isFinite(at) || at <= now.getTime()) return { ok: false }
  return { ok: true, value: new Date(at).toISOString() }
}

/**
 * A workspace viewer is read-only whatever a share says: grants are cut down
 * to the viewer preset, and a grant left empty grants nothing.
 */
export function capPermissionsForRole(
  permissions: SessionPermission[],
  role: WorkspaceRole | undefined,
): SessionPermission[] {
  if (role !== 'viewer') return permissions
  return permissions.filter(p => SHARE_ROLES.viewer.includes(p))
}

export function exceedsRoleCap(permissions: SessionPermission[], role: WorkspaceRole | undefined): boolean {
  return capPermissionsForRole(permissions, role).length !== permissions.length
}

/**
 * Every unexpired grant a user holds on a machine, as a session → permissions
 * map. This is the object pushed to the connector and consulted on every
 * proxied action.
 */
export type GrantMap = Record<string, SessionPermission[]>

export function grantsForMachine(
  db: Database.Database,
  userId: string,
  machineId: string,
  now = new Date(),
  role?: WorkspaceRole,
): GrantMap {
  const grants: GrantMap = {}
  for (const share of listSharesFor(db, userId, now)) {
    if (share.machineId !== machineId) continue
    const permissions = capPermissionsForRole(share.permissions, role)
    if (permissions.length > 0) grants[share.localSessionId] = permissions
  }
  return grants
}

export type MachineAccess =
  | { kind: 'owner' }
  | { kind: 'grantee'; grants: GrantMap }
  | { kind: 'none' }

/**
 * How a user may reach a machine: as its owner (unrestricted), as the holder
 * of at least one live session grant, or not at all.
 *
 * Every path runs through the machine's workspace: without an active
 * membership there (in a live workspace) there is no access, whatever the
 * machine or share rows say. A quarantined machine is unreachable, and a
 * viewer is read-only even on a machine they own.
 */
export function resolveMachineAccess(
  db: Database.Database,
  user: Pick<UserRow, 'id' | 'status'>,
  machineId: string,
  now = new Date(),
): MachineAccess {
  if (user.status !== 'active') return { kind: 'none' }

  const machine = db
    .prepare('SELECT owner_user_id, workspace_id, quarantined_at FROM machines WHERE id = ?')
    .get(machineId) as { owner_user_id: string; workspace_id: string; quarantined_at: string | null } | undefined
  if (!machine || machine.quarantined_at !== null) return { kind: 'none' }
  const membership = getActiveMembership(db, machine.workspace_id, user.id)
  if (!membership) return { kind: 'none' }
  if (machine.owner_user_id === user.id) {
    return membership.role === 'viewer' ? { kind: 'none' } : { kind: 'owner' }
  }

  const grants = grantsForMachine(db, user.id, machineId, now, membership.role)
  if (Object.keys(grants).length === 0) return { kind: 'none' }
  return { kind: 'grantee', grants }
}
