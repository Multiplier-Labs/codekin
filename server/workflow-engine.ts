/**
 * Lightweight workflow engine with SQLite persistence and cron scheduling.
 *
 * Provides step-based workflow execution, run tracking, event emission,
 * and cron-based scheduling — all backed by a single SQLite database.
 * Built inline to avoid external workflow library dependencies.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped'

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
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface WorkflowRun {
  id: string
  kind: string
  status: RunStatus
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface WorkflowStep {
  id: string
  runId: string
  key: string
  status: StepStatus
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface CronSchedule {
  id: string
  kind: string
  cronExpression: string
  input: Record<string, unknown>
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
}

export interface WorkflowEvent {
  eventType: string
  runId: string
  kind: string
  stepKey?: string
  status?: string
  payload?: unknown
  timestamp: string
}

/** Step handler function — receives step input + run context, returns step output. */
export type StepHandler = (
  input: Record<string, unknown>,
  context: { runId: string; run: WorkflowRun; abortSignal: AbortSignal }
) => Promise<Record<string, unknown>>

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

function cronMatchesDate(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false

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

/** Build a parameterized SELECT query from typed filter objects. */
function buildListQuery(table: string, opts: ListQueryOpts): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  let sql = `SELECT * FROM ${table} WHERE 1=1`

  for (const f of opts.filters) {
    sql += ` AND ${f.column} = ?`
    params.push(f.value)
  }

  if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}`
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

  constructor(dbPath?: string) {
    super()
    const dir = join(homedir(), '.codekin')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const resolvedPath = dbPath ?? join(dir, 'workflows.db')
    this.db = new Database(resolvedPath, { fileMustExist: false })
    this.db.pragma('journal_mode = WAL')
    this.createTables()
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

  // -------------------------------------------------------------------------
  // Workflow registration
  // -------------------------------------------------------------------------

  registerWorkflow(definition: WorkflowDefinition) {
    this.workflows.set(definition.kind, definition)
    console.log(`[workflow] Registered workflow: ${definition.kind} (${definition.steps.length} steps)`)
  }

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
   */
  private async executeRun(run: WorkflowRun, definition: WorkflowDefinition) {
    const abortController = new AbortController()
    this.activeAbortControllers.set(run.id, abortController)

    // Mark running
    run.status = 'running'
    run.startedAt = new Date().toISOString()
    this.db.prepare(`UPDATE workflow_runs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(run.startedAt, run.id)
    this.emitEvent('run_started', run)

    let lastOutput: Record<string, unknown> = { ...run.input }

    try {
      for (const stepDef of definition.steps) {
        if (abortController.signal.aborted) {
          throw new Error('Run canceled')
        }

        const stepRow = this.db.prepare(`SELECT id FROM workflow_steps WHERE run_id = ? AND key = ?`)
          .get(run.id, stepDef.key) as { id: string } | undefined
        if (!stepRow) continue

        // Mark step running
        const stepStarted = new Date().toISOString()
        this.db.prepare(`UPDATE workflow_steps SET status = 'running', input = ?, started_at = ? WHERE id = ?`)
          .run(JSON.stringify(lastOutput), stepStarted, stepRow.id)
        this.emitEvent('step_started', run, stepDef.key)

        try {
          const result = await stepDef.handler(lastOutput, {
            runId: run.id,
            run,
            abortSignal: abortController.signal,
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

  cancelRun(runId: string): boolean {
    const controller = this.activeAbortControllers.get(runId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getRun(runId: string): (WorkflowRun & { steps: WorkflowStep[] }) | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(runId) as Record<string, string> | undefined
    if (!row) return null

    const steps = (this.db.prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY rowid`).all(runId) as Record<string, string>[])
      .map(s => ({
        id: s.id,
        runId: s.run_id,
        key: s.key,
        status: s.status as StepStatus,
        input: s.input ? JSON.parse(s.input) : null,
        output: s.output ? JSON.parse(s.output) : null,
        error: s.error,
        startedAt: s.started_at,
        completedAt: s.completed_at,
      }))

    return {
      id: row.id,
      kind: row.kind,
      status: row.status as RunStatus,
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      steps,
    }
  }

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
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }))
  }

  // -------------------------------------------------------------------------
  // Cron scheduling
  // -------------------------------------------------------------------------

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

  deleteSchedule(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM cron_schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  listSchedules(): CronSchedule[] {
    return (this.db.prepare(`SELECT * FROM cron_schedules`).all() as Record<string, unknown>[]).map(row => ({
      id: row.id as string,
      kind: row.kind as string,
      cronExpression: row.cron_expression as string,
      input: JSON.parse(row.input as string),
      enabled: !!(row.enabled as number),
      lastRunAt: row.last_run_at as string | null,
      nextRunAt: row.next_run_at as string | null,
    }))
  }

  getSchedule(id: string): CronSchedule | null {
    const row = this.db.prepare(`SELECT * FROM cron_schedules WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string,
      kind: row.kind as string,
      cronExpression: row.cron_expression as string,
      input: JSON.parse(row.input as string),
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
   * Mark any runs that were in-flight when the server last shut down as failed.
   * Called once at startup — a run left in 'running' state means the Node process
   * died mid-execution and the AbortController / step callbacks are gone, so there
   * is no safe way to resume; failing fast is cleaner than leaving them stuck.
   */
  async resumeInterrupted() {
    const interrupted = this.db.prepare(`SELECT id FROM workflow_runs WHERE status = 'running'`).all() as { id: string }[]
    if (interrupted.length === 0) return

    console.log(`[workflow] Found ${interrupted.length} interrupted run(s), marking as failed`)
    for (const { id } of interrupted) {
      this.db.prepare(`UPDATE workflow_runs SET status = 'failed', error = 'Server restarted during execution', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id)
      this.db.prepare(`UPDATE workflow_steps SET status = 'skipped' WHERE run_id = ? AND status IN ('pending', 'running')`)
        .run(id)
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

export function initWorkflowEngine(): WorkflowEngine {
  if (engineInstance) return engineInstance
  engineInstance = new WorkflowEngine()
  console.log('[workflow] Stepflow engine initialized')
  return engineInstance
}

export function getWorkflowEngine(): WorkflowEngine {
  if (!engineInstance) throw new Error('Workflow engine not initialized — call initWorkflowEngine() first')
  return engineInstance
}

export function shutdownWorkflowEngine() {
  if (engineInstance) {
    engineInstance.shutdown()
    engineInstance = null
  }
}
