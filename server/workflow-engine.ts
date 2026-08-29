/**
 * Lightweight workflow engine with SQLite persistence and cron scheduling.
 *
 * Provides step-based workflow execution, run tracking, event emission,
 * and cron-based scheduling — all backed by a single SQLite database.
 * Built inline to avoid external workflow library dependencies.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { jsonParse } from './json-parse.js'
import type { RunLifecycleStatus } from './run-status.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a workflow run.
 * - `queued`    — created but not yet executing
 * - `running`   — step execution in progress
 * - `succeeded` — all steps completed without error
 * - `failed`    — a step threw a non-skip error, or the run was aborted externally
 * - `canceled`  — `cancelRun()` was called and the AbortSignal fired
 * - `skipped`   — a step threw `WorkflowSkipped` (e.g. no code changes since last run)
 */
export type RunStatus = Extract<RunLifecycleStatus, 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped'>

/**
 * Throw this from any workflow step to cleanly skip a run without marking it as failed.
 * Useful for assessment workflows to short-circuit when no code changes have occurred.
 */
export class WorkflowSkipped extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowSkipped'
  }
}

/**
 * Thrown when a step references a session that no longer exists in the session manager —
 * either because it was deleted, expired, or never persisted across a server restart.
 * Carries enough context (run id, step key, session id, last heartbeat) for diagnostics.
 */
export class SessionGoneError extends Error {
  constructor(
    public readonly runId: string,
    public readonly stepKey: string,
    public readonly sessionId: string,
    public readonly lastSeen: string | null,
  ) {
    super(
      `Workflow session is no longer available — run=${runId} step=${stepKey} session=${sessionId} lastSeen=${lastSeen ?? 'unknown'}`,
    )
    this.name = 'SessionGoneError'
  }
}
/**
 * Lifecycle status of an individual workflow step.
 * - `pending`   — not yet reached by the executor
 * - `running`   — handler is currently executing
 * - `succeeded` — handler returned without error
 * - `failed`    — handler threw; remaining steps become `skipped`
 * - `skipped`   — run was canceled/failed/skipped before this step executed
 */
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

/** A single execution instance of a workflow, persisted to SQLite as JSON. */
export interface WorkflowRun {
  /** UUID primary key. */
  id: string
  /** Workflow kind identifier, e.g. `"code-review.daily"`. */
  kind: string
  /** Current lifecycle status (see `RunStatus`). */
  status: RunStatus
  /** Caller-provided input (e.g. `{ repoPath, sinceTimestamp }`). Stored as JSON text. */
  input: Record<string, unknown>
  /** Merged output of all succeeded steps, or `null` if incomplete. */
  output: Record<string, unknown> | null
  /** Error message from the failed/skipped step, or `null` on success. */
  error: string | null
  /** ISO timestamp when the run was created (queued). */
  createdAt: string
  /** ISO timestamp when execution began, or `null` if still queued. */
  startedAt: string | null
  /** ISO timestamp when execution finished (success, failure, or skip). */
  completedAt: string | null
  /** Codekin session id owned by this run, recorded by `create_session`. Null until that step records it. */
  sessionId?: string | null
  /** ISO timestamp updated whenever a step starts; serves as a liveness heartbeat for resume. */
  lastStepAt?: string | null
  /** Key of the step that was most recently marked running. Used to resume from the right place. */
  currentStepKey?: string | null
}

/** A single step within a workflow run. Insertion order (rowid) preserves definition order. */
export interface WorkflowStep {
  /** UUID primary key. */
  id: string
  /** Foreign key to the parent `WorkflowRun`. */
  runId: string
  /** Step identifier matching the `StepDefinition.key` from registration. */
  key: string
  /** Current lifecycle status (see `StepStatus`). */
  status: StepStatus
  /** Merged output of prior steps, passed as this step's input. */
  input: Record<string, unknown> | null
  /** Handler return value on success. */
  output: Record<string, unknown> | null
  /** Error message if the step failed. */
  error: string | null
  /** ISO timestamp when the step began executing. */
  startedAt: string | null
  /** ISO timestamp when the step finished. */
  completedAt: string | null
}

