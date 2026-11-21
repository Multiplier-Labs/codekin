/**
 * Durable records for execution jobs (docs/EXECUTION-API.md).
 *
 * One table in the shared runs.db:
 *
 *   execution_jobs — one row per job; the idempotency record and the job are
 *                    the same row, keyed (client_id, user_ref, idem_key), so
 *                    deduplication is committed before anything executes.
 *
 * Same conventions as the other stores: better-sqlite3, WAL, 0o600, JSON as
 * TEXT, ':memory:' for tests. Payload columns (instructions, input, schema,
 * output, raw) are cleared by the retention sweep while the row itself —
 * the dedup tombstone — stays until it ages out.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'

function parseOr<T>(text: string, fallback: T): T {
  try { return jsonParse(text) as T } catch { return fallback }
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired'
export type JobPriority = 'interactive' | 'background'
export type JobOutputType = 'json' | 'text'

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'canceled', 'expired'])

export type JobErrorCode =
  | 'AUTH_REQUIRED' | 'QUOTA_EXHAUSTED' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_OUTPUT'
  | 'DEADLINE_EXCEEDED' | 'RUNTIME_UNAVAILABLE' | 'EXECUTION_INTERRUPTED'

export interface JobError {
  code: JobErrorCode
  message: string
  retryable: boolean
  /** ISO time after which a new attempt may succeed (from the harness's own reset time). */
  retryAfter: string | null
}

export interface JobUsage {
  inputTokens: number | null
  outputTokens: number | null
}

/** What a client submitted; hashed for idempotency. */
export interface JobRequest {
  userRef: string
  workload: string
  harness: string
  model: string | null
  effort: string | null
  instructions: string
  input: string
  output: { type: 'json'; schemaName: string; schema: Record<string, unknown> } | { type: 'text' }
  priority: JobPriority
  deadlineAt: string
  billingPolicy: 'subscription-only'
}

export interface Job {
  id: string
  clientId: string
  userRef: string
  workload: string
  harness: string
  model: string | null
  priority: JobPriority
  status: JobStatus
  /** Why a queued job is not running yet ('capacity' | 'budget' | 'quota'), else null. */
  waitReason: string | null
  attempts: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  deadlineAt: string
  cancelRequestedAt: string | null
  output: unknown
  raw: string | null
  usage: JobUsage | null
  error: JobError | null
  billingMode: string | null
  /** True once the retention sweep has removed payloads. */
  payloadExpired: boolean
}

interface JobRow {
  id: string
  client_id: string
  user_ref: string
  idem_key: string
  request_hash: string
  workload: string
  harness: string
  model: string | null
  priority: JobPriority
  status: JobStatus
  wait_reason: string | null
  attempts: number
  request_json: string | null
  output_json: string | null
  raw: string | null
  usage_json: string | null
  error_json: string | null
  billing_mode: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  deadline_at: string
  cancel_requested_at: string | null
  payload_expired: number
}

export type CreateResult =
  | { kind: 'created'; job: Job }
  | { kind: 'existing'; job: Job }
  | { kind: 'conflict'; job: Job }

