/**
 * Durable per-repo task list for Agent Joe (docs/JOE-TASKS-SPEC.md).
 *
 * Two tables in the shared runs.db:
 *
 *   joe_tasks        — one row per task; status is kept in sync with the
 *                      linked child run by OrchestratorTaskService.
 *   joe_task_events  — append-only history (who did what, when).
 *
 * Same conventions as RunStore: better-sqlite3, WAL, 0o600, JSON as TEXT,
 * ':memory:' for tests, a single event listener fed from the mutation
 * choke points.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'
import type { ChildVerification } from './orchestrator-children.js'

export type TaskStatus = 'todo' | 'in_progress' | 'needs_decision' | 'in_review' | 'done' | 'dismissed'
export type TaskPriority = 'high' | 'normal' | 'low'
export type TaskSource = 'user' | 'joe' | 'report' | 'incident'
export type TaskCompletionPolicy = 'pr' | 'merge' | 'commit-only'
export type TaskActor = 'user' | 'joe' | 'system'

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'needs_decision', 'in_review', 'done', 'dismissed']
export const TASK_PRIORITIES: readonly TaskPriority[] = ['high', 'normal', 'low']
export const TASK_SOURCES: readonly TaskSource[] = ['user', 'joe', 'report', 'incident']
export const TASK_COMPLETION_POLICIES: readonly TaskCompletionPolicy[] = ['pr', 'merge', 'commit-only']

/** Statuses a task never leaves on its own — only a human reopens them. */
export const CLOSED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'dismissed'])

export interface TaskDecision {
  question: string
  /** Joe's (or the system's) recommended answer, if any. */
  recommendation: string | null
  /** One-click answers; free text is always allowed. */
  options: string[]
  /** 'joe' asked explicitly; 'system' opened it because a child ended without verified work. */
  askedBy: 'joe' | 'system'
  askedAt: string
  answer: string | null
  answeredAt: string | null
}

export interface Task {
  id: string
  repo: string
  title: string
  detail: string
  acceptance: string
  priority: TaskPriority
  source: TaskSource
  sourceRef: string | null
  status: TaskStatus
  completionPolicy: TaskCompletionPolicy
  /** Current supervised attempt (child session id), if any. */
  childId: string | null
  /** Every attempt, oldest first. */
  childIds: string[]
  prUrl: string | null
  commit: string | null
  verification: ChildVerification | null
  decision: TaskDecision | null
  reviewNote: string | null
  /** Repo session the request came from; milestones are posted back there. */
  originSessionId: string | null
  /** The @Joe request in that session that created the task. */
  originRequestId: string | null
  /**
   * Set when the user (or an answer) asks for execution and cleared once an
   * attempt is running — "queued" is distinct from "running".
   */
  queuedAt: string | null
  createdBy: TaskActor
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface TaskEvent {
  id: string
  taskId: string
  actor: TaskActor
  summary: string
  createdAt: string
}

export interface CreateTaskInput {
  repo: string
  title: string
  detail?: string
  acceptance?: string
  priority?: TaskPriority
  source?: TaskSource
  sourceRef?: string | null
  completionPolicy?: TaskCompletionPolicy
  originSessionId?: string | null
  originRequestId?: string | null
  createdBy: TaskActor
}

export type TaskPatch = Partial<Pick<Task,
  'title' | 'detail' | 'acceptance' | 'priority' | 'status' | 'completionPolicy' | 'childId' | 'childIds'
  | 'prUrl' | 'commit' | 'verification' | 'decision' | 'reviewNote' | 'closedAt' | 'originSessionId' | 'queuedAt'>>

export interface TaskStoreEvent {
  taskId: string
  repo: string
  status: TaskStatus
}

interface TaskRow {
  id: string
  repo: string
  title: string
  detail: string
  acceptance: string
  priority: string
  source: string
  source_ref: string | null
  status: string
  completion_policy: string
  child_id: string | null
  child_ids: string
  pr_url: string | null
  commit_sha: string | null
  verification: string | null
  decision: string | null
  review_note: string | null
  origin_session_id: string | null
  origin_request_id: string | null
  queued_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

const PATCH_COLUMNS: Record<keyof TaskPatch, { column: string; json?: boolean }> = {
  title: { column: 'title' },
  detail: { column: 'detail' },
  acceptance: { column: 'acceptance' },
  priority: { column: 'priority' },
  status: { column: 'status' },
  completionPolicy: { column: 'completion_policy' },
  childId: { column: 'child_id' },
  childIds: { column: 'child_ids', json: true },
  prUrl: { column: 'pr_url' },
  commit: { column: 'commit_sha' },
  verification: { column: 'verification', json: true },
  decision: { column: 'decision', json: true },
  reviewNote: { column: 'review_note' },
  closedAt: { column: 'closed_at' },
  originSessionId: { column: 'origin_session_id' },
  queuedAt: { column: 'queued_at' },
}

export class TaskStore {
  private db: Database.Database
  private eventListener: ((event: TaskStoreEvent) => void) | null = null

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS joe_tasks (
        id                TEXT PRIMARY KEY,
        repo              TEXT NOT NULL,
        title             TEXT NOT NULL,
        detail            TEXT NOT NULL DEFAULT '',
        acceptance        TEXT NOT NULL DEFAULT '',
        priority          TEXT NOT NULL DEFAULT 'normal',
        source            TEXT NOT NULL DEFAULT 'user',
        source_ref        TEXT,
        status            TEXT NOT NULL DEFAULT 'todo',
        completion_policy TEXT NOT NULL DEFAULT 'pr',
        child_id          TEXT,
        child_ids         TEXT NOT NULL DEFAULT '[]',
        pr_url            TEXT,
        commit_sha        TEXT,
        verification      TEXT,
        decision          TEXT,
        review_note       TEXT,
        created_by        TEXT NOT NULL DEFAULT 'user',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        closed_at         TEXT
      );

