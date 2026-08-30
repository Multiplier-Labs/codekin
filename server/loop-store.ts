/**
 * Persistence for Loops 2.0 — the durable, event-sourced run database.
 *
 * A loop run is an outcome-driven agent loop executed as durable stages.
 * Unlike the v1 goal-run ledger (one row per turn, output tails), state here
 * is event-sourced: every transition is an append-only `loop_events` row with
 * a per-run monotonic sequence, and `loop_checkpoints` snapshots the
 * orchestration state so a killed server resumes instead of failing runs.
 *
 * Tables (all in the shared ~/.codekin/runs.db):
 *   loop_runs          — one row per run: frozen recipe + hash, resolved
 *                        provider, execution state, separate outcome
 *   loop_stages        — durable stage rows (preflight/act/evaluate/review/finalize)
 *   loop_attempts      — one row per execution of a stage
 *   loop_events        — append-only event log, monotonic sequence per run
 *   loop_checkpoints   — serialized orchestration state + event-sequence cursor
 *   loop_evaluations   — structured evaluator results with evidence pointers
 *   loop_artifacts     — artifact metadata (bodies live in LoopArtifactStore)
 *   loop_interventions — pending/resolved human decisions
 *
 * Execution state and outcome are stored separately: `state` says what the
 * run is doing (`done` when nothing further will happen), `outcome` says how
 * it ended. "Blocked" is a `stateReason` on a wait state, not a status.
 *
 * Mirrors storage conventions of the other stores: better-sqlite3, WAL,
 * 0o600, JSON-as-TEXT, ':memory:' for tests.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'
import type { LoopProvider, LoopRecipe } from './loop-recipe.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Execution state. Active states may transition; `done` is final (see
 * `outcome` for how it ended). `awaiting_approval` and `paused` are resumable
 * wait states — a restart must never fail them.
 */
export type LoopRunState =
  | 'created'            // row exists, nothing started
  | 'preflight'          // validating repo/branch/recipe before spending
  | 'planning'           // maker is producing the plan artifact (no file edits yet)
  | 'executing'          // maker session is working
  | 'evaluating'         // evaluators are running
  | 'reviewing'          // rubric reviewer is running
  | 'awaiting_approval'  // waiting on a human decision (see stateReason + intervention)
  | 'pausing'            // pause requested, reaching a safe boundary
  | 'paused'             // durably parked; resume continues from checkpoint
  | 'canceling'          // cancel requested, tearing down
  | 'finalizing'         // landing the verified tree (commit/push/PR)
  | 'monitoring_ci'      // waiting on remote CI checks at the pushed PR
  | 'recovering'         // reconciling after a restart
  | 'done'

export type LoopRunOutcome = 'completed' | 'completed_with_warnings' | 'failed' | 'canceled'

export type LoopStageKind = 'preflight' | 'plan' | 'act' | 'evaluate' | 'review' | 'finalize' | 'ci'
export type LoopStageStatus = 'running' | 'succeeded' | 'failed' | 'canceled'

export type LoopActorType = 'user' | 'system' | 'agent'

export type EvaluationStatus = 'pass' | 'fail' | 'warning' | 'error' | 'waived'
export type FailureClassification = 'code' | 'test' | 'environment' | 'policy' | 'ambiguous'

export type InterventionKind = 'approval' | 'question'
export type InterventionStatus = 'pending' | 'resolved' | 'canceled'

