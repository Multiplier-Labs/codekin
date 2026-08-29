/**
 * The unified run store — one schema for every background run.
 *
 * Two tables in the shared runs.db:
 *
 *   runs        — one row per run, already in the UnifiedRun shape the
 *                 /api/runs read model serves (engine + kind + canonical
 *                 status + repo/branch/cost/pr/session).
 *   run_ledger  — ordered evidence entries (spawned, blocked, verified,
 *                 completed, …) with an optional JSON payload.
 *
 * First tenant: orchestrator child sessions (engine 'agent') — previously
 * in-memory only, gone on every restart. Workflows and loops keep their
 * existing tables for now and migrate in behind the /api/runs contract once
 * the runs.db migration has proven itself in production; this store is
 * purely additive until then.
 *
 * Same conventions as the other stores: better-sqlite3, WAL, 0o600, JSON as
 * TEXT, ':memory:' for tests, a single event listener fed from the mutation
 * choke points.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'
import { TERMINAL_RUN_STATUSES, type RunLifecycleStatus } from './run-status.js'

export type RunEngine = 'agent' | 'workflow' | 'loop'

export interface StoredRun {
  id: string
  engine: RunEngine
  kind: string
  status: RunLifecycleStatus
  /** Short human-readable purpose (e.g. the child's task). */
  title: string
  repo: string | null
  branch: string | null
  /** Engine-specific request/spec payload (JSON). */
  spec: Record<string, unknown>
  /** Sessions doing the work (a child has one; a loop would have maker+checker). */
  sessionIds: string[]
  costUsd: number | null
  prUrl: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

export interface CreateRunInput {
  id?: string
  engine: RunEngine
  kind: string
  title: string
  repo?: string | null
  branch?: string | null
  spec?: Record<string, unknown>
  sessionIds?: string[]
}

export interface StoredRunPatch {
  status?: RunLifecycleStatus
  costUsd?: number | null
  prUrl?: string | null
  error?: string | null
  completedAt?: string | null
  sessionIds?: string[]
}

export interface LedgerEntry {
  id: string
  runId: string
  entryIndex: number
  /** Actor or phase, e.g. 'system', 'maker', 'checker'. */
  role: string
  summary: string
  payload: Record<string, unknown> | null
  createdAt: string
}

export interface RunStoreEvent {
  eventType: 'run_status' | 'ledger'
  runId: string
  engine: RunEngine
  kind: string
  status?: RunLifecycleStatus
}

interface RunRow {
  id: string
  engine: string
  kind: string
  status: string
  title: string
  repo: string | null
  branch: string | null
  spec: string
  session_ids: string
  cost_usd: number | null
  pr_url: string | null
  error: string | null
  created_at: string
  completed_at: string | null
}

interface LedgerRow {
  id: string
  run_id: string
  entry_index: number
  role: string
  summary: string
  payload: string | null
  created_at: string
}

const PATCH_COLUMNS: Record<keyof StoredRunPatch, string> = {
  status: 'status',
  costUsd: 'cost_usd',
  prUrl: 'pr_url',
  error: 'error',
  completedAt: 'completed_at',
  sessionIds: 'session_ids',
}

