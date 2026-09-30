/**
 * Persistence for explicit repo maintenance
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §6–§9).
 *
 *   maintenance_plans             — one row per repo that ever had a plan: configured
 *                                   state (off / enabled / paused) plus a revision.
 *   maintenance_responsibilities  — scoped obligations in a plan, each linked to the
 *                                   repo automations that provide its checks.
 *   maintenance_activity          — append-only record of checks, findings, actions and
 *                                   configuration/coverage changes, deduplicated by ref.
 *
 * A repo without a row is simply not maintained. Nothing here is inferred from
 * sessions, tasks or existing automations.
 *
 * Same conventions as the other runs.db stores: better-sqlite3, WAL, 0o600,
 * JSON as TEXT, ':memory:' for tests.
 */

import Database from 'better-sqlite3'
import { existsSync, chmodSync } from 'fs'
import { randomUUID } from 'crypto'
import { jsonParse } from './json-parse.js'
import { defaultRunsDbPath } from './run-db.js'

export type PlanState = 'off' | 'enabled' | 'paused'
export type ResponsePolicy = 'notify' | 'propose' | 'investigate' | 'implement'
export type ActivityKind = 'check_ok' | 'check_failed' | 'finding' | 'action' | 'config' | 'coverage'

export const PLAN_STATES: readonly PlanState[] = ['off', 'enabled', 'paused']
export const RESPONSE_POLICIES: readonly ResponsePolicy[] = ['notify', 'propose', 'investigate', 'implement']

export interface MaintenancePlan {
  repo: string
  state: PlanState
  revision: number
  createdAt: string
  updatedAt: string
  updatedBy: 'user' | 'joe' | 'system'
}

export interface Responsibility {
  id: string
  repo: string
  name: string
  /** What is watched, e.g. "Dependencies on the default branch". */
  scope: string
  /** Repo automations whose runs are this responsibility's checks. */
  automationIds: string[]
  policy: ResponsePolicy
  /** At most this many open tasks governed by the responsibility at once. */
  maxActiveTasks: number
  /** Changes that always need the user, e.g. "anything outside the dependency files". */
  requiredDecision: string
  enabled: boolean
  /** A proposal (Joe's draft) is inert until the user enables the plan with it. */
  proposed: boolean
  latestObservation: string | null
  latestObservationAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MaintenanceActivity {
  id: string
  repo: string
  responsibilityId: string | null
  kind: ActivityKind
  summary: string
  /** Run, task or change the entry is about; unique per (kind, ref) so replays don't duplicate. */
  ref: string | null
  createdAt: string
}

export type ResponsibilityInput = Pick<Responsibility, 'name' | 'scope' | 'automationIds' | 'policy'>
  & Partial<Pick<Responsibility, 'maxActiveTasks' | 'requiredDecision' | 'enabled' | 'proposed'>>

interface ResponsibilityRow {
  id: string
  repo: string
  name: string
  scope: string
  automation_ids: string
  policy: string
  max_active_tasks: number
  required_decision: string
  enabled: number
  proposed: number
  latest_observation: string | null
  latest_observation_at: string | null
  created_at: string
  updated_at: string
}

export class MaintenanceStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_plans (
        repo        TEXT PRIMARY KEY,
        state       TEXT NOT NULL DEFAULT 'off',
        revision    INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL DEFAULT 'user'
      );

