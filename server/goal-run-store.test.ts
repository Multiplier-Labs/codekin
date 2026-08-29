/** Tests for GoalRunStore — verifies run CRUD, spec (de)serialization, patching, and the turn evidence ledger against a real in-memory SQLite DB. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GoalRunStore, type CreateGoalRunInput, type GoalRunSpec } from './goal-run-store.js'

const baseSpec: GoalRunSpec = {
  maker: { provider: 'claude', model: 'sonnet' },
  checker: { provider: 'opencode' },
  verify: ['npm test', 'npm run lint'],
  readonly: ['.github/workflows/**', 'tests/security/**'],
  maxTurns: 12,
  maxCostUsd: 5,
  completionPolicy: 'pr',
}

function makeInput(overrides: Partial<CreateGoalRunInput> = {}): CreateGoalRunInput {
  return {
    kind: 'ci-autorepair',
    goal: 'All failing checks pass without weakening tests',
    spec: baseSpec,
    repo: '/srv/repos/example',
    branch: 'fix/ci',
    ...overrides,
  }
}

describe('GoalRunStore', () => {
  let store: GoalRunStore

  beforeEach(() => {
    store = new GoalRunStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  describe('createRun / getRun', () => {
    it('round-trips a run including the parsed spec', () => {
      const created = store.createRun(makeInput())
      expect(created.id).toBeTruthy()
      expect(created.status).toBe('queued')
      expect(created.turnCount).toBe(0)
      expect(created.costUsd).toBe(0)
      expect(created.makerSessionId).toBeNull()
      expect(created.completedAt).toBeNull()

      const fetched = store.getRun(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched?.spec).toEqual(baseSpec)
      expect(fetched?.spec.maker.provider).toBe('claude')
      expect(fetched?.spec.checker?.provider).toBe('opencode')
      expect(fetched?.goal).toBe('All failing checks pass without weakening tests')
    })

    it('honours a caller-supplied id', () => {
      const created = store.createRun(makeInput({ id: 'fixed-id' }))
      expect(created.id).toBe('fixed-id')
    })

    it('returns null for an unknown id', () => {
      expect(store.getRun('nope')).toBeNull()
    })

    it('supports a single-provider spec with no checker', () => {
      const spec: GoalRunSpec = { ...baseSpec, checker: null }
      const created = store.createRun(makeInput({ spec }))
      expect(store.getRun(created.id)?.spec.checker).toBeNull()
    })
  })

  describe('listRuns', () => {
    it('returns newest first and filters by status and kind', () => {
      const a = store.createRun(makeInput({ branch: 'a' }))
      const b = store.createRun(makeInput({ kind: 'coverage-increase', branch: 'b' }))
      store.patchRun(b.id, { status: 'running' })

      const all = store.listRuns()
      expect(all.map((r) => r.id)).toEqual([b.id, a.id]) // newest first

      const running = store.listRuns({ status: 'running' })
      expect(running.map((r) => r.id)).toEqual([b.id])

      const coverage = store.listRuns({ kind: 'coverage-increase' })
      expect(coverage.map((r) => r.id)).toEqual([b.id])

      expect(store.listRuns({ limit: 1 })).toHaveLength(1)
    })
  })

  describe('patchRun', () => {
    it('updates whitelisted fields and ignores an empty patch', () => {
      const run = store.createRun(makeInput())
      store.patchRun(run.id, {
        status: 'running',
        makerSessionId: 'sess-1',
        turnCount: 3,
        costUsd: 1.25,
        verdict: '{"verdict":"request_changes"}',
      })
      const updated = store.getRun(run.id)
      expect(updated?.status).toBe('running')
      expect(updated?.makerSessionId).toBe('sess-1')
      expect(updated?.turnCount).toBe(3)
      expect(updated?.costUsd).toBe(1.25)
      expect(updated?.verdict).toBe('{"verdict":"request_changes"}')

      // empty patch is a no-op, not an error
      expect(() => store.patchRun(run.id, {})).not.toThrow()
      expect(store.getRun(run.id)?.status).toBe('running')
    })

    it('can null out a session id and set completion', () => {
      const run = store.createRun(makeInput())
      store.patchRun(run.id, { makerSessionId: 'sess-1' })
      store.patchRun(run.id, { makerSessionId: null, status: 'succeeded', completedAt: '2026-06-14T00:00:00Z' })
      const updated = store.getRun(run.id)
      expect(updated?.makerSessionId).toBeNull()
      expect(updated?.status).toBe('succeeded')
      expect(updated?.completedAt).toBe('2026-06-14T00:00:00Z')
    })

    it('round-trips the finalization pr url (defaults null)', () => {
      const run = store.createRun(makeInput())
      expect(run.prUrl).toBeNull()
      store.patchRun(run.id, { status: 'succeeded', prUrl: 'https://github.com/acme/repo/pull/9' })
      expect(store.getRun(run.id)?.prUrl).toBe('https://github.com/acme/repo/pull/9')
      store.patchRun(run.id, { prUrl: null })
      expect(store.getRun(run.id)?.prUrl).toBeNull()
    })
  })

  describe('appendTurn / listTurns', () => {
    it('records the evidence ledger ordered by turn index', () => {
      const run = store.createRun(makeInput())
      store.appendTurn({ runId: run.id, turnIndex: 1, role: 'maker', diffSummary: ' src/a.ts | 2 +-' })
      store.appendTurn({
        runId: run.id,
        turnIndex: 2,
        role: 'verifier',
        verifyCmd: 'npm test',
        exitCode: 1,
        outputTail: 'FAIL src/a.test.ts',
      })
      store.appendTurn({ runId: run.id, turnIndex: 3, role: 'checker', verdict: 'request_changes', costUsd: 0.4 })

      const turns = store.listTurns(run.id)
      expect(turns.map((t) => t.turnIndex)).toEqual([1, 2, 3])
      expect(turns[1].role).toBe('verifier')
      expect(turns[1].exitCode).toBe(1)
      expect(turns[1].verifyCmd).toBe('npm test')
      expect(turns[2].verdict).toBe('request_changes')
      expect(turns[2].costUsd).toBe(0.4)
      // unset optional columns come back as null
      expect(turns[0].verifyCmd).toBeNull()
      expect(turns[0].verdict).toBeNull()
    })

    it('isolates turns by run', () => {
      const a = store.createRun(makeInput())
      const b = store.createRun(makeInput({ branch: 'b' }))
      store.appendTurn({ runId: a.id, turnIndex: 1, role: 'maker' })
      expect(store.listTurns(b.id)).toHaveLength(0)
      expect(store.listTurns(a.id)).toHaveLength(1)
    })
  })

  describe('events', () => {
    it('emits run_status on a status patch, with the run kind attached', () => {
      const events: unknown[] = []
      store.setEventListener((e) => events.push(e))
      const run = store.createRun(makeInput())

      store.patchRun(run.id, { status: 'running' })
      expect(events).toEqual([{ eventType: 'run_status', runId: run.id, kind: 'ci-autorepair', status: 'running' }])
    })

    it('does not emit for patches that leave status unchanged', () => {
      const events: unknown[] = []
      store.setEventListener((e) => events.push(e))
      const run = store.createRun(makeInput())

      store.patchRun(run.id, { turnCount: 3, costUsd: 1.2 })
      expect(events).toHaveLength(0)
    })

    it('emits turn on appendTurn', () => {
      const events: unknown[] = []
      store.setEventListener((e) => events.push(e))
      const run = store.createRun(makeInput())

      store.appendTurn({ runId: run.id, turnIndex: 1, role: 'verifier' })
      expect(events).toEqual([{ eventType: 'turn', runId: run.id, kind: 'ci-autorepair' }])
    })

    it('a throwing listener does not break the mutation', () => {
      store.setEventListener(() => { throw new Error('listener boom') })
      const run = store.createRun(makeInput())

      expect(() => store.patchRun(run.id, { status: 'running' })).not.toThrow()
      expect(store.getRun(run.id)?.status).toBe('running')
    })
  })
})
