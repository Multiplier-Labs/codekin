/** Tests for the unified runs database — legacy-file migration into runs.db for both engines. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyTables } from './run-db.js'
import { GoalRunStore, type CreateGoalRunInput } from './goal-run-store.js'
import { WorkflowEngine } from './workflow-engine.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-rundb-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const input: CreateGoalRunInput = {
  kind: 'ci-autorepair',
  goal: 'green checks',
  spec: {
    maker: { provider: 'claude' },
    checker: null,
    verify: ['npm test'],
    maxTurns: 5,
    maxCostUsd: 2,
    completionPolicy: 'pr',
  },
  repo: '/repo',
  branch: 'fix/ci',
}

describe('goal-run migration', () => {
  it('copies runs and turns from a legacy goal-runs.db into a fresh store', () => {
    const legacyPath = join(dir, 'goal-runs.db')
    const legacy = new GoalRunStore(legacyPath, undefined)
    const run = legacy.createRun(input)
    legacy.patchRun(run.id, { status: 'succeeded' })
    legacy.appendTurn({ runId: run.id, turnIndex: 1, role: 'maker', outputTail: 'done' })
    legacy.close()

    const unified = new GoalRunStore(join(dir, 'runs.db'), legacyPath)
    expect(unified.getRun(run.id)?.status).toBe('succeeded')
    expect(unified.listTurns(run.id)).toHaveLength(1)
    unified.close()
  })

  it('does not copy twice or overwrite newer data', () => {
    const legacyPath = join(dir, 'goal-runs.db')
    const legacy = new GoalRunStore(legacyPath, undefined)
    legacy.createRun(input)
    legacy.close()

    const first = new GoalRunStore(join(dir, 'runs.db'), legacyPath)
    first.createRun({ ...input, branch: 'post-migration' })
    expect(first.listRuns()).toHaveLength(2)
    first.close()

    // Reopening with the legacy file still present must not duplicate rows.
    const second = new GoalRunStore(join(dir, 'runs.db'), legacyPath)
    expect(second.listRuns()).toHaveLength(2)
    second.close()
  })

  it('is a no-op when no legacy file exists', () => {
    const store = new GoalRunStore(join(dir, 'runs.db'), join(dir, 'missing.db'))
    expect(store.listRuns()).toHaveLength(0)
    store.close()
  })
})

describe('workflow migration', () => {
  it('copies runs and schedules from a legacy workflows.db', async () => {
    const legacyPath = join(dir, 'workflows.db')
    const legacy = new WorkflowEngine(legacyPath, undefined)
    legacy.registerWorkflow({ kind: 'k', steps: [{ key: 's', handler: async () => ({}) }] })
    const run = await legacy.startRun('k', {})
    legacy.upsertSchedule({ id: 'sched-1', kind: 'k', cronExpression: '0 6 * * *', input: {}, enabled: true })
    legacy.shutdown()

    const unified = new WorkflowEngine(join(dir, 'runs.db'), legacyPath)
    expect(unified.getRun(run.id)).not.toBeNull()
    expect(unified.listSchedules()).toHaveLength(1)
    unified.shutdown()
  })
})

describe('migrateLegacyTables edge cases', () => {
  it('shares one database file between both engines', () => {
    const shared = join(dir, 'runs.db')
    const goals = new GoalRunStore(shared, undefined)
    const flows = new WorkflowEngine(shared, undefined)
    const run = goals.createRun(input)
    flows.registerWorkflow({ kind: 'k', steps: [{ key: 's', handler: async () => ({}) }] })
    expect(goals.getRun(run.id)).not.toBeNull()
    flows.shutdown()
    goals.close()
  })

  it('returns 0 for a missing legacy file', () => {
    const store = new GoalRunStore(join(dir, 'runs.db'), undefined)
    // Reach the raw db through a second store call path: use the public API only.
    expect(migrateLegacyTables(store['db'], join(dir, 'nope.db'), ['goal_runs'])).toBe(0)
    store.close()
  })
})