export class ExecutionStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_jobs (
        id                  TEXT PRIMARY KEY,
        client_id           TEXT NOT NULL,
        user_ref            TEXT NOT NULL,
        idem_key            TEXT NOT NULL,
        request_hash        TEXT NOT NULL,
        workload            TEXT NOT NULL,
        harness             TEXT NOT NULL,
        model               TEXT,
        priority            TEXT NOT NULL,
        status              TEXT NOT NULL,
        wait_reason         TEXT,
        attempts            INTEGER NOT NULL DEFAULT 0,
        request_json        TEXT,
        output_json         TEXT,
        raw                 TEXT,
        usage_json          TEXT,
        error_json          TEXT,
        billing_mode        TEXT,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        finished_at         TEXT,
        deadline_at         TEXT NOT NULL,
        cancel_requested_at TEXT,
        payload_expired     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (client_id, user_ref, idem_key)
      );
      CREATE INDEX IF NOT EXISTS idx_execution_jobs_status ON execution_jobs(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_jobs_created ON execution_jobs(created_at);
    `)
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id,
      clientId: row.client_id,
      userRef: row.user_ref,
      workload: row.workload,
      harness: row.harness,
      model: row.model,
      priority: row.priority,
      status: row.status,
      waitReason: row.wait_reason,
      attempts: row.attempts,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      deadlineAt: row.deadline_at,
      cancelRequestedAt: row.cancel_requested_at,
      output: row.output_json === null ? null : parseOr<unknown>(row.output_json, null),
      raw: row.raw,
      usage: row.usage_json === null ? null : parseOr<JobUsage | null>(row.usage_json, null),
      error: row.error_json === null ? null : parseOr<JobError | null>(row.error_json, null),
      billingMode: row.billing_mode,
      payloadExpired: row.payload_expired === 1,
    }
  }

  /**
   * Insert a job, or return the existing one for the same (client, user, key).
   * Same key with a different request hash is a conflict.
   */
  create(clientId: string, idemKey: string, requestHash: string, req: JobRequest, now = new Date()): CreateResult {
    const tx = this.db.transaction((): CreateResult => {
      const existing = this.db.prepare(
        'SELECT * FROM execution_jobs WHERE client_id = ? AND user_ref = ? AND idem_key = ?',
      ).get(clientId, req.userRef, idemKey) as JobRow | undefined
      if (existing) {
        return { kind: existing.request_hash === requestHash ? 'existing' : 'conflict', job: this.toJob(existing) }
      }
      const id = `job_${randomUUID()}`
      this.db.prepare(`
        INSERT INTO execution_jobs (id, client_id, user_ref, idem_key, request_hash, workload, harness, model,
          priority, status, request_json, created_at, deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, clientId, req.userRef, idemKey, requestHash, req.workload, req.harness, req.model,
        req.priority, JSON.stringify(req), now.toISOString(), req.deadlineAt)
      const job = this.get(id)
      if (!job) throw new Error('execution job insert was not visible')
      return { kind: 'created', job }
    })
    return tx()
  }

  findByKey(clientId: string, userRef: string, idemKey: string): Job | null {
    const row = this.db.prepare('SELECT * FROM execution_jobs WHERE client_id = ? AND user_ref = ? AND idem_key = ?')
      .get(clientId, userRef, idemKey) as JobRow | undefined
    return row ? this.toJob(row) : null
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM execution_jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? this.toJob(row) : null
  }

  /** The stored request, or null once payloads have expired. */
  getRequest(id: string): JobRequest | null {
    const row = this.db.prepare('SELECT request_json FROM execution_jobs WHERE id = ?').get(id) as { request_json: string | null } | undefined
    return row?.request_json ? parseOr<JobRequest | null>(row.request_json, null) : null
  }

  /** Queued jobs in dispatch order: interactive first, then oldest first. */
  listQueued(): Job[] {
    const rows = this.db.prepare(`
      SELECT * FROM execution_jobs WHERE status = 'queued'
      ORDER BY CASE priority WHEN 'interactive' THEN 0 ELSE 1 END, created_at, id
    `).all() as JobRow[]
    return rows.map(r => this.toJob(r))
  }

  listByStatus(status: JobStatus): Job[] {
    return (this.db.prepare('SELECT * FROM execution_jobs WHERE status = ?').all(status) as JobRow[]).map(r => this.toJob(r))
  }

  countByStatus(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, expired: 0 }
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM execution_jobs GROUP BY status').all() as { status: JobStatus; n: number }[]) {
      counts[r.status] = r.n
    }
    return counts
  }

  countQueuedForClient(clientId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM execution_jobs WHERE client_id = ? AND status IN ('queued','running')").get(clientId) as { n: number }).n
  }

  setWaitReason(id: string, reason: string | null): void {
    this.db.prepare("UPDATE execution_jobs SET wait_reason = ? WHERE id = ? AND status = 'queued'").run(reason, id)
  }

  /** queued → running; returns false if the job is no longer queued (canceled meanwhile). */
  markRunning(id: string, now = new Date()): boolean {
    const r = this.db.prepare(`
      UPDATE execution_jobs SET status = 'running', wait_reason = NULL, attempts = attempts + 1,
        started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'queued'
    `).run(now.toISOString(), id)
    return r.changes === 1
  }

  /** running → queued for another attempt (keeps the attempt count). */
  requeue(id: string, error: JobError | null): void {
    this.db.prepare("UPDATE execution_jobs SET status = 'queued', error_json = ? WHERE id = ? AND status = 'running'")
      .run(error ? JSON.stringify(error) : null, id)
  }

  /**
   * Move a non-terminal job to a terminal state. Returns false when it was
   * already terminal — the first committed outcome wins.
   */
  finish(id: string, status: Exclude<JobStatus, 'queued' | 'running'>, fields: {
    output?: unknown; raw?: string | null; usage?: JobUsage | null; error?: JobError | null; billingMode?: string | null; model?: string | null
  } = {}, now = new Date()): boolean {
    const r = this.db.prepare(`
      UPDATE execution_jobs SET status = ?, finished_at = ?, wait_reason = NULL,
        output_json = ?, raw = ?, usage_json = ?, error_json = ?,
        billing_mode = COALESCE(?, billing_mode), model = COALESCE(?, model)
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(status, now.toISOString(),
      fields.output === undefined ? null : JSON.stringify(fields.output),
      fields.raw ?? null,
      fields.usage ? JSON.stringify(fields.usage) : null,
      fields.error ? JSON.stringify(fields.error) : null,
      fields.billingMode ?? null, fields.model ?? null, id)
    return r.changes === 1
  }

  markCancelRequested(id: string, now = new Date()): void {
    this.db.prepare('UPDATE execution_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?').run(now.toISOString(), id)
  }

  /**
   * Retention: clear payloads of jobs older than `payloadCutoff`, and delete
   * terminal rows (the dedup tombstones) older than `rowCutoff`.
   */
  sweep(payloadCutoff: Date, rowCutoff: Date): { payloadsCleared: number; rowsDeleted: number } {
    const cleared = this.db.prepare(`
      UPDATE execution_jobs SET request_json = NULL, output_json = NULL, raw = NULL, payload_expired = 1
      WHERE payload_expired = 0 AND created_at < ? AND status IN ('succeeded','failed','canceled','expired')
    `).run(payloadCutoff.toISOString()).changes
    const deleted = this.db.prepare(`
      DELETE FROM execution_jobs WHERE created_at < ? AND status IN ('succeeded','failed','canceled','expired')
    `).run(rowCutoff.toISOString()).changes
    return { payloadsCleared: cleared, rowsDeleted: deleted }
  }

  close(): void {
    this.db.close()
  }
}
