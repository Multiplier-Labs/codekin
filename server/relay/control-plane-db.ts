/**
 * Control-plane database: users, workspaces, machines, shares, audit events.
 *
 * SCHEMA is the original (version 0) layout from
 * docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md §5. Everything since is a numbered
 * migration (MIGRATIONS), including the move from one hardcoded organization
 * to workspaces with per-workspace memberships
 * (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 1).
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync, chmodSync } from 'fs'
import { dirname } from 'path'

/** A role within one workspace (workspace_memberships.role). */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'
/**
 * Platform-wide account status. `disabled` is the operator's kill switch and
 * applies in every workspace; per-workspace standing lives on the membership.
 */
export type UserStatus = 'active' | 'pending' | 'disabled'

export interface UserRow {
  id: string
  github_id: number
  login: string
  display_name: string | null
  email: string | null
  avatar_url: string | null
  status: UserStatus
  /** 0/1: may create workspaces (the operator always may). */
  can_create_workspaces: number
}

export interface MachineRow {
  id: string
  workspace_id: string
  /** Set when the owner left the workspace; unreachable until transferred or removed. */
  quarantined_at: string | null
  owner_user_id: string
  display_name: string
  hostname: string | null
  platform: string | null
  connector_version: string | null
  local_codekin_version: string | null
  status: 'online' | 'offline' | 'degraded'
  last_seen_at: string | null
}

/**
 * The workspace every pre-workspace deployment is migrated into, and where
 * allowlisted accounts (OWNER_GITHUB_ID, ALLOWED_GITHUB_IDS) are admitted
 * until invitations replace the allowlist. The id predates workspaces.
 */
export const BOOTSTRAP_WORKSPACE_ID = 'org-default'
export const BOOTSTRAP_WORKSPACE_NAME = 'Multiplier Labs'

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

CREATE TABLE IF NOT EXISTS device_link_requests (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL,
  claimed_at TEXT,
  claimed_ip TEXT,
  claimed_user_agent TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

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

/**
 * Versioned schema changes on top of SCHEMA, tracked in `PRAGMA user_version`.
 * Each step runs exactly once per database, in order, inside a transaction
 * with foreign-key enforcement off (so tables can be rebuilt) and a
 * foreign_key_check before commit. Never edit or reorder a shipped step, and
 * never add to SCHEMA: new tables are migrations too.
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // 1: web_sessions.user_id, so revoking a user's sessions is an indexed
  // delete instead of a JSON parse of every session row.
  db => {
    const columns = db.prepare('PRAGMA table_info(web_sessions)').all() as Array<{ name: string }>
    if (!columns.some(c => c.name === 'user_id')) {
      db.exec('ALTER TABLE web_sessions ADD COLUMN user_id TEXT')
    }
    db.exec(`UPDATE web_sessions SET user_id = json_extract(sess, '$.user.id')
             WHERE user_id IS NULL AND json_valid(sess)`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id)')
  },

  // 2: workspaces. The single organization becomes the first workspace and
  // each user's global role becomes a membership in it. users loses role and
  // organization_id (rebuilt: SQLite cannot drop an FK column in place);
  // audit_events.workspace_id becomes nullable for account-level events.
  db => {
    db.exec(`
      ALTER TABLE organizations RENAME TO workspaces;
      ALTER TABLE workspaces ADD COLUMN require_mfa INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspaces ADD COLUMN created_by_user_id TEXT;
      ALTER TABLE workspaces ADD COLUMN deleted_at TEXT;

      CREATE TABLE workspace_memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        invited_by_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);

      INSERT INTO workspace_memberships (workspace_id, user_id, role)
        SELECT organization_id, id,
               CASE WHEN role IN ('owner', 'admin', 'member', 'viewer') THEN role ELSE 'member' END
        FROM users WHERE status != 'pending';

      CREATE TABLE users_v2 (
        id TEXT PRIMARY KEY,
        github_id INTEGER UNIQUE NOT NULL,
        login TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        avatar_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        can_create_workspaces INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO users_v2 (id, github_id, login, display_name, email, avatar_url, status, created_at, updated_at)
        SELECT id, github_id, login, display_name, email, avatar_url, status, created_at, updated_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;

      ALTER TABLE machines RENAME COLUMN organization_id TO workspace_id;
      ALTER TABLE machines ADD COLUMN quarantined_at TEXT;
      CREATE INDEX idx_machines_workspace ON machines(workspace_id);
      ALTER TABLE session_shares RENAME COLUMN organization_id TO workspace_id;

      CREATE TABLE audit_events_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT,
        kind TEXT NOT NULL,
        actor_user_id TEXT,
        machine_id TEXT,
        local_session_id TEXT,
        ip TEXT,
        user_agent TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO audit_events_v2
        SELECT id, organization_id, kind, actor_user_id, machine_id, local_session_id, ip, user_agent, metadata, created_at
        FROM audit_events;
      DROP TABLE audit_events;
      ALTER TABLE audit_events_v2 RENAME TO audit_events;
      CREATE INDEX idx_audit_events_workspace ON audit_events(workspace_id, id);
    `)
  },
]

function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= MIGRATIONS.length) return
  // Must be toggled outside a transaction; table rebuilds need it off.
  db.pragma('foreign_keys = OFF')
  try {
    for (let version = current; version < MIGRATIONS.length; version++) {
      db.transaction(() => {
        MIGRATIONS[version](db)
        const violations = db.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) {
          throw new Error(`control-plane migration ${version + 1} left ${violations.length} foreign-key violation(s)`)
        }
        db.pragma(`user_version = ${version + 1}`)
      })()
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/** Open (creating if needed) the control-plane DB and apply the schema. */
export function openControlPlaneDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // The version-0 layout; after that the database is shaped by migrations
  // alone (re-running SCHEMA would recreate tables they renamed away).
  if ((db.pragma('user_version', { simple: true }) as number) === 0) db.exec(SCHEMA)
  runMigrations(db)
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)').run(
    BOOTSTRAP_WORKSPACE_ID,
    BOOTSTRAP_WORKSPACE_NAME,
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
 * Decide admission for an authenticated GitHub account. The owner id and
 * allowlisted ids are admitted (active) with a role in the bootstrap
 * workspace; everyone else is pending.
 *
 * Matching is by GitHub's immutable numeric user id, never by login: a login
 * can be renamed and then re-registered by a stranger, and a login match
 * would auto-activate whoever holds the name today with the access meant for
 * whoever held it when the config was written.
 */