export interface LoopRun {
  id: string
  recipeId: string
  recipeHash: string
  /** The recipe frozen at run start — later file edits never change what ran. */
  recipe: LoopRecipe
  /** The outcome prompt this run pursues (recipe default or caller override). */
  goal: string
  repo: string
  branch: string
  /** Branch the worktree was created from (repo default when null). */
  baseBranch: string | null
  baseSha: string | null
  /** Resolved provider — `auto` never survives into a run row. */
  provider: LoopProvider
  model: string | null
  state: LoopRunState
  /** Human-readable reason for a wait/terminal state ("waiting for approval to …"). */
  stateReason: string | null
  outcome: LoopRunOutcome | null
  makerSessionId: string | null
  worktreePath: string | null
  turnCount: number
  costUsd: number
  prUrl: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface CreateLoopRunInput {
  recipe: LoopRecipe
  goal: string
  repo: string
  branch: string
  baseBranch?: string | null
  provider: LoopProvider
  model?: string | null
  id?: string
}

export interface LoopRunPatch {
  baseSha?: string | null
  state?: LoopRunState
  stateReason?: string | null
  outcome?: LoopRunOutcome | null
  makerSessionId?: string | null
  worktreePath?: string | null
  turnCount?: number
  costUsd?: number
  prUrl?: string | null
  startedAt?: string | null
  completedAt?: string | null
}

export interface LoopStage {
  id: string
  runId: string
  stageIndex: number
  kind: LoopStageKind
  status: LoopStageStatus
  startedAt: string
  completedAt: string | null
}

export interface LoopAttempt {
  id: string
  stageId: string
  runId: string
  attemptIndex: number
  status: LoopStageStatus
  error: string | null
  startedAt: string
  completedAt: string | null
}

export interface LoopEvent<T = unknown> {
  runId: string
  sequence: number
  type: string
  at: string
  actor: { type: LoopActorType; id?: string }
  stageId?: string
  attemptId?: string
  payload: T
}

export interface AppendEventInput {
  runId: string
  type: string
  actor?: { type: LoopActorType; id?: string }
  stageId?: string
  attemptId?: string
  payload?: unknown
}

export interface LoopCheckpoint {
  id: string
  runId: string
  /** Event sequence at save time — the replay cursor. */
  sequence: number
  state: unknown
  createdAt: string
}

export interface LoopEvaluation {
  id: string
  runId: string
  stageId: string
  evaluatorId: string
  status: EvaluationStatus
  classification: FailureClassification | null
  summary: string
  /** Stable identity of the failure (e.g. hash of failing command + tail) for no-progress detection. */
  fingerprint: string | null
  retryable: boolean
  durationMs: number
  costUsd: number | null
  evidenceArtifactIds: string[]
  createdAt: string
}

export interface LoopArtifact {
  id: string
  runId: string
  kind: string
  label: string
  contentHash: string
  sizeBytes: number
  createdAt: string
}

export interface LoopIntervention {
  id: string
  runId: string
  kind: InterventionKind
  /** Machine-routable purpose — how the engine handles the resolution. */
  purpose: string
  status: InterventionStatus
  /** One-sentence decision needed. */
  title: string
  body: string | null
  /** Allowed responses, e.g. ["approve", "reject"]. */
  options: string[]
  resolution: { choice: string; note?: string } | null
  createdAt: string
  resolvedAt: string | null
}

export interface ListLoopRunsOptions {
  state?: LoopRunState
  activeOnly?: boolean
  repo?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RunRow {
  id: string
  recipe_id: string
  recipe_hash: string
  recipe: string
  goal: string
  repo: string
  branch: string
  base_branch: string | null
  base_sha: string | null
  provider: string
  model: string | null
  state: string
  state_reason: string | null
  outcome: string | null
  maker_session_id: string | null
  worktree_path: string | null
  turn_count: number
  cost_usd: number
  pr_url: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

interface EventRow {
  run_id: string
  sequence: number
  type: string
  at: string
  actor_type: string
  actor_id: string | null
  stage_id: string | null
  attempt_id: string | null
  payload: string
}

const RUN_PATCH_COLUMNS: Record<keyof LoopRunPatch, string> = {
  baseSha: 'base_sha',
  state: 'state',
  stateReason: 'state_reason',
  outcome: 'outcome',
  makerSessionId: 'maker_session_id',
  worktreePath: 'worktree_path',
  turnCount: 'turn_count',
  costUsd: 'cost_usd',
  prUrl: 'pr_url',
  startedAt: 'started_at',
  completedAt: 'completed_at',
}

// ---------------------------------------------------------------------------
// LoopStore
// ---------------------------------------------------------------------------

export class LoopStore {
  private db: Database.Database
  private eventListener: ((event: LoopEvent) => void) | null = null

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.createTables()
    // Loops 2.0 replaces v1 outright (docs/LOOPS-REWRITE-SPEC.md §12): the v1
    // tables had no users and no history worth preserving — drop them so the
    // schema never carries dead weight.
    this.db.exec(`DROP TABLE IF EXISTS goal_runs; DROP TABLE IF EXISTS goal_run_turns;`)
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id               TEXT PRIMARY KEY,
        recipe_id        TEXT NOT NULL,
        recipe_hash      TEXT NOT NULL,
        recipe           TEXT NOT NULL,
        goal             TEXT NOT NULL,
        repo             TEXT NOT NULL,
        branch           TEXT NOT NULL,
        base_branch      TEXT,
        base_sha         TEXT,
        provider         TEXT NOT NULL,
        model            TEXT,
        state            TEXT NOT NULL DEFAULT 'created',
        state_reason     TEXT,
        outcome          TEXT,
        maker_session_id TEXT,
        worktree_path    TEXT,
        turn_count       INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL NOT NULL DEFAULT 0,
        pr_url           TEXT,
        created_at       TEXT NOT NULL,
        started_at       TEXT,
        completed_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS loop_stages (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES loop_runs(id),
        stage_index  INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS loop_attempts (
        id            TEXT PRIMARY KEY,
        stage_id      TEXT NOT NULL REFERENCES loop_stages(id),
        run_id        TEXT NOT NULL REFERENCES loop_runs(id),
        attempt_index INTEGER NOT NULL,
        status        TEXT NOT NULL,
        error         TEXT,
        started_at    TEXT NOT NULL,
        completed_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS loop_events (
        run_id     TEXT NOT NULL REFERENCES loop_runs(id),
        sequence   INTEGER NOT NULL,
        type       TEXT NOT NULL,
        at         TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id   TEXT,
        stage_id   TEXT,
        attempt_id TEXT,
        payload    TEXT NOT NULL DEFAULT 'null',
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS loop_checkpoints (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES loop_runs(id),
        sequence   INTEGER NOT NULL,
        state      TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_evaluations (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES loop_runs(id),
        stage_id     TEXT NOT NULL REFERENCES loop_stages(id),
        evaluator_id TEXT NOT NULL,
        status       TEXT NOT NULL,
        classification TEXT,
        summary      TEXT NOT NULL,
        fingerprint  TEXT,
        retryable    INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL,
        evidence     TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_artifacts (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES loop_runs(id),
        kind         TEXT NOT NULL,
        label        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_interventions (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES loop_runs(id),
        kind        TEXT NOT NULL,
        purpose     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        title       TEXT NOT NULL,
        body        TEXT,
        options     TEXT NOT NULL DEFAULT '[]',
        resolution  TEXT,
        created_at  TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_loop_runs_state ON loop_runs(state);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_repo ON loop_runs(repo);
      CREATE INDEX IF NOT EXISTS idx_loop_stages_run ON loop_stages(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_attempts_run ON loop_attempts(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_run ON loop_checkpoints(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_evaluations_run ON loop_evaluations(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_artifacts_run ON loop_artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_interventions_run ON loop_interventions(run_id, status);
    `)
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  createRun(input: CreateLoopRunInput): LoopRun {
    const id = input.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO loop_runs (id, recipe_id, recipe_hash, recipe, goal, repo, branch, base_branch, provider, model, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
      )
      .run(
        id,
        input.recipe.id,
        input.recipe.contentHash,
        JSON.stringify(input.recipe),
        input.goal,
        input.repo,
        input.branch,
        input.baseBranch ?? null,
        input.provider,
        input.model ?? null,
        new Date().toISOString(),
      )
    const run = this.getRun(id)
    if (!run) throw new Error(`loop run ${id} vanished immediately after insert`)
    return run
  }

  getRun(id: string): LoopRun | null {
    const row = this.db.prepare(`SELECT * FROM loop_runs WHERE id = ?`).get(id) as RunRow | undefined
    return row ? mapRun(row) : null
  }

  listRuns(opts: ListLoopRunsOptions = {}): LoopRun[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts.state) {
      clauses.push('state = ?')
      params.push(opts.state)
    }
    if (opts.activeOnly) clauses.push(`state != 'done'`)
    if (opts.repo) {
      clauses.push('repo = ?')
      params.push(opts.repo)
    }
    let sql = `SELECT * FROM loop_runs`
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ` ORDER BY created_at DESC, rowid DESC`
    if (opts.limit) {
      sql += ` LIMIT ?`
      params.push(opts.limit)
    }
    return (this.db.prepare(sql).all(...params) as RunRow[]).map(mapRun)
  }

  patchRun(id: string, patch: LoopRunPatch): void {
    const sets: string[] = []
    const params: unknown[] = []
    for (const key of Object.keys(patch) as (keyof LoopRunPatch)[]) {
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${RUN_PATCH_COLUMNS[key]} = ?`)
      params.push(value)
    }
    if (!sets.length) return
    params.push(id)
    this.db.prepare(`UPDATE loop_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  // -------------------------------------------------------------------------
  // Stages & attempts
  // -------------------------------------------------------------------------

  createStage(runId: string, kind: LoopStageKind): LoopStage {
    const id = randomUUID()
    const next = this.db.prepare(`SELECT COALESCE(MAX(stage_index), -1) + 1 AS i FROM loop_stages WHERE run_id = ?`).get(runId) as {
      i: number
    }
    const startedAt = new Date().toISOString()
    this.db
      .prepare(`INSERT INTO loop_stages (id, run_id, stage_index, kind, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(id, runId, next.i, kind, startedAt)
    return { id, runId, stageIndex: next.i, kind, status: 'running', startedAt, completedAt: null }
  }

  completeStage(stageId: string, status: Exclude<LoopStageStatus, 'running'>): void {
    this.db.prepare(`UPDATE loop_stages SET status = ?, completed_at = ? WHERE id = ?`).run(status, new Date().toISOString(), stageId)
  }

  listStages(runId: string): LoopStage[] {
    return (
      this.db.prepare(`SELECT * FROM loop_stages WHERE run_id = ? ORDER BY stage_index ASC`).all(runId) as Array<{
        id: string
        run_id: string
        stage_index: number
        kind: string
        status: string
        started_at: string
        completed_at: string | null
      }>
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      stageIndex: r.stage_index,
      kind: r.kind as LoopStageKind,
      status: r.status as LoopStageStatus,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }))
  }

  createAttempt(stageId: string, runId: string): LoopAttempt {
    const id = randomUUID()
    const next = this.db.prepare(`SELECT COALESCE(MAX(attempt_index), -1) + 1 AS i FROM loop_attempts WHERE stage_id = ?`).get(stageId) as {
      i: number
    }
    const startedAt = new Date().toISOString()
    this.db
      .prepare(`INSERT INTO loop_attempts (id, stage_id, run_id, attempt_index, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(id, stageId, runId, next.i, startedAt)
    return { id, stageId, runId, attemptIndex: next.i, status: 'running', error: null, startedAt, completedAt: null }
  }

  completeAttempt(attemptId: string, status: Exclude<LoopStageStatus, 'running'>, error?: string): void {
    this.db
      .prepare(`UPDATE loop_attempts SET status = ?, error = ?, completed_at = ? WHERE id = ?`)
      .run(status, error ?? null, new Date().toISOString(), attemptId)
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Register the (single) listener for appended events — the WS/notification
   * bridge. Listener errors are caught and logged, never propagated into the
   * append.
   */
  setEventListener(listener: (event: LoopEvent) => void): void {
    this.eventListener = listener
  }

  /** Append an event with the next per-run sequence and notify the listener. */
  appendEvent(input: AppendEventInput): LoopEvent {
    const actor = input.actor ?? { type: 'system' as const }
    const event = this.db.transaction((): LoopEvent => {
      const next = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM loop_events WHERE run_id = ?`).get(input.runId) as {
        seq: number
      }
      const at = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO loop_events (run_id, sequence, type, at, actor_type, actor_id, stage_id, attempt_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          next.seq,
          input.type,
          at,
          actor.type,
          actor.id ?? null,
          input.stageId ?? null,
          input.attemptId ?? null,
          JSON.stringify(input.payload ?? null),
        )
      return {
        runId: input.runId,
        sequence: next.seq,
        type: input.type,
        at,
        actor,
        stageId: input.stageId,
        attemptId: input.attemptId,
        payload: input.payload ?? null,
      }
    })()
    if (this.eventListener) {
      try {
        this.eventListener(event)
      } catch (err) {
        console.error('[loop-store] Event listener threw:', err)
      }
    }
    return event
  }

  /** Events after a sequence cursor (0 = from the beginning), oldest first. */
  listEvents(runId: string, afterSequence = 0, limit = 500): LoopEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM loop_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
        .all(runId, afterSequence, limit) as EventRow[]
    ).map(mapEvent)
  }

  lastSequence(runId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM loop_events WHERE run_id = ?`).get(runId) as { seq: number }
    return row.seq
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  saveCheckpoint(runId: string, state: unknown): LoopCheckpoint {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const sequence = this.lastSequence(runId)
    this.db
      .prepare(`INSERT INTO loop_checkpoints (id, run_id, sequence, state, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, runId, sequence, JSON.stringify(state), createdAt)
    return { id, runId, sequence, state, createdAt }
  }

  latestCheckpoint(runId: string): LoopCheckpoint | null {
    const row = this.db
      .prepare(`SELECT * FROM loop_checkpoints WHERE run_id = ? ORDER BY sequence DESC, created_at DESC LIMIT 1`)
      .get(runId) as { id: string; run_id: string; sequence: number; state: string; created_at: string } | undefined
    if (!row) return null
    return { id: row.id, runId: row.run_id, sequence: row.sequence, state: jsonParse(row.state), createdAt: row.created_at }
  }

  // -------------------------------------------------------------------------
  // Evaluations
  // -------------------------------------------------------------------------

  addEvaluation(input: Omit<LoopEvaluation, 'id' | 'createdAt'>): LoopEvaluation {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO loop_evaluations
         (id, run_id, stage_id, evaluator_id, status, classification, summary, fingerprint, retryable, duration_ms, cost_usd, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.stageId,
        input.evaluatorId,
        input.status,
        input.classification,
        input.summary,
        input.fingerprint,
        input.retryable ? 1 : 0,
        input.durationMs,
        input.costUsd,
        JSON.stringify(input.evidenceArtifactIds),
        createdAt,
      )
    return { ...input, id, createdAt }
  }

  listEvaluations(runId: string): LoopEvaluation[] {
    return (
      this.db.prepare(`SELECT * FROM loop_evaluations WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId) as Array<{
        id: string
        run_id: string
        stage_id: string
        evaluator_id: string
        status: string
        classification: string | null
        summary: string
        fingerprint: string | null
        retryable: number
        duration_ms: number
        cost_usd: number | null
        evidence: string
        created_at: string
      }>
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      stageId: r.stage_id,
      evaluatorId: r.evaluator_id,
      status: r.status as EvaluationStatus,
      classification: r.classification as FailureClassification | null,
      summary: r.summary,
      fingerprint: r.fingerprint,
      retryable: r.retryable === 1,
      durationMs: r.duration_ms,
      costUsd: r.cost_usd,
      evidenceArtifactIds: (jsonParse(r.evidence) as string[]) ?? [],
      createdAt: r.created_at,
    }))
  }

  // -------------------------------------------------------------------------
  // Artifacts (metadata — bodies live in LoopArtifactStore)
  // -------------------------------------------------------------------------

  addArtifact(input: Omit<LoopArtifact, 'id' | 'createdAt'>): LoopArtifact {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(`INSERT INTO loop_artifacts (id, run_id, kind, label, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.runId, input.kind, input.label, input.contentHash, input.sizeBytes, createdAt)
    return { ...input, id, createdAt }
  }

  getArtifact(id: string): LoopArtifact | null {
    const row = this.db.prepare(`SELECT * FROM loop_artifacts WHERE id = ?`).get(id) as
      | { id: string; run_id: string; kind: string; label: string; content_hash: string; size_bytes: number; created_at: string }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      label: row.label,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    }
  }

  listArtifacts(runId: string): LoopArtifact[] {
    return (
      this.db.prepare(`SELECT * FROM loop_artifacts WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId) as Array<{
        id: string
        run_id: string
        kind: string
        label: string
        content_hash: string
        size_bytes: number
        created_at: string
      }>
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      label: r.label,
      contentHash: r.content_hash,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    }))
  }

  // -------------------------------------------------------------------------
  // Interventions
  // -------------------------------------------------------------------------

  createIntervention(input: {
    runId: string
    kind: InterventionKind
    purpose: string
    title: string
    body?: string
    options: string[]
  }): LoopIntervention {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO loop_interventions (id, run_id, kind, purpose, status, title, body, options, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, input.runId, input.kind, input.purpose, input.title, input.body ?? null, JSON.stringify(input.options), createdAt)
    return {
      id,
      runId: input.runId,
      kind: input.kind,
      purpose: input.purpose,
      status: 'pending',
      title: input.title,
      body: input.body ?? null,
      options: input.options,
      resolution: null,
      createdAt,
      resolvedAt: null,
    }
  }

  getIntervention(id: string): LoopIntervention | null {
    const row = this.db.prepare(`SELECT * FROM loop_interventions WHERE id = ?`).get(id) as InterventionRow | undefined
    return row ? mapIntervention(row) : null
  }

  /**
   * Resolve a pending intervention. Returns the resolved row, or null when it
   * does not exist or was already resolved (the update is guarded so two
   * racing resolutions cannot both win).
   */
  resolveIntervention(id: string, resolution: { choice: string; note?: string }): LoopIntervention | null {
    const result = this.db
      .prepare(`UPDATE loop_interventions SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(JSON.stringify(resolution), new Date().toISOString(), id)
    if (result.changes === 0) return null
    return this.getIntervention(id)
  }

  /** Cancel all pending interventions for a run (e.g. the run was canceled). */
  cancelPendingInterventions(runId: string): void {
    this.db
      .prepare(`UPDATE loop_interventions SET status = 'canceled', resolved_at = ? WHERE run_id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), runId)
  }

  listInterventions(runId: string, status?: InterventionStatus): LoopIntervention[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM loop_interventions WHERE run_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC`)
          .all(runId, status) as InterventionRow[])
      : (this.db.prepare(`SELECT * FROM loop_interventions WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId) as InterventionRow[])
    return rows.map(mapIntervention)
  }

  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface InterventionRow {
  id: string
  run_id: string
  kind: string
  purpose: string
  status: string
  title: string
  body: string | null
  options: string
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

function mapRun(row: RunRow): LoopRun {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    recipeHash: row.recipe_hash,
    recipe: jsonParse(row.recipe) as LoopRecipe,
    goal: row.goal,
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    provider: row.provider as LoopProvider,
    model: row.model,
    state: row.state as LoopRunState,
    stateReason: row.state_reason,
    outcome: row.outcome as LoopRunOutcome | null,
    makerSessionId: row.maker_session_id,
    worktreePath: row.worktree_path,
    turnCount: row.turn_count,
    costUsd: row.cost_usd,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function mapEvent(row: EventRow): LoopEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    at: row.at,
    actor: { type: row.actor_type as LoopActorType, ...(row.actor_id ? { id: row.actor_id } : {}) },
    ...(row.stage_id ? { stageId: row.stage_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    payload: jsonParse(row.payload),
  }
}

function mapIntervention(row: InterventionRow): LoopIntervention {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as InterventionKind,
    purpose: row.purpose,
    status: row.status as InterventionStatus,
    title: row.title,
    body: row.body,
    options: (jsonParse(row.options) as string[]) ?? [],
    resolution: row.resolution ? (jsonParse(row.resolution) as { choice: string; note?: string }) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}
