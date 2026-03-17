/**
 * Shepherd memory store — SQLite + FTS5 for structured, searchable memory.
 *
 * Provides durable memory across restarts with full-text search retrieval,
 * trust record tracking, and automatic expiry/aging of stale items.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { SHEPHERD_DIR } from './shepherd-manager.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'user_preference'
  | 'repo_context'
  | 'decision'
  | 'finding_outcome'
  | 'session_summary'
  | 'journal'

export interface MemoryItem {
  id: string
  memoryType: MemoryType
  scope: string | null       // null = global, or repo path
  title: string | null
  content: string
  sourceRef: string | null    // session ID, report path, etc.
  confidence: number
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  isPinned: boolean
  tags: string[]
}

export type TrustLevel = 'ask' | 'notify_do' | 'silent'

export interface TrustRecord {
  id: string
  action: string             // e.g., 'spawn_fix_session', 'enable_workflow'
  category: string           // e.g., 'dependency_update', 'security_fix'
  severity: string           // e.g., 'low', 'medium', 'high', 'critical'
  repo: string | null        // null = global override
  approvalCount: number
  rejectionCount: number
  lastApprovedAt: string | null
  lastRejectedAt: string | null
  pinnedLevel: TrustLevel | null  // user-set override ("always do X")
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ShepherdMemory {
  private db: Database.Database

  constructor(dbPath?: string) {
    if (!existsSync(SHEPHERD_DIR)) mkdirSync(SHEPHERD_DIR, { recursive: true })
    const resolvedPath = dbPath ?? join(SHEPHERD_DIR, 'memory.sqlite')
    this.db = new Database(resolvedPath, { fileMustExist: false })
    this.db.pragma('journal_mode = WAL')
    this.createTables()
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        memory_type TEXT NOT NULL,
        scope TEXT,
        title TEXT,
        content TEXT NOT NULL,
        source_ref TEXT,
        confidence REAL DEFAULT 0.8,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        is_pinned INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS trust_records (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        repo TEXT,
        approval_count INTEGER DEFAULT 0,
        rejection_count INTEGER DEFAULT 0,
        last_approved_at TEXT,
        last_rejected_at TEXT,
        pinned_level TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_items(scope);
      CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_items(expires_at);
      CREATE INDEX IF NOT EXISTS idx_trust_action ON trust_records(action, category, repo);
    `)

    // FTS5 virtual table for full-text search
    // Use a separate try-catch since FTS5 tables can't use IF NOT EXISTS
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE memory_fts USING fts5(
          title, content, tags,
          content='memory_items',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
    } catch {
      // Table already exists — that's fine
    }
  }

  // -------------------------------------------------------------------------
  // Memory CRUD
  // -------------------------------------------------------------------------

  /** Insert or update a memory item. */
  upsert(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): string {
    const id = item.id ?? randomUUID()
    const now = new Date().toISOString()
    const tagsJson = JSON.stringify(item.tags)

    const existing = this.db.prepare('SELECT id FROM memory_items WHERE id = ?').get(id)

    if (existing) {
      this.db.prepare(`
        UPDATE memory_items SET
          memory_type = ?, scope = ?, title = ?, content = ?,
          source_ref = ?, confidence = ?, updated_at = ?,
          expires_at = ?, is_pinned = ?, tags = ?
        WHERE id = ?
      `).run(
        item.memoryType, item.scope, item.title, item.content,
        item.sourceRef, item.confidence, now,
        item.expiresAt, item.isPinned ? 1 : 0, tagsJson,
        id,
      )
    } else {
      this.db.prepare(`
        INSERT INTO memory_items (id, memory_type, scope, title, content,
          source_ref, confidence, created_at, updated_at,
          expires_at, is_pinned, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, item.memoryType, item.scope, item.title, item.content,
        item.sourceRef, item.confidence, now, now,
        item.expiresAt, item.isPinned ? 1 : 0, tagsJson,
      )
    }

    // Update FTS index
    this.db.prepare('INSERT INTO memory_fts(rowid, title, content, tags) VALUES ((SELECT rowid FROM memory_items WHERE id = ?), ?, ?, ?)').run(id, item.title ?? '', item.content, tagsJson)

    return id
  }

  /** Delete a memory item by ID. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Get a memory item by ID. */
  get(id: string): MemoryItem | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  /** List memory items with optional filters. */
  list(filters?: {
    memoryType?: MemoryType
    scope?: string | null
    pinnedOnly?: boolean
    limit?: number
  }): MemoryItem[] {
    let sql = 'SELECT * FROM memory_items WHERE 1=1'
    const params: unknown[] = []

    if (filters?.memoryType) {
      sql += ' AND memory_type = ?'
      params.push(filters.memoryType)
    }
    if (filters?.scope !== undefined) {
      if (filters.scope === null) {
        sql += ' AND scope IS NULL'
      } else {
        sql += ' AND scope = ?'
        params.push(filters.scope)
      }
    }
    if (filters?.pinnedOnly) {
      sql += ' AND is_pinned = 1'
    }

    sql += ' ORDER BY updated_at DESC'
    if (filters?.limit) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.rowToItem(r))
  }

  /** Full-text search across memory items. */
  search(query: string, limit = 10): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT m.* FROM memory_items m
      JOIN memory_fts f ON m.rowid = f.rowid
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToItem(r))
  }

  /** Remove expired items. */
  expireStale(): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(
      'DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < ?'
    ).run(now)
    return result.changes
  }

  // -------------------------------------------------------------------------
  // Trust Records
  // -------------------------------------------------------------------------

  /** Get or create a trust record for an action pattern. */
  getTrust(action: string, category: string, repo: string | null): TrustRecord {
    const row = this.db.prepare(
      repo
        ? 'SELECT * FROM trust_records WHERE action = ? AND category = ? AND repo = ?'
        : 'SELECT * FROM trust_records WHERE action = ? AND category = ? AND repo IS NULL'
    ).get(...(repo ? [action, category, repo] : [action, category])) as Record<string, unknown> | undefined

    if (row) return this.rowToTrust(row)

    // Check for global override
    if (repo) {
      const globalRow = this.db.prepare(
        'SELECT * FROM trust_records WHERE action = ? AND category = ? AND repo IS NULL'
      ).get(action, category) as Record<string, unknown> | undefined
      if (globalRow?.pinned_level) return this.rowToTrust(globalRow)
    }

    // Create new record
    const id = randomUUID()
    this.db.prepare(
      'INSERT INTO trust_records (id, action, category, repo) VALUES (?, ?, ?, ?)'
    ).run(id, action, category, repo)

    return {
      id, action, category, severity: 'medium', repo,
      approvalCount: 0, rejectionCount: 0,
      lastApprovedAt: null, lastRejectedAt: null, pinnedLevel: null,
    }
  }

  /** Record a user approval for an action pattern. */
  recordApproval(action: string, category: string, repo: string | null): TrustRecord {
    const trust = this.getTrust(action, category, repo)
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE trust_records SET
        approval_count = approval_count + 1,
        last_approved_at = ?
      WHERE id = ?
    `).run(now, trust.id)
    return { ...trust, approvalCount: trust.approvalCount + 1, lastApprovedAt: now }
  }

  /** Record a user rejection — resets trust to ASK level. */
  recordRejection(action: string, category: string, repo: string | null): TrustRecord {
    const trust = this.getTrust(action, category, repo)
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE trust_records SET
        approval_count = 0,
        rejection_count = rejection_count + 1,
        last_rejected_at = ?,
        pinned_level = NULL
      WHERE id = ?
    `).run(now, trust.id)
    return { ...trust, approvalCount: 0, rejectionCount: trust.rejectionCount + 1, lastRejectedAt: now, pinnedLevel: null }
  }

  /** Pin a trust record to a specific level (user override). */
  pinTrust(action: string, category: string, repo: string | null, level: TrustLevel): void {
    const trust = this.getTrust(action, category, repo)
    this.db.prepare('UPDATE trust_records SET pinned_level = ? WHERE id = ?').run(level, trust.id)
  }

  /** Reset all trust records back to ASK. */
  resetAllTrust(): void {
    this.db.prepare('UPDATE trust_records SET approval_count = 0, pinned_level = NULL').run()
  }

  /** Compute the effective trust level for an action. */
  computeTrustLevel(action: string, category: string, severity: string, repo: string | null): TrustLevel {
    const trust = this.getTrust(action, category, repo)

    // User-pinned override takes precedence
    if (trust.pinnedLevel) return trust.pinnedLevel

    // High-severity actions have higher thresholds
    const isHighSeverity = severity === 'high' || severity === 'critical'
    const notifyThreshold = isHighSeverity ? 4 : 2
    const silentThreshold = isHighSeverity ? Infinity : 5  // high-severity never reaches silent

    if (trust.approvalCount >= silentThreshold) return 'silent'
    if (trust.approvalCount >= notifyThreshold) return 'notify_do'
    return 'ask'
  }

  /** List all trust records with their effective levels. */
  listTrustRecords(): (TrustRecord & { effectiveLevel: TrustLevel })[] {
    const rows = this.db.prepare('SELECT * FROM trust_records ORDER BY category, action').all() as Record<string, unknown>[]
    return rows.map(r => {
      const trust = this.rowToTrust(r)
      return {
        ...trust,
        effectiveLevel: this.computeTrustLevel(trust.action, trust.category, trust.severity, trust.repo),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private rowToItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: row.id as string,
      memoryType: row.memory_type as MemoryType,
      scope: row.scope as string | null,
      title: row.title as string | null,
      content: row.content as string,
      sourceRef: row.source_ref as string | null,
      confidence: row.confidence as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      expiresAt: row.expires_at as string | null,
      isPinned: (row.is_pinned as number) === 1,
      tags: JSON.parse((row.tags as string) || '[]'),
    }
  }

  private rowToTrust(row: Record<string, unknown>): TrustRecord {
    return {
      id: row.id as string,
      action: row.action as string,
      category: row.category as string,
      severity: row.severity as string,
      repo: row.repo as string | null,
      approvalCount: row.approval_count as number,
      rejectionCount: row.rejection_count as number,
      lastApprovedAt: row.last_approved_at as string | null,
      lastRejectedAt: row.last_rejected_at as string | null,
      pinnedLevel: row.pinned_level as TrustLevel | null,
    }
  }
}
