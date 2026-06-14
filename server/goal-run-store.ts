/**
 * Persistence for Goal Runs — durable, auditable loops attached to a repo.
 *
 * A Goal Run wraps a coding session in an act → verify → continue/stop loop with
 * explicit turn/cost budgets, file constraints, and (in maker–checker mode) a
 * second-provider review pass. This store owns two tables:
 *
 *   goal_runs       — one row per loop execution (goal, spec, budgets, status).
 *   goal_run_turns  — the evidence ledger: one row per maker/checker/verifier
 *                     action, capturing the diff, the verify command + exit code,
 *                     the output tail, and any checker verdict. This is what makes
 *                     a run replayable and auditable.
 *
 * Mirrors the WorkflowEngine storage conventions (better-sqlite3, WAL journal,
 * 0o600 perms, JSON-as-TEXT for structured columns, ':memory:' for tests).
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalRunKind = 'ci-autorepair' | 'coverage-increase' | 'dependency-upgrade'

/**
 * Lifecycle status of a goal run.
 * - `queued`         — created, maker session not yet started
 * - `running`        — maker is working a turn
 * - `verifying`      — deterministic verify commands are executing
 * - `checking`       — second-provider checker is reviewing the diff
 * - `awaiting_human` — escalated to a human checkpoint (budget, constraint, or escalate verdict)
 * - `succeeded`      — verified green, constraints satisfied, completion policy met
 * - `failed`         — budget exhausted or unrecoverable error
 * - `aborted`        — cancelled by the user
 */
export type GoalRunStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'checking'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'aborted'

export type CompletionPolicy = 'pr' | 'merge' | 'commit-only'

export type TurnRole = 'maker' | 'checker' | 'verifier'

export type CheckerVerdict = 'approve' | 'request_changes' | 'escalate'

export type LoopProvider = 'claude' | 'opencode' | 'codex'

export interface ProviderRole {
  provider: LoopProvider
  model?: string
}

/**
 * The parsed loop recipe (from a `.codekin/loops/*.md` template or an API call).
 * Stored as JSON text in goal_runs.spec.
 */
export interface GoalRunSpec {
  /** Provider that writes code. */
  maker: ProviderRole
  /** Provider that reviews the diff. Omit/null for single-provider (Cut 1) loops. */
  checker?: ProviderRole | null
  /** Shell commands run in the worktree as the deterministic gate, in order. */
  verify: string[]
  /** Globs that must NOT be modified; a violation re-prompts the maker or escalates. */
  readonly?: string[]
  /** Hard cap on maker turns before the run fails. */
  maxTurns: number
  /** Hard cap on cumulative USD cost before the run fails. */
  maxCostUsd: number
  /** How a successful run lands its changes. Defaults to 'pr' (never auto-merge). */
  completionPolicy: CompletionPolicy
}

export interface GoalRun {
  id: string
  kind: GoalRunKind
  status: GoalRunStatus
  goal: string
  spec: GoalRunSpec
  repo: string
  branch: string
  makerSessionId: string | null
  checkerSessionId: string | null
  turnCount: number
  costUsd: number
  /** Last checker verdict (raw JSON string), if any. */
  verdict: string | null
  /** URL of the pull request opened at finalization (completionPolicy 'pr'), if any. */
  prUrl: string | null
  createdAt: string
  completedAt: string | null
}

export interface CreateGoalRunInput {
  kind: GoalRunKind
  goal: string
  spec: GoalRunSpec
  repo: string
  branch: string
  id?: string
}

/** Fields the controller may patch as a run progresses. */
export interface GoalRunPatch {
  status?: GoalRunStatus
  makerSessionId?: string | null
  checkerSessionId?: string | null
  turnCount?: number
  costUsd?: number
  verdict?: string | null
  prUrl?: string | null
  completedAt?: string | null
}

export interface GoalRunTurn {
  id: string
  runId: string
  turnIndex: number
  role: TurnRole
  /** `git diff --stat` snapshot for this turn. */
  diffSummary: string | null
  /** The verify command that produced exitCode/outputTail (verifier rows). */
  verifyCmd: string | null
  exitCode: number | null
  /** Last N lines of combined output. */
  outputTail: string | null
  /** Checker verdict (checker rows). */
  verdict: CheckerVerdict | null
  costUsd: number | null
  createdAt: string
}

export interface AppendTurnInput {
  runId: string
  turnIndex: number
  role: TurnRole
  diffSummary?: string | null
  verifyCmd?: string | null
  exitCode?: number | null
  outputTail?: string | null
  verdict?: CheckerVerdict | null
  costUsd?: number | null
}

export interface ListRunsOptions {
  status?: GoalRunStatus
  kind?: GoalRunKind
  limit?: number
}

// ---------------------------------------------------------------------------
// Row shapes (as stored)
// ---------------------------------------------------------------------------

interface GoalRunRow {
  id: string
  kind: string
  status: string
  goal: string
  spec: string
  repo: string
  branch: string
  maker_session_id: string | null
  checker_session_id: string | null
  turn_count: number
  cost_usd: number
  verdict: string | null
  pr_url: string | null
  created_at: string
  completed_at: string | null
}

interface GoalRunTurnRow {
  id: string
  run_id: string
  turn_index: number
  role: string
  diff_summary: string | null
  verify_cmd: string | null
  exit_code: number | null
  output_tail: string | null
  verdict: string | null
  cost_usd: number | null
  created_at: string
}

// Whitelist of patchable columns — guards the dynamic UPDATE against injection.
const PATCH_COLUMNS: Record<keyof GoalRunPatch, string> = {
  status: 'status',
  makerSessionId: 'maker_session_id',
  checkerSessionId: 'checker_session_id',
  turnCount: 'turn_count',
  costUsd: 'cost_usd',
  verdict: 'verdict',
  prUrl: 'pr_url',
  completedAt: 'completed_at',
}