export class RunStore {
  private db: Database.Database
  private eventListener: ((event: RunStoreEvent) => void) | null = null

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT PRIMARY KEY,
        engine       TEXT NOT NULL,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        title        TEXT NOT NULL DEFAULT '',
        repo         TEXT,
        branch       TEXT,
        spec         TEXT NOT NULL DEFAULT '{}',
        session_ids  TEXT NOT NULL DEFAULT '[]',
        cost_usd     REAL,
        pr_url       TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS run_ledger (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES runs(id),
        entry_index INTEGER NOT NULL,
        role        TEXT NOT NULL DEFAULT 'system',
        summary     TEXT NOT NULL,
        payload     TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_engine ON runs(engine);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_run_ledger_run_id ON run_ledger(run_id);
    `)
  }

  setEventListener(listener: (event: RunStoreEvent) => void): void {
    this.eventListener = listener
  }

  private emit(event: RunStoreEvent): void {
    if (!this.eventListener) return
    try {
      this.eventListener(event)
    } catch (err) {
      console.error('[run-store] Event listener threw:', err)
    }
  }

  createRun(input: CreateRunInput): StoredRun {
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO runs (id, engine, kind, status, title, repo, branch, spec, session_ids, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.engine,
        input.kind,
        input.title,
        input.repo ?? null,
        input.branch ?? null,
        JSON.stringify(input.spec ?? {}),
        JSON.stringify(input.sessionIds ?? []),
        createdAt,
      )
    this.emit({ eventType: 'run_status', runId: id, engine: input.engine, kind: input.kind, status: 'queued' })
    const run = this.getRun(id)
    if (!run) throw new Error(`run ${id} vanished immediately after insert`)
    return run
  }

  getRun(id: string): StoredRun | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined
    return row ? mapRun(row) : null
  }

  listRuns(opts: { engine?: RunEngine; status?: RunLifecycleStatus; limit?: number } = {}): StoredRun[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts.engine) {
      clauses.push('engine = ?')
      params.push(opts.engine)
    }
    if (opts.status) {
      clauses.push('status = ?')
      params.push(opts.status)
    }
    let sql = `SELECT * FROM runs`
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ` ORDER BY created_at DESC, rowid DESC`
    if (opts.limit) {
      sql += ` LIMIT ?`
      params.push(opts.limit)
    }
    return (this.db.prepare(sql).all(...params) as RunRow[]).map(mapRun)
  }

  patchRun(id: string, patch: StoredRunPatch): void {
    const sets: string[] = []
    const params: unknown[] = []
    for (const key of Object.keys(patch) as (keyof StoredRunPatch)[]) {
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${PATCH_COLUMNS[key]} = ?`)
      params.push(key === 'sessionIds' ? JSON.stringify(value) : value)
    }
    if (!sets.length) return
    params.push(id)
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    if (patch.status !== undefined) {
      const run = this.getRun(id)
      if (run) this.emit({ eventType: 'run_status', runId: id, engine: run.engine, kind: run.kind, status: patch.status })
    }
  }

  appendLedger(runId: string, entry: { role?: string; summary: string; payload?: Record<string, unknown> }): void {
    const run = this.getRun(runId)
    if (!run) return
    const next = this.db.prepare(`SELECT COALESCE(MAX(entry_index), -1) + 1 AS n FROM run_ledger WHERE run_id = ?`).get(runId) as { n: number }
    this.db
      .prepare(`INSERT INTO run_ledger (id, run_id, entry_index, role, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, next.n, entry.role ?? 'system', entry.summary, entry.payload ? JSON.stringify(entry.payload) : null, new Date().toISOString())
    this.emit({ eventType: 'ledger', runId, engine: run.engine, kind: run.kind })
  }

  listLedger(runId: string): LedgerEntry[] {
    return (this.db.prepare(`SELECT * FROM run_ledger WHERE run_id = ? ORDER BY entry_index ASC`).all(runId) as LedgerRow[]).map((r) => ({
      id: r.id,
      runId: r.run_id,
      entryIndex: r.entry_index,
      role: r.role,
      summary: r.summary,
      payload: r.payload ? (jsonParse(r.payload) as Record<string, unknown>) : null,
      createdAt: r.created_at,
    }))
  }

  /**
   * Boot-time recovery: runs left non-terminal by the previous process can
   * never progress (their sessions and watchers died with it). Mark them
   * failed with an honest ledger entry. Returns the ids marked.
   */
  failInterrupted(engine?: RunEngine): string[] {
    const interrupted: string[] = []
    for (const run of this.listRuns({ engine })) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) continue
      this.appendLedger(run.id, { summary: 'Run interrupted by a server restart before completing.' })
      this.patchRun(run.id, { status: 'failed', error: 'interrupted by server restart', completedAt: new Date().toISOString() })
      interrupted.push(run.id)
    }
    return interrupted
  }

  close(): void {
    this.db.close()
  }
}

function mapRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    engine: row.engine as RunEngine,
    kind: row.kind,
    status: row.status as RunLifecycleStatus,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    spec: jsonParse(row.spec) as Record<string, unknown>,
    sessionIds: jsonParse(row.session_ids) as string[],
    costUsd: row.cost_usd,
    prUrl: row.pr_url,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}
