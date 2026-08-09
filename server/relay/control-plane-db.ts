/**
 * Control-plane database: users, machines, shares, audit events.
 *
 * Schema v1 per docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md §5. Tables that
 * later phases populate (machine_credentials, pairing_requests,
 * session_shares, audit_events) are created now so those phases are data
 * changes, not schema changes.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync, chmodSync } from 'fs'
import { dirname } from 'path'

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer'
export type UserStatus = 'active' | 'pending' | 'disabled'

export interface UserRow {
  id: string
  organization_id: string
  github_id: number
  login: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
  role: UserRole
  status: UserStatus
}

export interface MachineRow {
  id: string
  organization_id: string
  owner_user_id: string
  display_name: string
  hostname: string | null
  platform: string | null
  connector_version: string | null
  local_codekin_version: string | null
  status: 'online' | 'offline' | 'degraded'
  last_seen_at: string | null
}

/** Single hardcoded organization for the MVP (multi-org is a data change later). */
export const DEFAULT_ORG_ID = 'org-default'
export const DEFAULT_ORG_NAME = 'Multiplier Labs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS web_sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expire ON web_sessions(expire);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  connector_version TEXT,
  local_codekin_version TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machine_credentials (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  secret_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_requests (
  code TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by_user_id TEXT REFERENCES users(id),
  machine_id TEXT REFERENCES machines(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_shares (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  local_session_id TEXT NOT NULL,
  shared_by_user_id TEXT NOT NULL REFERENCES users(id),
  grantee_user_id TEXT REFERENCES users(id),
  permissions TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_user_id TEXT,
  machine_id TEXT,
  local_session_id TEXT,
  ip TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`

/** Open (creating if needed) the control-plane DB and apply the schema. */
export function openControlPlaneDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  db.prepare('INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)').run(
    DEFAULT_ORG_ID,
    DEFAULT_ORG_NAME,
  )
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600)
    } catch {
      // best-effort on non-POSIX filesystems
    }
  }
  return db
}

export interface AccessPolicy {
  ownerGithubId: number
  allowedGithubIds: number[]
}

/**
 * Decide role and status for an authenticated GitHub account. The owner id
 * gets the owner role; allowlisted ids become active members; everyone else
 * lands in pending and sees the request-access screen.
 *
 * Matching is by GitHub's immutable numeric user id, never by login: a login
 * can be renamed and then re-registered by a stranger, and a login match
 * would auto-activate whoever holds the name today with the access meant for
 * whoever held it when the config was written.
 */
export function resolveUserAccess(githubId: number, policy: AccessPolicy): { role: UserRole; status: UserStatus } {
  if (githubId > 0 && githubId === policy.ownerGithubId) {
    return { role: 'owner', status: 'active' }
  }
  if (policy.allowedGithubIds.includes(githubId)) {
    return { role: 'member', status: 'active' }
  }
  return { role: 'member', status: 'pending' }
}

export interface GithubProfile {
  id: number
  login: string
  name: string | null
  email: string | null
  avatarUrl: string | null
}

/**
 * Insert or update a user from a GitHub profile at login time.
 *
 * Role/status from the allowlist only ever upgrade automatically: a user
 * manually promoted to active (or admin) in the DB is not demoted back to
 * pending/member just because the env allowlist doesn't mention them.
 * A disabled user stays disabled regardless of the allowlist.
 */
export function upsertUserFromGithub(
  db: Database.Database,
  profile: GithubProfile,
  policy: AccessPolicy,
): UserRow {
  const resolved = resolveUserAccess(profile.id, policy)

  // GitHub logins are unique among live accounts, so another row still
  // holding this login is stale from before a rename. Clear it, or login
  // lookups (share grants name grantees by login) could resolve to the
  // wrong account.
  db.prepare(
    `UPDATE users SET login = 'formerly-' || login || '-' || github_id, updated_at = datetime('now')
     WHERE lower(login) = lower(?) AND github_id != ?`,
  ).run(profile.login, profile.id)

  const existing = db
    .prepare('SELECT * FROM users WHERE github_id = ?')
    .get(profile.id) as UserRow | undefined

  if (!existing) {
    const id = randomUUID()
    db.prepare(
      `INSERT INTO users (id, organization_id, github_id, login, display_name, email, avatar_url, role, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      DEFAULT_ORG_ID,
      profile.id,
      profile.login,
      profile.name,
      profile.email,
      profile.avatarUrl,
      resolved.role,
      resolved.status,
    )
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
  }

  const role = existing.role === 'member' && resolved.role === 'owner' ? 'owner' : existing.role
  const status: UserStatus =
    existing.status === 'disabled'
      ? 'disabled'
      : existing.status === 'pending' && resolved.status === 'active'
        ? 'active'
        : existing.status

  db.prepare(
    `UPDATE users SET login = ?, display_name = ?, email = ?, avatar_url = ?, role = ?, status = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(profile.login, profile.name, profile.email, profile.avatarUrl, role, status, existing.id)

  return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) as UserRow
}

/** All users in the default org, for the admin user-management view. */
export function listUsers(db: Database.Database): UserRow[] {
  return db
    .prepare('SELECT * FROM users WHERE organization_id = ? ORDER BY login COLLATE NOCASE')
    .all(DEFAULT_ORG_ID) as UserRow[]
}

/** List machines in the default org (MVP: all machines, newest first). */
export function listMachines(db: Database.Database): MachineRow[] {
  return db
    .prepare('SELECT * FROM machines WHERE organization_id = ? ORDER BY created_at DESC')
    .all(DEFAULT_ORG_ID) as MachineRow[]
}

/** One machine by id, for ownership checks. */
export function getMachine(db: Database.Database, machineId: string): MachineRow | undefined {
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as MachineRow | undefined
}

/**
 * Current row for a user, by id.
 *
 * Callers use this to re-check role and status against the database rather
 * than trusting the copy stored in a session at login time.
 */
export function getUserById(db: Database.Database, userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
}