      CREATE TABLE IF NOT EXISTS joe_task_events (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES joe_tasks(id),
        actor      TEXT NOT NULL,
        summary    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_joe_tasks_repo ON joe_tasks(repo);
      CREATE INDEX IF NOT EXISTS idx_joe_tasks_status ON joe_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_joe_tasks_child ON joe_tasks(child_id);
      CREATE INDEX IF NOT EXISTS idx_joe_task_events_task ON joe_task_events(task_id);
    `)
    this.migrate()
  }

  /** Additive columns for databases created before they existed. */
  private migrate(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(joe_tasks)').all() as { name: string }[]).map(c => c.name))
    for (const [column, type] of [['origin_session_id', 'TEXT'], ['origin_request_id', 'TEXT'], ['queued_at', 'TEXT']] as const) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE joe_tasks ADD COLUMN ${column} ${type}`)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_joe_tasks_origin ON joe_tasks(origin_session_id)')
  }

  setEventListener(listener: (event: TaskStoreEvent) => void): void {
    this.eventListener = listener
  }

  private emit(task: Task): void {
    if (!this.eventListener) return
    try {
      this.eventListener({ taskId: task.id, repo: task.repo, status: task.status })
    } catch (err) {
      console.error('[task-store] Event listener threw:', err)
    }
  }

  create(input: CreateTaskInput): Task {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO joe_tasks (id, repo, title, detail, acceptance, priority, source, source_ref, completion_policy, origin_session_id, origin_request_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.repo,
      input.title,
      input.detail ?? '',
      input.acceptance ?? '',
      input.priority ?? 'normal',
      input.source ?? 'user',
      input.sourceRef ?? null,
      input.completionPolicy ?? 'pr',
      input.originSessionId ?? null,
      input.originRequestId ?? null,
      input.createdBy,
      now,
      now,
    )
    this.appendEvent(id, input.createdBy, `Created: ${input.title}`)
    const task = this.get(id)
    if (!task) throw new Error(`Task ${id} vanished after insert`)
    this.emit(task)
    return task
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM joe_tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? mapTask(row) : null
  }

