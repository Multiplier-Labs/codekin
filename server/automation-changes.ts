/**
 * Audit trail for repo automation configuration changes
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §10).
 *
 * Every create / update / disable / remove made through the automation
 * service — by the user in the Automations UI or by Joe through its MCP
 * tools — is recorded with actor, reason, before/after configuration and the
 * originating session or task. The same table backs idempotency: a mutation
 * carrying an idempotency key that was already applied returns the recorded
 * result instead of applying twice.
 *
 * Lives in the shared runs.db (better-sqlite3, WAL, 0o600), ':memory:' for tests.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'

export type AutomationChangeAction = 'create' | 'update' | 'enable' | 'disable' | 'remove'
export type AutomationActor = 'user' | 'joe' | 'system'

export interface AutomationChange {
  id: string
  automationId: string
  repo: string
  action: AutomationChangeAction
  actor: AutomationActor
  reason: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  /** Why the actor was allowed to make the change, e.g. "user request in session <id>". */
  authorization: string | null
  originSessionId: string | null
  taskId: string | null
  idempotencyKey: string | null
  createdAt: string
}

export type NewAutomationChange = Omit<AutomationChange, 'id' | 'createdAt'>

interface ChangeRow {
  id: string
  automation_id: string
  repo: string
  action: string
  actor: string
  reason: string | null
  before_json: string | null
  after_json: string | null
  authorization: string | null
  origin_session_id: string | null
  task_id: string | null
  idempotency_key: string | null
  created_at: string
}

export class AutomationChangeLog {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_changes (
        id                TEXT PRIMARY KEY,
        automation_id     TEXT NOT NULL,
        repo              TEXT NOT NULL,
        action            TEXT NOT NULL,
        actor             TEXT NOT NULL,
        reason            TEXT,
        before_json       TEXT,
        after_json        TEXT,
        authorization     TEXT,
        origin_session_id TEXT,
        task_id           TEXT,
        idempotency_key   TEXT UNIQUE,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_changes_automation ON automation_changes(automation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_automation_changes_repo ON automation_changes(repo, created_at);
    `)
  }

  record(change: NewAutomationChange): AutomationChange {
    const row: AutomationChange = { ...change, id: randomUUID(), createdAt: new Date().toISOString() }
    this.db.prepare(`
      INSERT INTO automation_changes
        (id, automation_id, repo, action, actor, reason, before_json, after_json, authorization, origin_session_id, task_id, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.automationId, row.repo, row.action, row.actor, row.reason,
      row.before ? JSON.stringify(row.before) : null,
      row.after ? JSON.stringify(row.after) : null,
      row.authorization, row.originSessionId, row.taskId, row.idempotencyKey, row.createdAt,
    )
    return row
  }

  findByIdempotencyKey(key: string): AutomationChange | null {
    const row = this.db.prepare('SELECT * FROM automation_changes WHERE idempotency_key = ?').get(key) as ChangeRow | undefined
    return row ? mapChange(row) : null
  }

  list(opts: { automationId?: string; repo?: string; limit?: number } = {}): AutomationChange[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.automationId) { where.push('automation_id = ?'); params.push(opts.automationId) }
    if (opts.repo) { where.push('repo = ?'); params.push(opts.repo) }
    params.push(Math.min(opts.limit ?? 50, 500))
    const sql = `SELECT * FROM automation_changes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    return (this.db.prepare(sql).all(...params) as ChangeRow[]).map(mapChange)
  }

  close(): void {
    this.db.close()
  }
}

function mapChange(row: ChangeRow): AutomationChange {
  return {
    id: row.id,
    automationId: row.automation_id,
    repo: row.repo,
    action: row.action as AutomationChangeAction,
    actor: row.actor as AutomationActor,
    reason: row.reason,
    before: row.before_json ? jsonParse(row.before_json) as Record<string, unknown> : null,
    after: row.after_json ? jsonParse(row.after_json) as Record<string, unknown> : null,
    authorization: row.authorization,
    originSessionId: row.origin_session_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }
}
