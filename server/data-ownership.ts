/**
 * Exclusive ownership of Codekin's state directories (desktop plan D7).
 *
 * One server at a time may own a state directory. Ownership is a SQLite
 * database in the directory, opened in `locking_mode = EXCLUSIVE`: after the
 * first write the connection keeps an OS `fcntl` lock until it closes, and
 * the kernel drops that lock when the process dies, so a crash never leaves
 * a stale owner and nothing decides staleness from timestamps or probes. A
 * second server gets `SQLITE_BUSY` immediately (`timeout: 0`).
 *
 * The same database records the last writer's version. A server older than
 * that refuses to start before touching application state: forward upgrades
 * use the server's own migrations, downgrades are unsupported. Servers that
 * predate this guard don't take the lock or check the marker, so this
 * protects only against other guarded servers.
 */

import Database from 'better-sqlite3'
import { mkdirSync, realpathSync } from 'fs'
import { join } from 'path'

/** File name of the ownership database inside each state directory. */
export const OWNERSHIP_DB = '.codekin-owner.sqlite'

export class DataDirInUseError extends Error {
  readonly code = 'data_in_use'
  constructor(readonly dir: string) {
    super(`Another Codekin server is using ${dir}`)
    this.name = 'DataDirInUseError'
  }
}

export class DataDirNewerError extends Error {
  readonly code = 'data_newer'
  constructor(readonly dir: string, readonly writerVersion: string, readonly serverVersion: string) {
    super(`${dir} was last written by Codekin ${writerVersion}; this server is ${serverVersion}. Downgrades are unsupported: upgrade this server to ${writerVersion} or newer.`)
    this.name = 'DataDirNewerError'
  }
}

export type OwnershipError = DataDirInUseError | DataDirNewerError

interface ParsedSemver {
  core: [number, number, number]
  pre: string[]
}

function parseSemver(v: string): ParsedSemver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/**
 * Compare two semver strings (SemVer 2.0 precedence; build metadata ignored).
 * Returns -1, 0 or 1, or null when either isn't valid semver.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // A release outranks its prereleases.
  if (!pa.pre.length || !pb.pre.length) {
    if (pa.pre.length === pb.pre.length) return 0
    return pa.pre.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    // A shorter set of prerelease fields ranks lower when all earlier ones match.
    if (i >= pa.pre.length) return -1
    if (i >= pb.pre.length) return 1
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx) return -1
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export interface OwnershipHandle {
  /** Canonical (realpath) directories held. */
  readonly dirs: string[]
  /** Writer version found per directory before this server recorded its own (null: none recorded yet). */
  readonly previousVersions: Record<string, string | null>
  /** Release every lock. Only for tests and shutdown; process exit releases them too. */
  release(): void
}

/** Canonical form of a state directory, created if missing. */
export function canonicalDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

/**
 * Take ownership of one directory. Throws {@link DataDirInUseError} or
 * {@link DataDirNewerError}; on any failure nothing is left open.
 */
function acquireOne(dir: string, serverVersion: string): { db: Database.Database; previous: string | null } {
  const db = new Database(join(dir, OWNERSHIP_DB), { timeout: 0 })
  try {
    db.pragma('locking_mode = EXCLUSIVE')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new DataDirInUseError(dir)
      throw err
    }
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM meta WHERE key = 'writer_version'").get() as { value: string } | undefined
    const previous = row?.value ?? null

    const known = compareSemver(serverVersion, serverVersion) === 0
    if (previous && known && compareSemver(previous, serverVersion) === 1) {
      db.exec('ROLLBACK')
      throw new DataDirNewerError(dir, previous, serverVersion)
    }
    const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    // An unparseable version (a broken install) never overwrites a real marker.
    if (known) upsert.run('writer_version', serverVersion)
    upsert.run('owner_pid', String(process.pid))
    upsert.run('owned_since', new Date().toISOString())
    // In EXCLUSIVE locking mode the lock outlives the transaction.
    db.exec('COMMIT')
    return { db, previous }
  } catch (err) {
    try { db.close() } catch { /* ignore */ }
    throw err
  }
}

/**
 * Take ownership of every state directory, in a stable order. All or
 * nothing: if any directory is in use or newer, the ones already taken are
 * released before the error is thrown.
 */
export function acquireDataOwnership(dirs: string[], serverVersion: string): OwnershipHandle {
  const canonical = [...new Set(dirs.map(canonicalDir))].sort()
  const held: Database.Database[] = []
  const previousVersions: Record<string, string | null> = {}
  const release = () => {
    for (const db of held.splice(0)) {
      try { db.close() } catch { /* ignore */ }
    }
  }
  try {
    for (const dir of canonical) {
      const { db, previous } = acquireOne(dir, serverVersion)
      held.push(db)
      previousVersions[dir] = previous
    }
  } catch (err) {
    release()
    throw err
  }
  return { dirs: canonical, previousVersions, release }
}