  /** The task a child session is (or was last) working on. */
  getByChild(childId: string): Task | null {
    const row = this.db.prepare(
      `SELECT * FROM joe_tasks WHERE child_id = ? OR EXISTS (SELECT 1 FROM json_each(child_ids) WHERE value = ?)
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(childId, childId) as TaskRow | undefined
    return row ? mapTask(row) : null
  }

  list(opts: { repo?: string; status?: TaskStatus; originSessionId?: string; limit?: number } = {}): Task[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.repo) { where.push('repo = ?'); params.push(opts.repo) }
    if (opts.originSessionId) {
      // Tasks started from the session, or executed in it.
      where.push('(origin_session_id = ? OR child_id = ? OR EXISTS (SELECT 1 FROM json_each(child_ids) WHERE value = ?))')
      params.push(opts.originSessionId, opts.originSessionId, opts.originSessionId)
    }
    if (opts.status) { where.push('status = ?'); params.push(opts.status) }
    const sql = `SELECT * FROM joe_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC LIMIT ?`
    params.push(opts.limit ?? 500)
    return (this.db.prepare(sql).all(...params) as TaskRow[]).map(mapTask)
  }

  /** Per-status counts, optionally for one repo. */
  counts(repo?: string): Record<TaskStatus, number> {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) AS n FROM joe_tasks${repo ? ' WHERE repo = ?' : ''} GROUP BY status`,
    ).all(...(repo ? [repo] : [])) as { status: TaskStatus; n: number }[]
    const counts = Object.fromEntries(TASK_STATUSES.map(s => [s, 0])) as Record<TaskStatus, number>
    for (const row of rows) counts[row.status] = row.n
    return counts
  }

  /** Apply a patch and record `summary` in the history. Returns the updated task. */
  patch(id: string, patch: TaskPatch, actor: TaskActor, summary?: string): Task | null {
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
      if (value === undefined) continue
      const { column, json } = PATCH_COLUMNS[key]
      sets.push(`${column} = ?`)
      params.push(json ? (value === null ? null : JSON.stringify(value)) : value)
    }
    sets.push('updated_at = ?')
    params.push(new Date().toISOString(), id)
    const result = this.db.prepare(`UPDATE joe_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    if (result.changes === 0) return null
    if (summary) this.appendEvent(id, actor, summary)
    const task = this.get(id)
    if (task) this.emit(task)
    return task
  }

  events(taskId: string): TaskEvent[] {
    return (this.db.prepare(
      'SELECT id, task_id, actor, summary, created_at FROM joe_task_events WHERE task_id = ? ORDER BY created_at, rowid',
    ).all(taskId) as { id: string; task_id: string; actor: TaskActor; summary: string; created_at: string }[])
      .map(r => ({ id: r.id, taskId: r.task_id, actor: r.actor, summary: r.summary, createdAt: r.created_at }))
  }

  private appendEvent(taskId: string, actor: TaskActor, summary: string): void {
    this.db.prepare('INSERT INTO joe_task_events (id, task_id, actor, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, actor, summary.slice(0, 1000), new Date().toISOString())
  }

  close(): void {
    this.db.close()
  }
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    detail: row.detail,
    acceptance: row.acceptance,
    priority: row.priority as TaskPriority,
    source: row.source as TaskSource,
    sourceRef: row.source_ref,
    status: row.status as TaskStatus,
    completionPolicy: row.completion_policy as TaskCompletionPolicy,
    childId: row.child_id,
    childIds: jsonParse(row.child_ids) as string[],
    prUrl: row.pr_url,
    commit: row.commit_sha,
    verification: row.verification ? jsonParse(row.verification) as ChildVerification : null,
    decision: row.decision ? jsonParse(row.decision) as TaskDecision : null,
    reviewNote: row.review_note,
    originSessionId: row.origin_session_id ?? null,
    originRequestId: row.origin_request_id ?? null,
    queuedAt: row.queued_at ?? null,
    createdBy: row.created_by as TaskActor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}