/** Persisted cron schedule — survives server restart. `nextRunAt` is pre-computed on upsert. */
export interface CronSchedule {
  /** Stable identifier (typically matches the ReviewRepoConfig id). */
  id: string
  /** Workflow kind to trigger, e.g. `"security-audit.weekly"`. */
  kind: string
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cronExpression: string
  /** Default input passed to the triggered run. */
  input: Record<string, unknown>
  /** Whether the scheduler should fire this schedule. */
  enabled: boolean
  /** ISO timestamp of the most recent cron-triggered run, or `null` if never fired. */
  lastRunAt: string | null
  /** Pre-computed ISO timestamp of the next fire time (avoids re-parsing on every tick). */
  nextRunAt: string | null
}

/** Event emitted via the `workflow_event` EventEmitter channel for real-time UI updates. */
export interface WorkflowEvent {
  /** Event name, e.g. `"run_started"`, `"step_failed"`, `"run_succeeded"`. */
  eventType: string
  /** UUID of the associated workflow run. */
  runId: string
  /** Workflow kind identifier. */
  kind: string
  /** Step key, present only for step-level events. */
  stepKey?: string
  /** Run status at the time of emission. */
  status?: string
  /** Optional extra data for the event consumer. */
  payload?: unknown
  /** ISO timestamp when the event was emitted. */
  timestamp: string
}

/**
 * Step handler function — receives step input + run context, returns step output.
 * @param input  Merged output of all preceding steps (plus the run's original input).
 * @param context.runId            UUID of the current run.
 * @param context.run              Full WorkflowRun object (mutable — reflects current status).
 * @param context.abortSignal      Fires when `cancelRun()` is called; handlers should check or listen on it.
 * @param context.resumed          True when this step is being re-executed after a server restart.
 *                                  Handlers can use this to skip side effects already performed
 *                                  (e.g. don't re-send a Claude prompt — just await the result).
 * @param context.recordSessionId  Persist the session id atomically with `create_session`, so that
 *                                  a later `resumeInterrupted()` scan can reattach to the session
 *                                  even if the server crashed before the step's output row was written.
 */
export type StepHandler = (
  input: Record<string, unknown>,
  context: {
    runId: string
    run: WorkflowRun
    abortSignal: AbortSignal
    resumed?: boolean
    recordSessionId?: (sessionId: string) => void
  }
) => Promise<Record<string, unknown>>

/**
 * Result of resolving a workflow's session at resume time.
 * `null` means the session is gone (deleted, expired, never persisted) and the run cannot resume.
 */
export interface SessionLiveness {
  /** ISO timestamp of the most recent activity on the session, if known. */
  lastActivityAt?: string | null
}

/** Lookup function used by `resumeInterrupted()` to decide whether a session is still resumable. */
export type SessionResolver = (sessionId: string) => SessionLiveness | null

interface StepDefinition {
  key: string
  handler: StepHandler
}

interface WorkflowDefinition {
  kind: string
  steps: StepDefinition[]
  /** Called after run completes (success or failure) for cleanup. */
  afterRun?: (run: WorkflowRun) => Promise<void>
}

