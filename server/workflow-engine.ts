/**
 * Lightweight workflow engine with SQLite persistence and cron scheduling.
 *
 * Provides step-based workflow execution, run tracking, event emission,
 * and cron-based scheduling — all backed by a single SQLite database.
 * Built inline to avoid external workflow library dependencies.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { jsonParse } from './json-parse.js'
import type { RunLifecycleStatus } from './run-status.js'
import { defaultRunsDbPath, legacyDbPath, migrateLegacyTables } from './run-db.js'
import { nextCronMatch } from './cron.js'

// Re-exported so existing importers (tests, routes) keep working after the
// parser moved to the shared cron module.
export { cronMatchesDate, nextCronMatch, isValidCron } from './cron.js'

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
  /**
   * What to do with a fire time missed by more than the grace window (e.g. server downtime):
   * `collapse` (default) — fire once now, however many slots were missed; `skip` — wait for
   * the next natural slot.
   */
  catchUp: 'collapse' | 'skip'
  /** HEAD sha at dispatch of the last *successful* run — the change-detection anchor. */
  lastReviewedSha: string | null
  /** ISO timestamp of the most recent held (withheld) dispatch. */
  lastHeldAt: string | null
  /** Why the most recent dispatch was held. */
  lastHeldReason: string | null
  /** Total number of held dispatches over the schedule's lifetime. */
  heldCount: number
}

/** Caller-supplied fields for `upsertSchedule` — trigger bookkeeping columns are engine-managed. */
export type CronScheduleUpsert =
  Omit<CronSchedule, 'lastRunAt' | 'nextRunAt' | 'catchUp' | 'lastReviewedSha' | 'lastHeldAt' | 'lastHeldReason' | 'heldCount'>
  & { catchUp?: 'collapse' | 'skip' }

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
// Trigger decisions
// ---------------------------------------------------------------------------

/** One row of the trigger ledger — a record of why a schedule did or didn't fire. */
export interface TriggerLedgerEntry {
  id: number
  scheduleId: string | null
  kind: string
  /** `fired` — a run was started. `held` — the dispatch was withheld (see `reason`). */
  decision: 'fired' | 'held'
  reason: string
  runId: string | null
  headSha: string | null
  createdAt: string
}

/** Liveness snapshot of the dispatch loop, written on every tick. */
export interface EngineHealth {
  lastTickAt: string | null
  tickCount: number
}

/**
 * A durable event in the `signals` table. Producers INSERT (commit event,
 * probe breach, webhook); the dispatcher consumes with a lease and marks
 * `done` only after the handler resolves — a crash mid-processing means lease
 * expiry and redelivery, never loss (at-least-once).
 */
export interface Signal {
  id: number
  kind: string
  payload: Record<string, unknown>
  dedupeKey: string | null
  status: 'pending' | 'processing' | 'done' | 'failed' | 'expired'
  attempts: number
  createdAt: string
  processedAt: string | null
  error: string | null
}

/**
 * Consumes one signal. Resolve = acknowledged (signal marked done). Reject =
 * the signal stays leased and is redelivered after lease expiry, up to the
 * attempt cap — so handlers must be idempotent.
 */
export type SignalHandler = (payload: Record<string, unknown>, signal: Signal) => Promise<void>

/** Resolve a repo's current HEAD sha; `null` when unavailable (missing repo, not a git dir). */
export type HeadShaResolver = (repoPath: string) => string | null

/**
 * Resolve a repo's activity tier for the dispatch gate; `null` (or a throw)
 * means "unknown" and the gate fails open. Backed by the RepoActivityIndex —
 * typed structurally here so the engine has no import dependency on it.
 */
export type ActivityResolver = (repoPath: string) => { tier: 'active' | 'cooling' | 'dormant' } | null

