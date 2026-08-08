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
import { DEFAULT_ORG_ID } from './control-plane-db.js'
import type { UserRow } from './control-plane-db.js'

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
  organization_id: string
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
  db.prepare(
    `INSERT INTO session_shares
       (id, organization_id, machine_id, local_session_id, shared_by_user_id, grantee_user_id, permissions, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    DEFAULT_ORG_ID,
    input.machineId,
    input.localSessionId,
    input.sharedByUserId,
    input.granteeUserId,
    JSON.stringify(input.permissions),
    input.expiresAt ?? null,
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

/** Shares created by a user (what they have shared out). */
export function listSharesBy(db: Database.Database, userId: string): SessionShare[] {
  return (
    db
      .prepare('SELECT * FROM session_shares WHERE shared_by_user_id = ? ORDER BY created_at DESC')
      .all(userId) as SessionShareRow[]
  ).map(toShare)
}

/** Shares granted to a user (what has been shared with them), unexpired. */
export function listSharesFor(db: Database.Database, userId: string, now = new Date()): SessionShare[] {
  return (
    db
      .prepare('SELECT * FROM session_shares WHERE grantee_user_id = ? ORDER BY created_at DESC')
      .all(userId) as SessionShareRow[]
  )
    .map(toShare)
    .filter(share => !isExpired(share, now))
}

export function isExpired(share: SessionShare, now = new Date()): boolean {
  return share.expiresAt !== null && new Date(share.expiresAt).getTime() <= now.getTime()
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
): GrantMap {
  const grants: GrantMap = {}
  for (const share of listSharesFor(db, userId, now)) {
    if (share.machineId !== machineId) continue
    grants[share.localSessionId] = share.permissions
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
 */
export function resolveMachineAccess(
  db: Database.Database,
  user: Pick<UserRow, 'id' | 'status'>,
  machineId: string,
  now = new Date(),
): MachineAccess {
  if (user.status !== 'active') return { kind: 'none' }

  const machine = db.prepare('SELECT owner_user_id FROM machines WHERE id = ?').get(machineId) as
    | { owner_user_id: string }
    | undefined
  if (!machine) return { kind: 'none' }
  if (machine.owner_user_id === user.id) return { kind: 'owner' }

  const grants = grantsForMachine(db, user.id, machineId, now)
  if (Object.keys(grants).length === 0) return { kind: 'none' }
  return { kind: 'grantee', grants }
}
