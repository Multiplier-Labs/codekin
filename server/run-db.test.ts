/** Tests for the unified runs database — legacy-file migration into runs.db, shared-file coexistence. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyTables } from './run-db.js'
import { LoopStore } from './loop-store.js'
import { parseLoopRecipe } from './loop-recipe.js'
import { WorkflowEngine } from './workflow-engine.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-rundb-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const recipe = parseLoopRecipe(
  `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-autorepair, name: CI Autorepair }
agent: { provider: claude }
evaluators:
  - { id: tests, type: command, command: npm test }
budgets: { turns: 5, costUsd: 2 }
---
Green checks.
`,
  '/x.md',
  'builtin',
)

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

describe('shared runs.db', () => {
  it('loop store and workflow engine coexist in one database file', () => {
    const shared = join(dir, 'runs.db')
    const loops = new LoopStore(shared)
    const flows = new WorkflowEngine(shared, undefined)
    const run = loops.createRun({ recipe, goal: recipe.outcome, repo: '/repo', branch: 'loop/x', provider: 'claude' })
    flows.registerWorkflow({ kind: 'k', steps: [{ key: 's', handler: async () => ({}) }] })
    expect(loops.getRun(run.id)).not.toBeNull()
    flows.shutdown()
    loops.close()
  })
})

describe('migrateLegacyTables edge cases', () => {
  it('returns 0 for a missing legacy file', () => {
    const store = new LoopStore(join(dir, 'runs.db'))
    expect(migrateLegacyTables(store['db'], join(dir, 'nope.db'), ['loop_runs'])).toBe(0)
    store.close()
  })
})
