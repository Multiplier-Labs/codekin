/**
 * Audit events (spec §9.5): a record of hosted actions that can influence
 * local execution.
 *
 * Metadata only by default — prompt text, file contents, and tool output are
 * never stored. What is recorded is who did what, to which machine and
 * session, from where, and when.
 */

import type Database from 'better-sqlite3'
import { DEFAULT_ORG_ID } from './control-plane-db.js'

export type AuditEventKind =
  | 'machine_paired'
  | 'machine_removed'
  | 'machine_connected'
  | 'machine_disconnected'
  | 'session_shared'
  | 'session_unshared'
  | 'session_viewed'
  | 'prompt_sent'
  | 'file_uploaded'
  | 'approval_answered'
  | 'session_stopped'
  | 'access_denied'
  | 'user_updated'
  | 'device_link_created'
  | 'device_linked'
  | 'passkey_registered'
  | 'passkey_login'
  | 'passkey_removed'

export interface AuditEventInput {
  kind: AuditEventKind
  actorUserId?: string | null
  machineId?: string | null
  localSessionId?: string | null
  ip?: string | null
  userAgent?: string | null
  /** Small, non-sensitive detail: tool name, permission checked, share role. */
  metadata?: Record<string, string | number | boolean | null>
}

export interface AuditEvent {
  id: number
  kind: string
  actorUserId: string | null
  machineId: string | null
  localSessionId: string | null
  ip: string | null
  userAgent: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

/** Cap on serialized metadata, so one event cannot bloat the table. */
const MAX_METADATA_CHARS = 1_000

export function recordAuditEvent(db: Database.Database, event: AuditEventInput): void {
  let metadata: string | null = null
  if (event.metadata) {
    const serialized = JSON.stringify(event.metadata)
    metadata = serialized.length > MAX_METADATA_CHARS ? serialized.slice(0, MAX_METADATA_CHARS) : serialized
  }

  db.prepare(
    `INSERT INTO audit_events
       (organization_id, kind, actor_user_id, machine_id, local_session_id, ip, user_agent, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_ORG_ID,
    event.kind,
    event.actorUserId ?? null,
    event.machineId ?? null,
    event.localSessionId ?? null,
    event.ip ?? null,
    event.userAgent ?? null,
    metadata,
  )
}

export interface AuditQuery {
  machineId?: string
  actorUserId?: string
  limit?: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Most recent events first. */
export function listAuditEvents(db: Database.Database, query: AuditQuery = {}): AuditEvent[] {
  const clauses: string[] = ['organization_id = ?']
  const params: unknown[] = [DEFAULT_ORG_ID]

  if (query.machineId) {
    clauses.push('machine_id = ?')
    params.push(query.machineId)
  }
  if (query.actorUserId) {
    clauses.push('actor_user_id = ?')
    params.push(query.actorUserId)
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const rows = db
    .prepare(
      `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, limit) as {
    id: number
    kind: string
    actor_user_id: string | null
    machine_id: string | null
    local_session_id: string | null
    ip: string | null
    user_agent: string | null
    metadata: string | null
    created_at: string
  }[]

  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    actorUserId: row.actor_user_id,
    machineId: row.machine_id,
    localSessionId: row.local_session_id,
    ip: row.ip,
    userAgent: row.user_agent,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  }))
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Truncated by the size cap — keep the event, drop the unparsable detail
    return null
  }
}

/** Delete events older than `days`. Retention is org policy (spec §12). */
export function pruneAuditEvents(db: Database.Database, days: number): number {
  return db
    .prepare(`DELETE FROM audit_events WHERE created_at < datetime('now', ?)`)
    .run(`-${days} days`).changes
}
