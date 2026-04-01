/**
 * SQLite-backed archive for closed sessions.
 *
 * When a session is deleted, its metadata and chat history are archived here.
 * Old archives are automatically purged based on a configurable retention period.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { WsServerMessage } from './types.js'

const DATA_DIR = join(homedir(), '.codekin')
const DB_PATH = join(DATA_DIR, 'session-archive.db')

/** Default retention period in days. */
const DEFAULT_RETENTION_DAYS = 7

/** Interval between cleanup runs (1 hour). */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/** Archived session metadata returned by list queries. */
export interface ArchivedSessionInfo {
  id: string
  name: string
  workingDir: string
  groupDir: string | null
  source: string
  created: string
  archivedAt: string
  messageCount: number
}

/** Full archived session with chat history. */
export interface ArchivedSessionFull extends ArchivedSessionInfo {
  outputHistory: WsServerMessage[]
}

export class SessionArchive {
  private db: InstanceType<typeof Database>
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(dbPath?: string) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const resolvedPath = dbPath ?? DB_PATH
    this.db = new Database(resolvedPath)
    if (resolvedPath !== ':memory:') {
      try { chmodSync(resolvedPath, 0o600) } catch { /* file may not exist yet (e.g. mocked DB) */ }
    }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.initSchema()
    this.startCleanupTimer()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archived_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        group_dir TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        output_history TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_archived_at ON archived_sessions(archived_at);
      CREATE INDEX IF NOT EXISTS idx_working_dir ON archived_sessions(working_dir);
    `)

    // Seed default retention if not set
    const existing = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('retention_days')
    if (!existing) {
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('retention_days', String(DEFAULT_RETENTION_DAYS))
    }
  }

  /** Archive a session with its full output history. */
  archive(session: {
    id: string
    name: string
    workingDir: string
    groupDir?: string
    source: string
    created: string
    outputHistory: WsServerMessage[]
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO archived_sessions (id, name, working_dir, group_dir, source, created, archived_at, output_history)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    `).run(
      session.id,
      session.name,
      session.workingDir,
      session.groupDir ?? null,
      session.source,
      session.created,
      JSON.stringify(session.outputHistory),
    )
  }

  /** List archived sessions (metadata only, no history). Optionally filtered by workingDir. */
  list(workingDir?: string): ArchivedSessionInfo[] {
    const rows = workingDir
      ? this.db.prepare(`
          SELECT id, name, working_dir, group_dir, source, created, archived_at,
                 json_array_length(output_history) as message_count
          FROM archived_sessions
          WHERE working_dir = ? OR group_dir = ?
          ORDER BY archived_at DESC
        `).all(workingDir, workingDir)
      : this.db.prepare(`
      SELECT id, name, working_dir, group_dir, source, created, archived_at,
             json_array_length(output_history) as message_count
      FROM archived_sessions
      ORDER BY archived_at DESC
    `).all()
    const typed = rows as Array<{
      id: string; name: string; working_dir: string; group_dir: string | null;
      source: string; created: string; archived_at: string; message_count: number
    }>

    return typed.map(r => ({
      id: r.id,
      name: r.name,
      workingDir: r.working_dir,
      groupDir: r.group_dir,
      source: r.source,
      created: r.created,
      archivedAt: r.archived_at,
      messageCount: r.message_count,
    }))
  }

  /** Get a single archived session with full chat history. */
  get(sessionId: string): ArchivedSessionFull | null {
    const row = this.db.prepare(`
      SELECT id, name, working_dir, group_dir, source, created, archived_at, output_history,
             json_array_length(output_history) as message_count
      FROM archived_sessions
      WHERE id = ?
    `).get(sessionId) as {
      id: string; name: string; working_dir: string; group_dir: string | null;
      source: string; created: string; archived_at: string; output_history: string;
      message_count: number
    } | undefined

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      workingDir: row.working_dir,
      groupDir: row.group_dir,
      source: row.source,
      created: row.created,
      archivedAt: row.archived_at,
      messageCount: row.message_count,
      outputHistory: (() => { try { return JSON.parse(row.output_history) } catch { return [] } })(),
    }
  }

  /** Delete an archived session permanently. */
  delete(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM archived_sessions WHERE id = ?').run(sessionId)
    return result.changes > 0
  }

  /** Get the retention period in days. */
  getRetentionDays(): number {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('retention_days') as { value: string } | undefined
    return row ? Number(row.value) : DEFAULT_RETENTION_DAYS
  }

  /** Set the retention period in days. */
  setRetentionDays(days: number): void {
    if (days < 1) days = 1
    if (days > 365) days = 365
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('retention_days', String(days))
  }

  /** Get a generic setting by key, returning the fallback if not set. */
  getSetting(key: string, fallback: string = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : fallback
  }

  /** Set a generic setting by key. */
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  /** Purge archived sessions older than the retention period. */
  purgeExpired(): number {
    const days = this.getRetentionDays()
    const result = this.db.prepare(`
      DELETE FROM archived_sessions
      WHERE archived_at < datetime('now', ? || ' days')
    `).run(`-${days}`)
    return result.changes
  }

  private startCleanupTimer(): void {
    // Run initial cleanup
    this.purgeExpired()
    // Schedule periodic cleanup
    this.cleanupTimer = setInterval(() => {
      const purged = this.purgeExpired()
      if (purged > 0) {
        console.log(`[session-archive] Purged ${purged} expired archived sessions`)
      }
    }, CLEANUP_INTERVAL_MS)
  }

  /** Graceful shutdown. */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.db.close()
  }
}