      CREATE TABLE IF NOT EXISTS maintenance_responsibilities (
        id                    TEXT PRIMARY KEY,
        repo                  TEXT NOT NULL,
        name                  TEXT NOT NULL,
        scope                 TEXT NOT NULL DEFAULT '',
        automation_ids        TEXT NOT NULL DEFAULT '[]',
        policy                TEXT NOT NULL DEFAULT 'notify',
        max_active_tasks      INTEGER NOT NULL DEFAULT 1,
        required_decision     TEXT NOT NULL DEFAULT '',
        enabled               INTEGER NOT NULL DEFAULT 1,
        proposed              INTEGER NOT NULL DEFAULT 0,
        latest_observation    TEXT,
        latest_observation_at TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maintenance_activity (
        id                TEXT PRIMARY KEY,
        repo              TEXT NOT NULL,
        responsibility_id TEXT,
        kind              TEXT NOT NULL,
        summary           TEXT NOT NULL,
        ref               TEXT,
        created_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_maint_resp_repo ON maintenance_responsibilities(repo);
      CREATE INDEX IF NOT EXISTS idx_maint_activity_repo ON maintenance_activity(repo, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_activity_ref ON maintenance_activity(kind, ref) WHERE ref IS NOT NULL;
    `)
  }

  // --- plans ------------------------------------------------------------------

  getPlan(repo: string): MaintenancePlan | null {
    const row = this.db.prepare('SELECT * FROM maintenance_plans WHERE repo = ?').get(repo) as Record<string, unknown> | undefined
    return row ? mapPlan(row) : null
  }

  listPlans(): MaintenancePlan[] {
    return (this.db.prepare('SELECT * FROM maintenance_plans ORDER BY repo').all() as Record<string, unknown>[]).map(mapPlan)
  }

  /** Set a plan's state, creating the row on first use. Returns the new plan. */
  setState(repo: string, state: PlanState, actor: MaintenancePlan['updatedBy']): MaintenancePlan {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO maintenance_plans (repo, state, revision, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(repo) DO UPDATE SET state = excluded.state, revision = revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(repo, state, now, now, actor)
    const plan = this.getPlan(repo)
    if (!plan) throw new Error(`Plan for ${repo} vanished after write`)
    return plan
  }

  // --- responsibilities -------------------------------------------------------

  listResponsibilities(repo?: string): Responsibility[] {
    const rows = (repo
      ? this.db.prepare('SELECT * FROM maintenance_responsibilities WHERE repo = ? ORDER BY created_at, rowid').all(repo)
      : this.db.prepare('SELECT * FROM maintenance_responsibilities ORDER BY repo, created_at, rowid').all()) as ResponsibilityRow[]
    return rows.map(mapResponsibility)
  }

  getResponsibility(id: string): Responsibility | null {
    const row = this.db.prepare('SELECT * FROM maintenance_responsibilities WHERE id = ?').get(id) as ResponsibilityRow | undefined
    return row ? mapResponsibility(row) : null
  }

  addResponsibility(repo: string, input: ResponsibilityInput): Responsibility {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO maintenance_responsibilities
        (id, repo, name, scope, automation_ids, policy, max_active_tasks, required_decision, enabled, proposed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, repo, input.name, input.scope, JSON.stringify(input.automationIds), input.policy,
      input.maxActiveTasks ?? 1, input.requiredDecision ?? '', input.enabled === false ? 0 : 1, input.proposed ? 1 : 0, now, now,
    )
    const created = this.getResponsibility(id)
    if (!created) throw new Error('Responsibility vanished after insert')
    return created
  }

  updateResponsibility(id: string, patch: Partial<ResponsibilityInput & Pick<Responsibility, 'latestObservation' | 'latestObservationAt'>>): Responsibility | null {
    const columns: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', v => v],
      scope: ['scope', v => v],
      automationIds: ['automation_ids', v => JSON.stringify(v)],
      policy: ['policy', v => v],
      maxActiveTasks: ['max_active_tasks', v => v],
      requiredDecision: ['required_decision', v => v],
      enabled: ['enabled', v => (v ? 1 : 0)],
      proposed: ['proposed', v => (v ? 1 : 0)],
      latestObservation: ['latest_observation', v => v],
      latestObservationAt: ['latest_observation_at', v => v],
    }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in columns)) continue
      const [column, encode] = columns[key]
      sets.push(`${column} = ?`)
      params.push(encode(value))
    }
    if (sets.length === 0) return this.getResponsibility(id)
    sets.push('updated_at = ?')
    params.push(new Date().toISOString(), id)
    this.db.prepare(`UPDATE maintenance_responsibilities SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.getResponsibility(id)
  }

  removeResponsibility(id: string): boolean {
    return this.db.prepare('DELETE FROM maintenance_responsibilities WHERE id = ?').run(id).changes > 0
  }

  // --- activity ---------------------------------------------------------------

  /** Append an activity entry. Returns null when an entry with the same (kind, ref) exists. */
  recordActivity(entry: Omit<MaintenanceActivity, 'id' | 'createdAt'>): MaintenanceActivity | null {
    const row: MaintenanceActivity = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO maintenance_activity (id, repo, responsibility_id, kind, summary, ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.repo, row.responsibilityId, row.kind, row.summary.slice(0, 2000), row.ref, row.createdAt)
    return result.changes > 0 ? row : null
  }

  listActivity(opts: { repo?: string; responsibilityId?: string; limit?: number } = {}): MaintenanceActivity[] {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.repo) { where.push('repo = ?'); params.push(opts.repo) }
    if (opts.responsibilityId) { where.push('responsibility_id = ?'); params.push(opts.responsibilityId) }
    params.push(Math.min(opts.limit ?? 50, 500))
    const sql = `SELECT * FROM maintenance_activity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      repo: r.repo as string,
      responsibilityId: (r.responsibility_id as string | null) ?? null,
      kind: r.kind as ActivityKind,
      summary: r.summary as string,
      ref: (r.ref as string | null) ?? null,
      createdAt: r.created_at as string,
    }))
  }

  close(): void {
    this.db.close()
  }
}

function mapPlan(row: Record<string, unknown>): MaintenancePlan {
  return {
    repo: row.repo as string,
    state: row.state as PlanState,
    revision: row.revision as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    updatedBy: row.updated_by as MaintenancePlan['updatedBy'],
  }
}

function mapResponsibility(row: ResponsibilityRow): Responsibility {
  return {
    id: row.id,
    repo: row.repo,
    name: row.name,
    scope: row.scope,
    automationIds: jsonParse(row.automation_ids) as string[],
    policy: row.policy as ResponsePolicy,
    maxActiveTasks: row.max_active_tasks,
    requiredDecision: row.required_decision,
    enabled: row.enabled === 1,
    proposed: row.proposed === 1,
    latestObservation: row.latest_observation,
    latestObservationAt: row.latest_observation_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