function defaultHeadShaResolver(repoPath: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 5000 })
      .toString().trim()
    return sha || null
  } catch {
    return null
  }
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
  /** Runs started by the dispatcher — lets run-success update the schedule's lastReviewedSha. */
  private dispatchIndex = new Map<string, { scheduleId: string; headSha: string | null }>()
  private headShaResolver: HeadShaResolver = defaultHeadShaResolver
  private activityResolver: ActivityResolver | null = null
  private signalHandlers = new Map<string, SignalHandler>()
  /** Periodic housekeeping folded onto the dispatch tick — no extra interval loops. */
  private tickTasks = new Map<string, { intervalMs: number; fn: () => void | Promise<void>; lastRunAt: number; running: boolean }>()

  /** Max dispatches per tick — staggers a backlog after downtime instead of stampeding. */
  static readonly MAX_DISPATCH_PER_TICK = 3
  /** Retry delay when a dispatch is held because the previous run is still active. */
  static readonly CONCURRENCY_RETRY_MS = 5 * 60_000
  /** For catchUp 'skip': a fire time missed by more than this is abandoned to the next slot. */
  static readonly CATCH_UP_GRACE_MS = 10 * 60_000
  /** In the 'cooling' tier, scheduled runs are spaced at least this far apart. */
  static readonly COOLING_MIN_INTERVAL_MS = 7 * 24 * 60 * 60_000
  /** Trigger-ledger rows older than this are pruned when the scheduler starts. */
  static readonly LEDGER_RETENTION_MS = 30 * 24 * 60 * 60_000
  /** How long a signal handler may hold a lease before the signal is redelivered. */
  static readonly SIGNAL_LEASE_MS = 5 * 60_000
  /** Delivery attempts before a signal is marked failed instead of retried. */
  static readonly SIGNAL_MAX_ATTEMPTS = 3
  /** Default lifetime of an unprocessed signal — stale events must not fire hours late. */
  static readonly SIGNAL_DEFAULT_TTL_MS = 24 * 60 * 60_000
  /** Max signals consumed per tick — the same backlog-stagger idea as schedule dispatch. */
  static readonly MAX_SIGNALS_PER_TICK = 10

  constructor(dbPath?: string, legacyPath?: string) {
    super()
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.createTables()
    this.migrateSchema()
    // Carry rows over from the pre-unification workflows.db (one-time, per table).
    const resolvedLegacy = legacyPath ?? (dbPath === undefined ? legacyDbPath('workflows.db') : undefined)
    if (resolvedLegacy) migrateLegacyTables(this.db, resolvedLegacy, ['workflow_runs', 'workflow_steps', 'cron_schedules'])
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

      CREATE TABLE IF NOT EXISTS trigger_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT,
        kind TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        run_id TEXT,
        head_sha TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS engine_heartbeat (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_tick_at TEXT NOT NULL,
        tick_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_kind ON workflow_runs(kind);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_steps_run_id ON workflow_steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_trigger_ledger_schedule ON trigger_ledger(schedule_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status, id);
      CREATE INDEX IF NOT EXISTS idx_signals_dedupe ON signals(dedupe_key, status);
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
      // catch-up policy for missed fire times ('collapse' default when NULL).
      `ALTER TABLE cron_schedules ADD COLUMN catch_up TEXT`,
      // HEAD sha at dispatch of the last successful run — pre-dispatch change gate anchor.
      `ALTER TABLE cron_schedules ADD COLUMN last_reviewed_sha TEXT`,
      // most recent held (withheld) dispatch: when and why.
      `ALTER TABLE cron_schedules ADD COLUMN last_held_at TEXT`,
      `ALTER TABLE cron_schedules ADD COLUMN last_held_reason TEXT`,
      `ALTER TABLE cron_schedules ADD COLUMN held_count INTEGER`,
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

  /**
   * Create and immediately start executing a workflow run.
   * `dispatch` links the run back to the schedule that fired it (set by the scheduler and
   * `triggerSchedule`) so a successful run can advance the schedule's `lastReviewedSha`.
   * It is registered before execution begins — no window where a fast run could finish
   * without the link in place.
   */
  async startRun(
    kind: string,
    input: Record<string, unknown> = {},
    dispatch?: { scheduleId: string; headSha: string | null },
  ): Promise<WorkflowRun> {
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

    if (dispatch) this.dispatchIndex.set(run.id, dispatch)

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

      // Advance the change-detection anchor only on success — a failed or skipped
      // run must not move it, or its commits would never be re-examined.
      const dispatch = this.dispatchIndex.get(run.id)
      if (dispatch?.headSha) {
        this.db.prepare(`UPDATE cron_schedules SET last_reviewed_sha = ? WHERE id = ?`)
          .run(dispatch.headSha, dispatch.scheduleId)
      }

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
      this.dispatchIndex.delete(run.id)
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

  private rowToSchedule(row: Record<string, unknown>): CronSchedule {
    return {
      id: row.id as string,
      kind: row.kind as string,
      cronExpression: row.cron_expression as string,
      input: jsonParse(row.input as string) as Record<string, unknown>,
      enabled: !!(row.enabled as number),
      lastRunAt: row.last_run_at as string | null,
      nextRunAt: row.next_run_at as string | null,
      catchUp: row.catch_up === 'skip' ? 'skip' : 'collapse',
      lastReviewedSha: (row.last_reviewed_sha as string | null) ?? null,
      lastHeldAt: (row.last_held_at as string | null) ?? null,
      lastHeldReason: (row.last_held_reason as string | null) ?? null,
      heldCount: (row.held_count as number | null) ?? 0,
    }
  }

  /** Create or update a cron schedule. Pre-computes `nextRunAt` from the expression. */
  upsertSchedule(schedule: CronScheduleUpsert): CronSchedule {
    const nextRun = schedule.enabled ? nextCronMatch(schedule.cronExpression, new Date()).toISOString() : null

    const existing = this.db.prepare(`SELECT id FROM cron_schedules WHERE id = ?`).get(schedule.id)
    if (existing) {
      // COALESCE keeps the stored catch-up policy when the caller doesn't specify one,
      // and the trigger bookkeeping columns (last_reviewed_sha, held_*) are never touched here.
      this.db.prepare(`
        UPDATE cron_schedules SET kind = ?, cron_expression = ?, input = ?, enabled = ?, next_run_at = ?, catch_up = COALESCE(?, catch_up)
        WHERE id = ?
      `).run(schedule.kind, schedule.cronExpression, JSON.stringify(schedule.input), schedule.enabled ? 1 : 0, nextRun, schedule.catchUp ?? null, schedule.id)
    } else {
      this.db.prepare(`
        INSERT INTO cron_schedules (id, kind, cron_expression, input, enabled, next_run_at, catch_up)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(schedule.id, schedule.kind, schedule.cronExpression, JSON.stringify(schedule.input), schedule.enabled ? 1 : 0, nextRun, schedule.catchUp ?? null)
    }

    return {
      ...schedule,
      catchUp: schedule.catchUp ?? 'collapse',
      lastRunAt: null,
      nextRunAt: nextRun,
      lastReviewedSha: null,
      lastHeldAt: null,
      lastHeldReason: null,
      heldCount: 0,
    }
  }

  /** Delete a cron schedule by ID. Returns true if a row was deleted. */
  deleteSchedule(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM cron_schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** List all cron schedules (enabled and disabled). */
  listSchedules(): CronSchedule[] {
    return (this.db.prepare(`SELECT * FROM cron_schedules`).all() as Record<string, unknown>[])
      .map(row => this.rowToSchedule(row))
  }

  /** Fetch a single cron schedule by ID. Returns `null` if not found. */
  getSchedule(id: string): CronSchedule | null {
    const row = this.db.prepare(`SELECT * FROM cron_schedules WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.rowToSchedule(row)
  }

  /**
   * Trigger a schedule immediately, creating a new run. Manual triggers bypass the
   * dispatch gates (explicit human intent), but are still recorded in the trigger
   * ledger and still advance `lastReviewedSha` on success.
   */
  async triggerSchedule(id: string): Promise<WorkflowRun> {
    const schedule = this.getSchedule(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    const repoPath = typeof schedule.input.repoPath === 'string' ? schedule.input.repoPath : null
    const headSha = repoPath ? this.headShaResolver(repoPath) : null
    const run = await this.startRun(schedule.kind, schedule.input, { scheduleId: id, headSha })
    this.recordTrigger({ scheduleId: id, kind: schedule.kind, decision: 'fired', reason: 'manual trigger (gates bypassed)', runId: run.id, headSha })
    return run
  }

  // -------------------------------------------------------------------------
  // Trigger dispatch
  // -------------------------------------------------------------------------

  /** Override HEAD-sha resolution (tests). Pass `null` to restore the git default. */
  setHeadShaResolver(resolver: HeadShaResolver | null) {
    this.headShaResolver = resolver ?? defaultHeadShaResolver
  }

  /** Connect the repo activity index to the dispatch gate. Without one, the gate is open. */
  setActivityResolver(resolver: ActivityResolver | null) {
    this.activityResolver = resolver
  }

  private recordTrigger(entry: { scheduleId: string | null; kind: string; decision: 'fired' | 'held'; reason: string; runId?: string | null; headSha?: string | null }) {
    this.db.prepare(`
      INSERT INTO trigger_ledger (schedule_id, kind, decision, reason, run_id, head_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entry.scheduleId, entry.kind, entry.decision, entry.reason, entry.runId ?? null, entry.headSha ?? null, new Date().toISOString())
  }

  /** List trigger-ledger entries, newest first, optionally for one schedule. */
  listTriggerLedger(opts?: { scheduleId?: string; limit?: number }): TriggerLedgerEntry[] {
    const { sql, params } = buildListQuery('trigger_ledger', {
      filters: opts?.scheduleId ? [{ column: 'schedule_id', value: opts.scheduleId }] : [],
      orderBy: 'id DESC',
      limit: opts?.limit ?? 100,
    })
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(row => ({
      id: row.id as number,
      scheduleId: row.schedule_id as string | null,
      kind: row.kind as string,
      decision: row.decision as 'fired' | 'held',
      reason: row.reason as string,
      runId: row.run_id as string | null,
      headSha: row.head_sha as string | null,
      createdAt: row.created_at as string,
    }))
  }

  /** Liveness snapshot of the dispatch loop — `lastTickAt` is written on every tick. */
  getEngineHealth(): EngineHealth {
    const row = this.db.prepare(`SELECT last_tick_at, tick_count FROM engine_heartbeat WHERE id = 1`).get() as Record<string, unknown> | undefined
    return {
      lastTickAt: (row?.last_tick_at as string | null) ?? null,
      tickCount: (row?.tick_count as number | null) ?? 0,
    }
  }

  // -------------------------------------------------------------------------
  // Durable signals (at-least-once)
  // -------------------------------------------------------------------------

  /** Register the consumer for a signal kind. One handler per kind. */
  registerSignalHandler(kind: string, handler: SignalHandler) {
    this.signalHandlers.set(kind, handler)
  }

  /**
   * Register a periodic task driven by the dispatch tick (60s resolution) —
   * the alternative to scattering new `setInterval` loops around the codebase.
   * Runs are non-overlapping (a slow pass skips ticks) and a throwing task is
   * logged, never fatal to the loop. First run happens on the next tick.
   */
  registerTickTask(name: string, intervalMs: number, fn: () => void | Promise<void>) {
    this.tickTasks.set(name, { intervalMs, fn, lastRunAt: 0, running: false })
  }

  /** Remove a registered tick task. An in-flight run finishes; no further runs start. */
  unregisterTickTask(name: string) {
    this.tickTasks.delete(name)
  }

  /**
   * Durably enqueue a signal. With a `dedupeKey`, an already-pending (or
   * in-flight) signal carrying the same key absorbs the enqueue — the caller
   * learns via `deduped` and nothing is inserted.
   */
  enqueueSignal(input: { kind: string; payload?: Record<string, unknown>; dedupeKey?: string; ttlMs?: number }): { id: number; deduped: boolean } {
    if (input.dedupeKey) {
      const existing = this.db.prepare(
        `SELECT id FROM signals WHERE dedupe_key = ? AND status IN ('pending', 'processing')`,
      ).get(input.dedupeKey) as { id: number } | undefined
      if (existing) return { id: existing.id, deduped: true }
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? WorkflowEngine.SIGNAL_DEFAULT_TTL_MS)).toISOString()
    const info = this.db.prepare(`
      INSERT INTO signals (kind, payload, dedupe_key, status, expires_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(input.kind, JSON.stringify(input.payload ?? {}), input.dedupeKey ?? null, expiresAt, now.toISOString())
    return { id: Number(info.lastInsertRowid), deduped: false }
  }

  /** List signals newest-first, optionally by status. */
  listSignals(opts?: { status?: Signal['status']; limit?: number }): Signal[] {
    const { sql, params } = buildListQuery('signals', {
      filters: opts?.status ? [{ column: 'status', value: opts.status }] : [],
      orderBy: 'id DESC',
      limit: opts?.limit ?? 100,
    })
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(row => this.rowToSignal(row))
  }

  private rowToSignal(row: Record<string, unknown>): Signal {
    return {
      id: row.id as number,
      kind: row.kind as string,
      payload: jsonParse(row.payload as string) as Record<string, unknown>,
      dedupeKey: row.dedupe_key as string | null,
      status: row.status as Signal['status'],
      attempts: row.attempts as number,
      createdAt: row.created_at as string,
      processedAt: row.processed_at as string | null,
      error: row.error as string | null,
    }
  }

  /**
   * One consumption pass: expire stale pending signals, fail or reclaim broken
   * leases, then deliver a batch of pending signals to their handlers. Called
   * from `dispatchTick` before schedule dispatch (signals outrank timers).
   */
  private processSignals(now: Date) {
    const nowIso = now.toISOString()

    // Stale pending signals must not fire surprisingly late — expire them.
    const expired = this.db.prepare(
      `UPDATE signals SET status = 'expired', processed_at = ? WHERE status = 'pending' AND expires_at < ?`,
    ).run(nowIso, nowIso)
    if (expired.changes > 0) {
      this.recordTrigger({ scheduleId: null, kind: 'signal', decision: 'held', reason: `${expired.changes} signal(s) expired unprocessed` })
    }

    // Broken leases: exhausted attempts → failed; otherwise back to pending for redelivery.
    const failed = this.db.prepare(
      `UPDATE signals SET status = 'failed', processed_at = ? WHERE status = 'processing' AND lease_expires_at < ? AND attempts >= ?`,
    ).run(nowIso, nowIso, WorkflowEngine.SIGNAL_MAX_ATTEMPTS)
    if (failed.changes > 0) {
      this.recordTrigger({ scheduleId: null, kind: 'signal', decision: 'held', reason: `${failed.changes} signal(s) failed after ${WorkflowEngine.SIGNAL_MAX_ATTEMPTS} attempts` })
    }
    this.db.prepare(
      `UPDATE signals SET status = 'pending', lease_expires_at = NULL WHERE status = 'processing' AND lease_expires_at < ?`,
    ).run(nowIso)

    // Deliver a batch. Signals whose kind has no registered handler stay
    // pending — the consumer may simply not have booted yet; TTL bounds the wait.
    const rows = this.db.prepare(`SELECT * FROM signals WHERE status = 'pending' ORDER BY id LIMIT ?`)
      .all(WorkflowEngine.MAX_SIGNALS_PER_TICK) as Record<string, unknown>[]
    for (const row of rows) {
      const handler = this.signalHandlers.get(row.kind as string)
      if (!handler) continue

      const lease = new Date(now.getTime() + WorkflowEngine.SIGNAL_LEASE_MS).toISOString()
      this.db.prepare(`UPDATE signals SET status = 'processing', attempts = attempts + 1, lease_expires_at = ? WHERE id = ?`)
        .run(lease, row.id)
      const signal = this.rowToSignal({ ...row, attempts: (row.attempts as number) + 1 })

      handler(signal.payload, signal)
        .then(() => {
          // Ack only after the handler resolves — the at-least-once guarantee.
          this.db.prepare(`UPDATE signals SET status = 'done', processed_at = ?, error = NULL WHERE id = ?`)
            .run(new Date().toISOString(), signal.id)
          this.recordTrigger({ scheduleId: null, kind: `signal:${signal.kind}`, decision: 'fired', reason: 'signal processed' })
        })
        .catch((err: unknown) => {
          // Leave the signal leased; lease expiry redelivers it. Record the error for diagnosis.
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[workflow] Signal handler error (${signal.kind} #${signal.id}, attempt ${signal.attempts}):`, msg)
          this.db.prepare(`UPDATE signals SET error = ? WHERE id = ?`).run(msg, signal.id)
        })
    }
  }

  /** Withhold a dispatch: record why, bump held bookkeeping, and set the retry/next time. */
  private holdSchedule(schedule: CronSchedule, reason: string, nextRunAt: string, now: Date) {
    console.log(`[workflow] Cron held: ${schedule.id} (${schedule.kind}) — ${reason}`)
    this.db.prepare(`
      UPDATE cron_schedules SET last_held_at = ?, last_held_reason = ?, held_count = COALESCE(held_count, 0) + 1, next_run_at = ?
      WHERE id = ?
    `).run(now.toISOString(), reason, nextRunAt, schedule.id)
    this.recordTrigger({ scheduleId: schedule.id, kind: schedule.kind, decision: 'held', reason })
  }

  /**
   * One pass of the dispatch loop. Public so tests (and a future signal consumer)
   * can drive it directly; production calls it from the 60s interval.
   */
  dispatchTick(now: Date = new Date()) {
    // Heartbeat first — proves the loop is alive even on ticks where nothing is due.
    this.db.prepare(`
      INSERT INTO engine_heartbeat (id, last_tick_at, tick_count) VALUES (1, ?, 1)
      ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at, tick_count = tick_count + 1
    `).run(now.toISOString())

    // Signals outrank timers: an event that already happened beats a wall-clock guess.
    this.processSignals(now)

    const due = this.listSchedules()
      .filter(s => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))

    let dispatched = 0
    for (const schedule of due) {
      // Backlog stagger: anything beyond the cap stays due and is picked up next tick.
      if (dispatched >= WorkflowEngine.MAX_DISPATCH_PER_TICK) break
      if (this.evaluateAndDispatch(schedule, now)) dispatched++
    }

    // Registered periodic tasks ride the same tick and heartbeat.
    for (const [name, task] of this.tickTasks) {
      if (task.running || now.getTime() - task.lastRunAt < task.intervalMs) continue
      task.lastRunAt = now.getTime()
      task.running = true
      Promise.resolve()
        .then(task.fn)
        .catch((err: unknown) => console.error(`[workflow] Tick task '${name}' failed:`, err))
        .finally(() => { task.running = false })
    }
  }

  /** Run one due schedule through the gates. Returns true if a run was dispatched. */
  private evaluateAndDispatch(schedule: CronSchedule, now: Date): boolean {
    const nextSlot = () => nextCronMatch(schedule.cronExpression, now).toISOString()
    const repoPath = typeof schedule.input.repoPath === 'string' ? schedule.input.repoPath : null

    if (
      schedule.catchUp === 'skip' &&
      now.getTime() - new Date(schedule.nextRunAt!).getTime() > WorkflowEngine.CATCH_UP_GRACE_MS
    ) {
      this.holdSchedule(schedule, 'missed fire window (catch-up: skip)', nextSlot(), now)
      return false
    }

    // Activity gate: dormant repos hold until they wake; cooling repos are
    // throttled to a weekly rhythm. Unknown activity (no resolver, resolver
    // error) fails open — a broken index must never silence workflows.
    if (repoPath && this.activityResolver) {
      let activity: { tier: 'active' | 'cooling' | 'dormant' } | null = null
      try {
        activity = this.activityResolver(repoPath)
      } catch (err) {
        console.error(`[workflow] Activity resolver error for ${repoPath}:`, err)
      }
      if (activity?.tier === 'dormant') {
        this.holdSchedule(schedule, 'repo dormant — held until activity resumes', nextSlot(), now)
        return false
      }
      if (
        activity?.tier === 'cooling' &&
        schedule.lastRunAt &&
        now.getTime() - new Date(schedule.lastRunAt).getTime() < WorkflowEngine.COOLING_MIN_INTERVAL_MS
      ) {
        this.holdSchedule(schedule, 'repo cooling — throttled to weekly cadence', nextSlot(), now)
        return false
      }
    }

    // Single-flight per repo+kind: never stack a second run on one still going.
    if (repoPath) {
      const active = [
        ...this.listRuns({ kind: schedule.kind, status: 'running', limit: 100 }),
        ...this.listRuns({ kind: schedule.kind, status: 'queued', limit: 100 }),
      ]
      if (active.some(r => r.input.repoPath === repoPath)) {
        const retryAt = new Date(now.getTime() + WorkflowEngine.CONCURRENCY_RETRY_MS).toISOString()
        this.holdSchedule(schedule, 'previous run still active', retryAt, now)
        return false
      }
    }

    // Change gate: HEAD unchanged since the last successful run → nothing to review.
    // A null sha (missing repo, git error) falls through to dispatch so the failure
    // surfaces loudly in the run history instead of being silently held.
    const headSha = repoPath ? this.headShaResolver(repoPath) : null
    if (headSha && schedule.lastReviewedSha === headSha) {
      this.holdSchedule(schedule, 'no new commits since last successful run', nextSlot(), now)
      return false
    }

    console.log(`[workflow] Cron triggered: ${schedule.id} (${schedule.kind})`)
    this.db.prepare(`UPDATE cron_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
      .run(now.toISOString(), nextSlot(), schedule.id)

    // Pass last run timestamp so the in-run validate_repo check keeps working as a
    // belt-and-suspenders behind the sha gate.
    const runInput = schedule.lastRunAt
      ? { ...schedule.input, sinceTimestamp: schedule.lastRunAt }
      : schedule.input
    this.startRun(schedule.kind, runInput, { scheduleId: schedule.id, headSha })
      .then(run => {
        this.recordTrigger({ scheduleId: schedule.id, kind: schedule.kind, decision: 'fired', reason: 'schedule due', runId: run.id, headSha })
      })
      .catch(err => {
        console.error(`[workflow] Cron trigger failed for ${schedule.id}:`, err)
      })
    return true
  }

  /** Start the cron polling loop (checks every 60s). */
  startCronScheduler() {
    if (this.cronTimer) return
    console.log('[workflow] Cron scheduler started')

    // Prune old ledger rows and settled signals once per process start, not per tick.
    const cutoff = new Date(Date.now() - WorkflowEngine.LEDGER_RETENTION_MS).toISOString()
    this.db.prepare(`DELETE FROM trigger_ledger WHERE created_at < ?`).run(cutoff)
    this.db.prepare(`DELETE FROM signals WHERE status IN ('done', 'expired', 'failed') AND created_at < ?`).run(cutoff)

    const tick = () => {
      try {
        this.dispatchTick()
      } catch (err) {
        // The loop must survive any single bad tick (corrupt row, git hiccup) —
        // a dead interval is invisible; a logged error is not.
        console.error('[workflow] Dispatch tick failed:', err)
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