export function resolveUserAccess(
  githubId: number,
  policy: AccessPolicy,
): { status: UserStatus; bootstrapRole: WorkspaceRole | null } {
  if (githubId > 0 && githubId === policy.ownerGithubId) {
    return { status: 'active', bootstrapRole: 'owner' }
  }
  if (policy.allowedGithubIds.includes(githubId)) {
    return { status: 'active', bootstrapRole: 'member' }
  }
  return { status: 'pending', bootstrapRole: null }
}

/** Whether a GitHub identity may create a hosted Codekin account. */
export function isGithubAccountAllowed(githubId: number, policy: AccessPolicy): boolean {
  return resolveUserAccess(githubId, policy).status === 'active'
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
 * Status from the allowlist only ever upgrades automatically (pending →
 * active); a disabled user stays disabled regardless of the allowlist.
 * Admission adds a bootstrap-workspace membership once, when the account
 * becomes active — never on later logins, so a member an admin removed from
 * that workspace is not silently re-added by signing in again.
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

  let userId: string
  let admittedNow: boolean
  if (!existing) {
    userId = randomUUID()
    db.prepare(
      `INSERT INTO users (id, github_id, login, display_name, email, avatar_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, profile.id, profile.login, profile.name, profile.email, profile.avatarUrl, resolved.status)
    admittedNow = resolved.status === 'active'
  } else {
    userId = existing.id
    const status: UserStatus =
      existing.status === 'disabled'
        ? 'disabled'
        : existing.status === 'pending' && resolved.status === 'active'
          ? 'active'
          : existing.status
    admittedNow = existing.status === 'pending' && status === 'active'
    db.prepare(
      `UPDATE users SET login = ?, display_name = ?, email = ?, avatar_url = ?, status = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(profile.login, profile.name, profile.email, profile.avatarUrl, status, userId)
  }

  if (admittedNow && resolved.bootstrapRole) {
    db.prepare(
      `INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role)
       SELECT id, ?, ? FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    ).run(userId, resolved.bootstrapRole, BOOTSTRAP_WORKSPACE_ID)
  }

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow
}

/** Every account on the platform, for the operator's user view. */
export function listUsers(db: Database.Database): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY login COLLATE NOCASE').all() as UserRow[]
}

/** Machines in one workspace, newest first. */
export function listMachines(db: Database.Database, workspaceId: string): MachineRow[] {
  return db
    .prepare('SELECT * FROM machines WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as MachineRow[]
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