// ---------------------------------------------------------------------------
// GoalRunStore
// ---------------------------------------------------------------------------

export class GoalRunStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const dir = join(homedir(), '.codekin')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const resolvedPath = dbPath ?? join(dir, 'goal-runs.db')
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.createTables()
    this.migrateSchema()
  }

  /** Additive, idempotent column migrations for databases created before a column existed. */
  private migrateSchema() {
    const columns = (this.db.prepare(`PRAGMA table_info(goal_runs)`).all() as { name: string }[]).map((c) => c.name)
    if (!columns.includes('pr_url')) {
      this.db.exec(`ALTER TABLE goal_runs ADD COLUMN pr_url TEXT`)
    }
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_runs (
        id                 TEXT PRIMARY KEY,
        kind               TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'queued',
        goal               TEXT NOT NULL,
        spec               TEXT NOT NULL DEFAULT '{}',
        repo               TEXT NOT NULL,
        branch             TEXT NOT NULL,
        maker_session_id   TEXT,
        checker_session_id TEXT,
        turn_count         INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL NOT NULL DEFAULT 0,
        verdict            TEXT,
        pr_url             TEXT,
        created_at         TEXT NOT NULL,
        completed_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_run_turns (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES goal_runs(id),
        turn_index   INTEGER NOT NULL,
        role         TEXT NOT NULL,
        diff_summary TEXT,
        verify_cmd   TEXT,
        exit_code    INTEGER,
        output_tail  TEXT,
        verdict      TEXT,
        cost_usd     REAL,
        created_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goal_runs_status ON goal_runs(status);
      CREATE INDEX IF NOT EXISTS idx_goal_runs_kind ON goal_runs(kind);
      CREATE INDEX IF NOT EXISTS idx_goal_run_turns_run_id ON goal_run_turns(run_id);
    `)
  }

  createRun(input: CreateGoalRunInput): GoalRun {
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO goal_runs (id, kind, status, goal, spec, repo, branch, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.goal, JSON.stringify(input.spec), input.repo, input.branch, createdAt)
    const run = this.getRun(id)
    if (!run) throw new Error(`goal run ${id} vanished immediately after insert`)
    return run
  }

  getRun(id: string): GoalRun | null {
    const row = this.db.prepare(`SELECT * FROM goal_runs WHERE id = ?`).get(id) as GoalRunRow | undefined
    return row ? mapRun(row) : null
  }

  listRuns(opts: ListRunsOptions = {}): GoalRun[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts.status) {
      clauses.push('status = ?')
      params.push(opts.status)
    }
    if (opts.kind) {
      clauses.push('kind = ?')
      params.push(opts.kind)
    }
    let sql = `SELECT * FROM goal_runs`
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`
    // rowid breaks ties when two runs share a created_at millisecond, so
    // insertion order is the stable secondary key (newest inserted first).
    sql += ` ORDER BY created_at DESC, rowid DESC`
    if (opts.limit) {
      sql += ` LIMIT ?`
      params.push(opts.limit)
    }
    return (this.db.prepare(sql).all(...params) as GoalRunRow[]).map(mapRun)
  }

  /** Apply a partial update. Only whitelisted columns are written. No-op for an empty patch. */
  patchRun(id: string, patch: GoalRunPatch): void {
    const sets: string[] = []
    const params: unknown[] = []
    for (const key of Object.keys(patch) as (keyof GoalRunPatch)[]) {
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${PATCH_COLUMNS[key]} = ?`)
      params.push(value)
    }
    if (!sets.length) return
    params.push(id)
    this.db.prepare(`UPDATE goal_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  appendTurn(input: AppendTurnInput): GoalRunTurn {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO goal_run_turns
         (id, run_id, turn_index, role, diff_summary, verify_cmd, exit_code, output_tail, verdict, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.turnIndex,
        input.role,
        input.diffSummary ?? null,
        input.verifyCmd ?? null,
        input.exitCode ?? null,
        input.outputTail ?? null,
        input.verdict ?? null,
        input.costUsd ?? null,
        createdAt,
      )
    const row = this.db.prepare(`SELECT * FROM goal_run_turns WHERE id = ?`).get(id) as GoalRunTurnRow
    return mapTurn(row)
  }

  listTurns(runId: string): GoalRunTurn[] {
    return (
      this.db.prepare(`SELECT * FROM goal_run_turns WHERE run_id = ? ORDER BY turn_index ASC, created_at ASC`).all(runId) as GoalRunTurnRow[]
    ).map(mapTurn)
  }

  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapRun(row: GoalRunRow): GoalRun {
  return {
    id: row.id,
    kind: row.kind as GoalRunKind,
    status: row.status as GoalRunStatus,
    goal: row.goal,
    spec: jsonParse(row.spec) as GoalRunSpec,
    repo: row.repo,
    branch: row.branch,
    makerSessionId: row.maker_session_id,
    checkerSessionId: row.checker_session_id,
    turnCount: row.turn_count,
    costUsd: row.cost_usd,
    verdict: row.verdict,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function mapTurn(row: GoalRunTurnRow): GoalRunTurn {
  return {
    id: row.id,
    runId: row.run_id,
    turnIndex: row.turn_index,
    role: row.role as TurnRole,
    diffSummary: row.diff_summary,
    verifyCmd: row.verify_cmd,
    exitCode: row.exit_code,
    outputTail: row.output_tail,
    verdict: row.verdict as CheckerVerdict | null,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  }
}