// ---------------------------------------------------------------------------
// Cron expression parser (supports standard 5-field cron)
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = []
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    // Defensive guard — `step <= 0` would make the loops below never advance
    // (or run backwards), pinning the scheduler. Any caller that reaches this
    // branch with a zero/negative step has bypassed isValidCron, so refuse loudly.
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step value: ${stepMatch?.[2]} (must be > 0)`)
    }
    const range = stepMatch ? stepMatch[1] : part

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.push(i)
    } else if (range.includes('-')) {
      const [start, end] = range.split('-').map(Number)
      for (let i = start; i <= end; i += step) values.push(i)
    } else {
      values.push(parseInt(range, 10))
    }
  }
  return values
}

export function cronMatchesDate(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false

  try {
    const [minF, hourF, domF, monF, dowF] = parts
    const minute = parseCronField(minF, 0, 59)
    const hour = parseCronField(hourF, 0, 23)
    const dom = parseCronField(domF, 1, 31)
    const month = parseCronField(monF, 1, 12)
    const dow = parseCronField(dowF, 0, 6)

    return (
      minute.includes(date.getMinutes()) &&
      hour.includes(date.getHours()) &&
      dom.includes(date.getDate()) &&
      month.includes(date.getMonth() + 1) &&
      dow.includes(date.getDay())
    )
  } catch {
    // Malformed expression (e.g. step 0). Treat as never-matching so a bad
    // legacy schedule cannot pin the scheduler in a tight loop.
    return false
  }
}

/** Compute the next matching minute for a cron expression after `after`. */
function nextCronMatch(expression: string, after: Date): Date {
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  // Search up to 366 days ahead
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatchesDate(expression, d)) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  // Fallback: 24h from now
  return new Date(after.getTime() + 86400000)
}

// ---------------------------------------------------------------------------
// Query builder helper
// ---------------------------------------------------------------------------

interface ListQueryOpts {
  filters: Array<{ column: string; value: unknown }>
  orderBy?: string
  limit?: number
  offset?: number
}

/**
 * A bare SQL identifier: a table or column name with no quoting, spaces, or
 * other metacharacters. Filter values are always parameterized, but table and
 * column names cannot be — so they are validated against this pattern to ensure
 * a future caller passing user-controlled input cannot inject SQL.
 */
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

/** An ORDER BY clause: a single identifier followed by an explicit direction. */
const SQL_ORDER_BY = /^[a-z_][a-z0-9_]* (ASC|DESC)$/i

/**
 * Build a parameterized SELECT query from typed filter objects.
 *
 * Exported for testing. Filter values are parameterized; table/column/orderBy
 * are validated as bare SQL identifiers since they cannot be parameterized.
 */
export function buildListQuery(table: string, opts: ListQueryOpts): { sql: string; params: unknown[] } {
  if (!SQL_IDENTIFIER.test(table)) {
    throw new Error(`buildListQuery: invalid table name '${table}'`)
  }

  const params: unknown[] = []
  let sql = `SELECT * FROM ${table} WHERE 1=1`

  for (const f of opts.filters) {
    if (!SQL_IDENTIFIER.test(f.column)) {
      throw new Error(`buildListQuery: invalid filter column '${f.column}'`)
    }
    sql += ` AND ${f.column} = ?`
    params.push(f.value)
  }

  if (opts.orderBy) {
    if (!SQL_ORDER_BY.test(opts.orderBy)) {
      throw new Error(`buildListQuery: invalid orderBy clause '${opts.orderBy}'`)
    }
    sql += ` ORDER BY ${opts.orderBy}`
  }
  if (opts.limit) { sql += ` LIMIT ?`; params.push(opts.limit) }
  if (opts.offset) { sql += ` OFFSET ?`; params.push(opts.offset) }

  return { sql, params }
}

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

export class WorkflowEngine extends EventEmitter {
  private db: Database.Database
  private workflows = new Map<string, WorkflowDefinition>()
  private activeAbortControllers = new Map<string, AbortController>()
  private cronTimer: ReturnType<typeof setInterval> | null = null
  private sessionResolver: SessionResolver | null = null

  constructor(dbPath?: string) {
    super()
    const dir = join(homedir(), '.codekin')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const resolvedPath = dbPath ?? join(dir, 'workflows.db')
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.createTables()
    this.migrateSchema()
  }

  private createTables() {
    // WAL mode: allows concurrent reads while a write is in progress,
    // preventing the WS server from blocking while a cron tick writes.
    // Schema notes:
    //   workflow_runs  — one row per execution instance; input/output stored as JSON text.
    //   workflow_steps — child rows in definition order (rowid preserves insertion order for replay).
    //   cron_schedules — persisted so schedules survive server restart; next_run_at is
    //                    pre-computed on upsert to avoid re-parsing the expression on every tick.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input TEXT,
        output TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cron_schedules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_kind ON workflow_runs(kind);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_steps_run_id ON workflow_steps(run_id);
    `)
  }

  /**
   * Apply additive (backwards-compatible) schema migrations.
   * Each ALTER TABLE is wrapped in try/catch so a re-run on a migrated DB is a no-op
   * (SQLite has no `ADD COLUMN IF NOT EXISTS`). New columns are nullable so older rows
   * keep working without backfill.
   */
  private migrateSchema() {
    const additions = [
      // session id captured by create_session — lets resume locate the still-alive session.
      `ALTER TABLE workflow_runs ADD COLUMN session_id TEXT`,
      // heartbeat updated on every step start — distinguishes stuck runs from newly-started ones.
      `ALTER TABLE workflow_runs ADD COLUMN last_step_at TEXT`,
      // most recently running step key — tells resume where the work stopped.
      `ALTER TABLE workflow_runs ADD COLUMN current_step_key TEXT`,
    ]
    for (const sql of additions) {
      try {
        this.db.exec(sql)
      } catch (err) {
        // "duplicate column name" is the expected idempotent path; anything else is a real error.
        const msg = err instanceof Error ? err.message : String(err)
        if (!/duplicate column/i.test(msg)) throw err
      }
    }
  }

  /**
   * Register a callback used by `resumeInterrupted()` to decide whether a workflow's
   * session is still alive. Pass `null` to clear. Without a resolver, all interrupted
   * runs whose session_id is set are conservatively treated as resumable — but the
   * step handler will still surface a typed error if the session has actually gone.
   */
  setSessionResolver(resolver: SessionResolver | null) {
    this.sessionResolver = resolver
  }

  // -------------------------------------------------------------------------
  // Workflow registration
  // -------------------------------------------------------------------------

  /** Register a workflow kind with its step definitions. Must be called before `startRun()`. */
  registerWorkflow(definition: WorkflowDefinition) {
    this.workflows.set(definition.kind, definition)
    console.log(`[workflow] Registered workflow: ${definition.kind} (${definition.steps.length} steps)`)
  }

  /** Check whether a workflow kind has been registered. */
  hasWorkflow(kind: string): boolean {
    return this.workflows.has(kind)
  }

  // -------------------------------------------------------------------------
  // Run management
  // -------------------------------------------------------------------------

  /** Create and immediately start executing a workflow run. */
  async startRun(kind: string, input: Record<string, unknown> = {}): Promise<WorkflowRun> {
    const definition = this.workflows.get(kind)
    if (!definition) throw new Error(`Unknown workflow kind: ${kind}`)

    const now = new Date().toISOString()
    const run: WorkflowRun = {
      id: randomUUID(),
      kind,
      status: 'queued',
      input,
      output: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    }

    // Persist run
    this.db.prepare(`
      INSERT INTO workflow_runs (id, kind, status, input, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(run.id, run.kind, run.status, JSON.stringify(run.input), run.createdAt)

    // Create step rows
    for (const step of definition.steps) {
      this.db.prepare(`
        INSERT INTO workflow_steps (id, run_id, key, status)
        VALUES (?, ?, ?, 'pending')
      `).run(randomUUID(), run.id, step.key)
    }

    this.emitEvent('run_queued', run)

    // Execute asynchronously
    this.executeRun(run, definition).catch(err => {
      console.error(`[workflow] Unhandled error in run ${run.id}:`, err)
    })

    return run
  }

  /**
   * Core step executor. Runs each step sequentially, passing the accumulated
   * output of all previous steps (merged into `lastOutput`) as the next step's
   * input. This gives steps access to both their own inputs and upstream results
   * without explicit wiring.
   *
   * Failure model: a single step failure aborts the run immediately — remaining
   * steps are marked 'skipped'. There is no retry at the step level; callers
   * that need retry should wrap the handler logic or use a new run.
   *
   * Cancellation: `cancelRun()` calls controller.abort(); the AbortSignal is
   * passed to each handler so long-running async work can exit cooperatively.
   *
   * Resume: when `opts.resumeFromKey` is set, steps before that key are skipped
   * (their outputs come from `opts.priorOutput`) and the resumed step receives
   * `resumed: true` in its context so the handler can avoid double side effects.
   */
  private async executeRun(
    run: WorkflowRun,
    definition: WorkflowDefinition,
    opts?: { resumeFromKey?: string; priorOutput?: Record<string, unknown> },
  ) {
    const abortController = new AbortController()
    this.activeAbortControllers.set(run.id, abortController)

    const resumeFromKey = opts?.resumeFromKey
    const isResume = !!resumeFromKey

    // Mark running (no-op timestamp on resume so we keep the original startedAt)
    run.status = 'running'
    if (!isResume) {
      run.startedAt = new Date().toISOString()
      this.db.prepare(`UPDATE workflow_runs SET status = 'running', started_at = ? WHERE id = ?`)
        .run(run.startedAt, run.id)
      this.emitEvent('run_started', run)
    } else {
      this.db.prepare(`UPDATE workflow_runs SET status = 'running' WHERE id = ?`).run(run.id)
      this.emitEvent('run_resumed', run)
    }

    let lastOutput: Record<string, unknown> = isResume
      ? { ...(opts?.priorOutput ?? {}) }
      : { ...run.input }

    let reachedResumePoint = !isResume

    try {
      for (const stepDef of definition.steps) {
        if (!reachedResumePoint) {
          if (stepDef.key === resumeFromKey) reachedResumePoint = true
          else continue
        }

        if (abortController.signal.aborted) {
          throw new Error('Run canceled')
        }

        const stepRow = this.db.prepare(`SELECT id FROM workflow_steps WHERE run_id = ? AND key = ?`)
          .get(run.id, stepDef.key) as { id: string } | undefined
        if (!stepRow) continue

        // Mark step running + bump heartbeat / current step key on the run
        const stepStarted = new Date().toISOString()
        this.db.prepare(`UPDATE workflow_steps SET status = 'running', input = ?, started_at = ?, completed_at = NULL, output = NULL, error = NULL WHERE id = ?`)
          .run(JSON.stringify(lastOutput), stepStarted, stepRow.id)
        this.db.prepare(`UPDATE workflow_runs SET last_step_at = ?, current_step_key = ? WHERE id = ?`)
          .run(stepStarted, stepDef.key, run.id)
        run.lastStepAt = stepStarted
        run.currentStepKey = stepDef.key
        this.emitEvent('step_started', run, stepDef.key)

        const stepIsResumed = isResume && stepDef.key === resumeFromKey

        try {
          const result = await stepDef.handler(lastOutput, {
            runId: run.id,
            run,
            abortSignal: abortController.signal,
            resumed: stepIsResumed,
            recordSessionId: (sessionId: string) => this.recordSessionId(run.id, sessionId),
          })

          // Mark step succeeded
          const stepCompleted = new Date().toISOString()
          this.db.prepare(`UPDATE workflow_steps SET status = 'succeeded', output = ?, completed_at = ? WHERE id = ?`)
            .run(JSON.stringify(result), stepCompleted, stepRow.id)
          this.emitEvent('step_succeeded', run, stepDef.key)

          lastOutput = { ...lastOutput, ...result }
        } catch (err) {
          if (err instanceof WorkflowSkipped) throw err
          const msg = err instanceof Error ? err.message : String(err)
          const stepCompleted = new Date().toISOString()
          this.db.prepare(`UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
            .run(msg, stepCompleted, stepRow.id)
          this.emitEvent('step_failed', run, stepDef.key)
          throw err
        }
      }

      // All steps succeeded
      run.status = 'succeeded'
      run.output = lastOutput
      run.completedAt = new Date().toISOString()
      this.db.prepare(`UPDATE workflow_runs SET status = 'succeeded', output = ?, completed_at = ? WHERE id = ?`)
        .run(JSON.stringify(lastOutput), run.completedAt, run.id)
      this.emitEvent('run_succeeded', run)

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      run.completedAt = new Date().toISOString()

      // A step threw WorkflowSkipped → mark run as 'skipped' (not 'failed').
      // This is the intended exit path for assessment workflows that detect
      // no code changes since the last run.
      if (err instanceof WorkflowSkipped) {
        run.status = 'skipped'
        run.error = msg
        this.db.prepare(`UPDATE workflow_runs SET status = 'skipped', error = ?, completed_at = ? WHERE id = ?`)
          .run(run.error, run.completedAt, run.id)
        this.db.prepare(`UPDATE workflow_steps SET status = 'skipped' WHERE run_id = ? AND status IN ('pending', 'running')`)
          .run(run.id)
        this.emitEvent('run_skipped', run)
      } else {
        run.status = abortController.signal.aborted ? 'canceled' : 'failed'
        run.error = msg
        this.db.prepare(`UPDATE workflow_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?`)
          .run(run.status, run.error, run.completedAt, run.id)
        this.emitEvent(run.status === 'canceled' ? 'run_canceled' : 'run_failed', run)

        // Skip remaining steps
        this.db.prepare(`UPDATE workflow_steps SET status = 'skipped' WHERE run_id = ? AND status = 'pending'`)
          .run(run.id)
      }

    } finally {
      this.activeAbortControllers.delete(run.id)
      if (definition.afterRun) {
        try {
          await definition.afterRun(run)
        } catch (err) {
          console.error(`[workflow] afterRun hook error for ${run.id}:`, err)
        }
      }
    }
  }

  /** Signal an active run to abort. Returns true if the run was in-flight and the signal was sent. */
  cancelRun(runId: string): boolean {
    const controller = this.activeAbortControllers.get(runId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  /**
   * Persist a session id on a run so that `resumeInterrupted()` can locate the
   * still-alive session even if the server crashes before the `create_session`
   * step's output row is committed. Called from inside the step handler via
   * `ctx.recordSessionId(...)`.
   */
  recordSessionId(runId: string, sessionId: string) {
    this.db.prepare(`UPDATE workflow_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Fetch a single run with all its steps (ordered by definition order). Returns `null` if not found. */
  getRun(runId: string): (WorkflowRun & { steps: WorkflowStep[] }) | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(runId) as Record<string, string> | undefined
    if (!row) return null

    const steps = (this.db.prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY rowid`).all(runId) as Record<string, string>[])
      .map(s => ({
        id: s.id,
        runId: s.run_id,
        key: s.key,
        status: s.status as StepStatus,
        input: s.input ? jsonParse(s.input) as Record<string, unknown> : null,
        output: s.output ? jsonParse(s.output) as Record<string, unknown> : null,
        error: s.error,
        startedAt: s.started_at,
        completedAt: s.completed_at,
      }))

    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      input: jsonParse(row.input) as Record<string, unknown>,
      output: row.output ? jsonParse(row.output) as Record<string, unknown> : null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      sessionId: row.session_id ?? null,
      lastStepAt: row.last_step_at ?? null,
      currentStepKey: row.current_step_key ?? null,
      steps,
    }
  }

  /** List runs with optional filtering by kind/status, ordered newest-first. */
  listRuns(opts?: { kind?: string; status?: RunStatus; limit?: number; offset?: number }): WorkflowRun[] {
    const { sql, params } = buildListQuery('workflow_runs', {
      filters: [
        opts?.kind ? { column: 'kind', value: opts.kind } : null,
        opts?.status ? { column: 'status', value: opts.status } : null,
      ].filter(Boolean) as Array<{ column: string; value: unknown }>,
      orderBy: 'created_at DESC',
      limit: opts?.limit,
      offset: opts?.offset,
    })

    return (this.db.prepare(sql).all(...params) as Record<string, string>[]).map(row => ({
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      input: jsonParse(row.input) as Record<string, unknown>,
      output: row.output ? jsonParse(row.output) as Record<string, unknown> : null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      sessionId: row.session_id ?? null,
      lastStepAt: row.last_step_at ?? null,
      currentStepKey: row.current_step_key ?? null,
    }))
  }

  // -------------------------------------------------------------------------
  // Cron scheduling
  // -------------------------------------------------------------------------

  /** Create or update a cron schedule. Pre-computes `nextRunAt` from the expression. */
  upsertSchedule(schedule: Omit<CronSchedule, 'lastRunAt' | 'nextRunAt'>): CronSchedule {
    const nextRun = schedule.enabled ? nextCronMatch(schedule.cronExpression, new Date()).toISOString() : null

    const existing = this.db.prepare(`SELECT id FROM cron_schedules WHERE id = ?`).get(schedule.id)
    if (existing) {
      this.db.prepare(`
        UPDATE cron_schedules SET kind = ?, cron_expression = ?, input = ?, enabled = ?, next_run_at = ?
        WHERE id = ?
      `).run(schedule.kind, schedule.cronExpression, JSON.stringify(schedule.input), schedule.enabled ? 1 : 0, nextRun, schedule.id)
    } else {
      this.db.prepare(`
        INSERT INTO cron_schedules (id, kind, cron_expression, input, enabled, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(schedule.id, schedule.kind, schedule.cronExpression, JSON.stringify(schedule.input), schedule.enabled ? 1 : 0, nextRun)
    }

    return { ...schedule, lastRunAt: null, nextRunAt: nextRun }
  }

  /** Delete a cron schedule by ID. Returns true if a row was deleted. */
  deleteSchedule(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM cron_schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** List all cron schedules (enabled and disabled). */
  listSchedules(): CronSchedule[] {
    return (this.db.prepare(`SELECT * FROM cron_schedules`).all() as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      kind: row.kind as string,
      cronExpression: row.cron_expression as string,
      input: jsonParse(row.input as string) as Record<string, unknown>,
      enabled: !!(row.enabled as number),
      lastRunAt: row.last_run_at as string | null,
      nextRunAt: row.next_run_at as string | null,
    }))
  }

  /** Fetch a single cron schedule by ID. Returns `null` if not found. */
  getSchedule(id: string): CronSchedule | null {
    const row = this.db.prepare(`SELECT * FROM cron_schedules WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string,
      kind: row.kind as string,
      cronExpression: row.cron_expression as string,
      input: jsonParse(row.input as string) as Record<string, unknown>,
      enabled: !!(row.enabled as number),
      lastRunAt: row.last_run_at as string | null,
      nextRunAt: row.next_run_at as string | null,
    }
  }

  /** Trigger a schedule immediately, creating a new run. */
  async triggerSchedule(id: string): Promise<WorkflowRun> {
    const schedule = this.getSchedule(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    return this.startRun(schedule.kind, schedule.input)
  }

  /** Start the cron polling loop (checks every 60s). */
  startCronScheduler() {
    if (this.cronTimer) return
    console.log('[workflow] Cron scheduler started')

    const tick = () => {
      const now = new Date()
      const schedules = this.listSchedules().filter(s => s.enabled && s.nextRunAt)

      for (const schedule of schedules) {
        if (new Date(schedule.nextRunAt!) <= now) {
          console.log(`[workflow] Cron triggered: ${schedule.id} (${schedule.kind})`)

          // Update last/next run times
          const nextRun = nextCronMatch(schedule.cronExpression, now).toISOString()
          this.db.prepare(`UPDATE cron_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
            .run(now.toISOString(), nextRun, schedule.id)

          // Pass last run timestamp so assessment workflows can skip if no changes
          const runInput = schedule.lastRunAt
            ? { ...schedule.input, sinceTimestamp: schedule.lastRunAt }
            : schedule.input
          this.startRun(schedule.kind, runInput).catch(err => {
            console.error(`[workflow] Cron trigger failed for ${schedule.id}:`, err)
          })
        }
      }
    }

    // Check immediately, then every 60s
    tick()
    this.cronTimer = setInterval(tick, 60_000)
  }

  /** Stop the cron polling loop. Safe to call multiple times. */
  stopCronScheduler() {
    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = null
      console.log('[workflow] Cron scheduler stopped')
    }
  }

  // -------------------------------------------------------------------------
  // Resume interrupted runs on startup
  // -------------------------------------------------------------------------

  /**
   * Resume runs that were in-flight when the server last shut down.
   *
   * Strategy:
   *   1. Find all runs still marked `running` (no graceful completion happened).
   *   2. For each, look at `session_id` + `current_step_key` — captured before the crash.
   *   3. If the session is still alive (per `sessionResolver`) and the step is one we know how
   *      to resume (`run_prompt`, `save_report`), re-execute from there with `resumed: true`.
   *   4. Otherwise mark the run failed with a clear, typed reason. We do NOT silently mark
   *      remaining steps `skipped` — the failure surface is loud so reports don't go missing.
   *
   * Earlier steps (`validate_repo`, `create_session`) are not resumed: by the time they were
   * running, the workflow had no usable session yet, and re-creating one mid-way would risk
   * spawning duplicate sessions or sending the prompt twice.
   */
  async resumeInterrupted() {
    const interrupted = this.db.prepare(`
      SELECT id, kind, session_id, current_step_key, last_step_at, input
      FROM workflow_runs WHERE status = 'running'
    `).all() as Array<{
      id: string
      kind: string
      session_id: string | null
      current_step_key: string | null
      last_step_at: string | null
      input: string | null
    }>
    if (interrupted.length === 0) return

    console.log(`[workflow] Found ${interrupted.length} interrupted run(s), evaluating for resume`)

    for (const row of interrupted) {
      const definition = this.workflows.get(row.kind)
      if (!definition) {
        this.failInterrupted(row.id, `Server restarted during execution (workflow kind '${row.kind}' is no longer registered)`)
        continue
      }

      const stepKey = row.current_step_key
      const sessionId = row.session_id

      // Only the later steps are safely resumable: by then the session is established
      // and the prompt has been (or is being) processed. Earlier steps are too short
      // to bother resuming and re-running them risks duplicate side effects.
      const RESUMABLE_STEPS = new Set(['run_prompt', 'save_report'])

      if (!stepKey || !RESUMABLE_STEPS.has(stepKey)) {
        this.failInterrupted(
          row.id,
          `Server restarted during '${stepKey ?? 'unknown'}' step before session was usable for resume`,
        )
        continue
      }

      if (!sessionId) {
        this.failInterrupted(
          row.id,
          `Server restarted during '${stepKey}' step but no session id was recorded — cannot resume`,
        )
        continue
      }

      const liveness = this.sessionResolver?.(sessionId) ?? null
      if (this.sessionResolver && !liveness) {
        const err = new SessionGoneError(row.id, stepKey, sessionId, row.last_step_at)
        console.warn(`[workflow] resume: ${err.message}`)
        this.failInterrupted(row.id, err.message)
        continue
      }

      console.log(`[workflow] Resuming run ${row.id} (${row.kind}) at step '${stepKey}' (session=${sessionId})`)

      // Reconstruct the merged output of all previously succeeded steps so the resumed
      // step receives the same `lastOutput` it would have during a normal run.
      const stepRows = this.db.prepare(`
        SELECT key, status, output FROM workflow_steps WHERE run_id = ? ORDER BY rowid
      `).all(row.id) as Array<{ key: string; status: string; output: string | null }>

      let priorOutput: Record<string, unknown> = row.input ? jsonParse(row.input) as Record<string, unknown> : {}
      for (const sr of stepRows) {
        if (sr.key === stepKey) break
        if (sr.status === 'succeeded' && sr.output) {
          priorOutput = { ...priorOutput, ...(jsonParse(sr.output) as Record<string, unknown>) }
        }
      }

      const run = this.getRun(row.id)
      if (!run) {
        this.failInterrupted(row.id, 'Run row disappeared before resume could start')
        continue
      }

      // Reset the in-flight step so executeRun can mark it running again
      this.db.prepare(`UPDATE workflow_steps SET status = 'pending', error = NULL, completed_at = NULL WHERE run_id = ? AND key = ? AND status = 'running'`)
        .run(row.id, stepKey)

      // Kick off resume in the background — same fire-and-forget pattern as startRun
      this.executeRun(run, definition, { resumeFromKey: stepKey, priorOutput }).catch(err => {
        console.error(`[workflow] Unhandled error in resumed run ${row.id}:`, err)
      })
    }
  }

  /** Mark a run as failed during the resume scan (no AbortController, no in-memory run object). */
  private failInterrupted(runId: string, reason: string) {
    const completedAt = new Date().toISOString()
    this.db.prepare(`UPDATE workflow_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
      .run(reason, completedAt, runId)
    this.db.prepare(`UPDATE workflow_steps SET status = 'failed', error = ?, completed_at = ? WHERE run_id = ? AND status = 'running'`)
      .run(reason, completedAt, runId)
    this.db.prepare(`UPDATE workflow_steps SET status = 'skipped' WHERE run_id = ? AND status = 'pending'`)
      .run(runId)
    const row = this.db.prepare(`SELECT id, kind FROM workflow_runs WHERE id = ?`).get(runId) as { id: string; kind: string } | undefined
    if (row) {
      this.emit('workflow_event', {
        eventType: 'run_failed',
        runId: row.id,
        kind: row.kind,
        status: 'failed',
        timestamp: completedAt,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private emitEvent(eventType: string, run: WorkflowRun, stepKey?: string) {
    const event: WorkflowEvent = {
      eventType,
      runId: run.id,
      kind: run.kind,
      stepKey,
      status: run.status,
      timestamp: new Date().toISOString(),
    }
    this.emit('workflow_event', event)
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Gracefully shut down: stop cron, cancel active runs, close the database. */
  shutdown() {
    this.stopCronScheduler()
    // Cancel all active runs
    for (const [runId, controller] of this.activeAbortControllers) {
      console.log(`[workflow] Canceling active run: ${runId}`)
      controller.abort()
    }
    this.db.close()
    console.log('[workflow] Engine shut down')
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let engineInstance: WorkflowEngine | null = null

/** Initialize the singleton workflow engine (idempotent — returns existing instance if already created). */
export function initWorkflowEngine(): WorkflowEngine {
  if (engineInstance) return engineInstance
  engineInstance = new WorkflowEngine()
  console.log('[workflow] Stepflow engine initialized')
  return engineInstance
}

/** Get the singleton workflow engine. Throws if `initWorkflowEngine()` hasn't been called. */
export function getWorkflowEngine(): WorkflowEngine {
  if (!engineInstance) throw new Error('Workflow engine not initialized — call initWorkflowEngine() first')
  return engineInstance
}

/** Shut down and discard the singleton engine. Safe to call when no engine exists. */
export function shutdownWorkflowEngine() {
  if (engineInstance) {
    engineInstance.shutdown()
    engineInstance = null
  }
}
