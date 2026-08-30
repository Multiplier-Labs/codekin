/**
 * The single runs database.
 *
 * Phase 1 of the automation unification: workflows historically persisted to
 * a separate SQLite file (`~/.codekin/workflows.db`). Engines now default to one file —
 * `~/.codekin/runs.db` — each keeping its own tables and its own connection
 * (safe under WAL). One file to back up, one place for the Phase-2 unified
 * run ledger to grow into.
 *
 * Existing data is carried over by `migrateLegacyTables`: on first boot
 * against an empty runs.db, rows are copied from the legacy file when it
 * exists. The copy is per-table, skipped for any table that already has rows
 * (so it never runs twice), and matches columns by name so a legacy database
 * created before an additive column migration still copies cleanly. Legacy
 * files are left untouched — deleting user data is not this module's call.
 */

import type Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** `~/.codekin/runs.db`, creating the data dir if needed. */
export function defaultRunsDbPath(): string {
  const dir = join(homedir(), '.codekin')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'runs.db')
}

/** `~/.codekin/<name>` — where the pre-unification databases live. */
export function legacyDbPath(name: 'workflows.db'): string {
  return join(homedir(), '.codekin', name)
}

function columnNames(db: Database.Database, schema: 'main' | 'legacy', table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name)
}

/**
 * Copy rows for `tables` from a legacy database file into `db`, table by
 * table. A table is copied only when it exists in the legacy file, exists in
 * the target, and the target copy is empty. Tables must be listed
 * parents-first when foreign keys relate them. Table names come from
 * hardcoded caller lists, never user input. Errors are logged, not thrown —
 * a failed migration must not stop the server from booting (the legacy file
 * stays intact for a retry after a fix).
 *
 * Returns the number of rows copied.
 */
export function migrateLegacyTables(db: Database.Database, legacyPath: string, tables: string[]): number {
  if (!existsSync(legacyPath)) return 0
  try {
    db.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath)
  } catch (err) {
    console.error(`[run-db] Could not attach legacy database ${legacyPath}:`, err)
    return 0
  }
  let copied = 0
  try {
    for (const table of tables) {
      const inLegacy = db.prepare(`SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = ?`).get(table)
      if (!inLegacy) continue
      const existing = db.prepare(`SELECT COUNT(*) AS n FROM main."${table}"`).get() as { n: number }
      if (existing.n > 0) continue

      // Match columns by name — a legacy file from before an additive column
      // migration has fewer columns; the missing ones take their defaults.
      const target = new Set(columnNames(db, 'main', table))
      const shared = columnNames(db, 'legacy', table).filter((c) => target.has(c))
      if (!shared.length) continue
      const cols = shared.map((c) => `"${c}"`).join(', ')
      const result = db.prepare(`INSERT INTO main."${table}" (${cols}) SELECT ${cols} FROM legacy."${table}"`).run()
      copied += result.changes
    }
  } catch (err) {
    console.error(`[run-db] Legacy migration from ${legacyPath} failed:`, err)
  } finally {
    try {
      db.prepare('DETACH DATABASE legacy').run()
    } catch {
      // already detached or never attached fully
    }
  }
  if (copied > 0) console.log(`[run-db] Migrated ${copied} row(s) from ${legacyPath}`)
  return copied
}
