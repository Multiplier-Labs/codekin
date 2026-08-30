import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { LoopStore, type LoopRun } from './loop-store.js'
import { LoopArtifactStore } from './loop-artifacts.js'
import { parseLoopRecipe } from './loop-recipe.js'

const RECIPE_MD = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-repair, name: Repair CI }
agent: { provider: claude }
evaluators:
  - { id: tests, type: command, command: npm test }
budgets: { turns: 8, costUsd: 3 }
---
Fix the failing CI.
`

const recipe = parseLoopRecipe(RECIPE_MD, '/x/ci-repair.md', 'builtin')

function makeStore() {
  return new LoopStore(':memory:')
}

function makeRun(store: LoopStore): LoopRun {
  return store.createRun({ recipe, goal: recipe.outcome, repo: '/srv/repos/foo', branch: 'loop/ci-1', provider: 'claude' })
}

describe('LoopStore runs', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('creates a run with the frozen recipe and reads it back', () => {
    const run = makeRun(store)
    expect(run.state).toBe('created')
    expect(run.outcome).toBeNull()
    expect(run.recipeHash).toBe(recipe.contentHash)
    expect(run.recipe.evaluators).toHaveLength(1)
    expect(store.getRun(run.id)?.goal).toBe('Fix the failing CI.')
  })

  it('patches state, reason, and outcome independently', () => {
    const run = makeRun(store)
    store.patchRun(run.id, { state: 'awaiting_approval', stateReason: 'completion requires approval' })
    expect(store.getRun(run.id)).toMatchObject({ state: 'awaiting_approval', stateReason: 'completion requires approval', outcome: null })
    store.patchRun(run.id, { state: 'done', outcome: 'completed', completedAt: new Date().toISOString() })
    expect(store.getRun(run.id)).toMatchObject({ state: 'done', outcome: 'completed' })
  })

  it('lists runs filtered by state, repo, and activeOnly', () => {
    const a = makeRun(store)
    const b = makeRun(store)
    store.patchRun(a.id, { state: 'done', outcome: 'canceled' })
    store.patchRun(b.id, { state: 'executing' })
    expect(store.listRuns({ activeOnly: true }).map((r) => r.id)).toEqual([b.id])
    expect(store.listRuns({ state: 'done' }).map((r) => r.id)).toEqual([a.id])
    expect(store.listRuns({ repo: '/srv/repos/foo' })).toHaveLength(2)
    expect(store.listRuns({ repo: '/other' })).toHaveLength(0)
  })
})

describe('LoopStore events', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('assigns a monotonic per-run sequence and notifies the listener', () => {
    const run = makeRun(store)
    const other = makeRun(store)
    const seen: number[] = []
    store.setEventListener((e) => seen.push(e.sequence))

    const e1 = store.appendEvent({ runId: run.id, type: 'state_changed', payload: { to: 'preflight' } })
    store.appendEvent({ runId: other.id, type: 'state_changed' })
    const e3 = store.appendEvent({ runId: run.id, type: 'stage_started', actor: { type: 'agent', id: 'maker' } })

    expect(e1.sequence).toBe(1)
    expect(e3.sequence).toBe(2) // other run's events don't advance this run's cursor
    expect(seen).toEqual([1, 1, 2])
    expect(store.lastSequence(run.id)).toBe(2)
  })

  it('replays events after a cursor, oldest first', () => {
    const run = makeRun(store)
    for (let i = 0; i < 5; i++) store.appendEvent({ runId: run.id, type: `t${i}` })
    const tail = store.listEvents(run.id, 3)
    expect(tail.map((e) => e.type)).toEqual(['t3', 't4'])
    expect(store.listEvents(run.id)).toHaveLength(5)
  })

  it('a throwing listener never breaks the append', () => {
    const run = makeRun(store)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.setEventListener(() => {
      throw new Error('boom')
    })
    expect(() => store.appendEvent({ runId: run.id, type: 'x' })).not.toThrow()
    expect(store.lastSequence(run.id)).toBe(1)
    spy.mockRestore()
  })
})

describe('LoopStore stages, attempts, checkpoints', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('stages get monotonic indices and complete with a status', () => {
    const run = makeRun(store)
    const s0 = store.createStage(run.id, 'preflight')
    const s1 = store.createStage(run.id, 'act')
    expect([s0.stageIndex, s1.stageIndex]).toEqual([0, 1])
    store.completeStage(s0.id, 'succeeded')
    expect(store.listStages(run.id).map((s) => s.status)).toEqual(['succeeded', 'running'])
  })

  it('attempts are numbered per stage and record errors', () => {
    const run = makeRun(store)
    const stage = store.createStage(run.id, 'evaluate')
    const a0 = store.createAttempt(stage.id, run.id)
    const a1 = store.createAttempt(stage.id, run.id)
    expect([a0.attemptIndex, a1.attemptIndex]).toEqual([0, 1])
    store.completeAttempt(a0.id, 'failed', 'command timed out')
  })

  it('checkpoints record the event-sequence cursor and round-trip state', () => {
    const run = makeRun(store)
    store.appendEvent({ runId: run.id, type: 'a' })
    store.appendEvent({ runId: run.id, type: 'b' })
    const cp = store.saveCheckpoint(run.id, { phase: 'act', turn: 3 })
    expect(cp.sequence).toBe(2)
    store.appendEvent({ runId: run.id, type: 'c' })
    const latest = store.latestCheckpoint(run.id)
    expect(latest?.state).toEqual({ phase: 'act', turn: 3 })
    expect(latest?.sequence).toBe(2)
    expect(store.latestCheckpoint('nope')).toBeNull()
  })
})

describe('LoopStore evaluations and artifacts', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('round-trips a structured evaluation', () => {
    const run = makeRun(store)
    const stage = store.createStage(run.id, 'evaluate')
    store.addEvaluation({
      runId: run.id,
      stageId: stage.id,
      evaluatorId: 'tests',
      status: 'fail',
      classification: 'code',
      summary: '2 tests failing',
      fingerprint: 'abc123',
      retryable: false,
      durationMs: 4200,
      costUsd: null,
      evidenceArtifactIds: ['art-1'],
    })
    const [ev] = store.listEvaluations(run.id)
    expect(ev).toMatchObject({ evaluatorId: 'tests', status: 'fail', fingerprint: 'abc123', retryable: false, evidenceArtifactIds: ['art-1'] })
  })

  it('stores artifact metadata and fetches by id', () => {
    const run = makeRun(store)
    const art = store.addArtifact({ runId: run.id, kind: 'log', label: 'tests output', contentHash: 'f'.repeat(64), sizeBytes: 120 })
    expect(store.getArtifact(art.id)?.label).toBe('tests output')
    expect(store.listArtifacts(run.id)).toHaveLength(1)
    expect(store.getArtifact('missing')).toBeNull()
  })
})

describe('LoopStore interventions', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('resolve is guarded — only one resolution wins', () => {
    const run = makeRun(store)
    const iv = store.createIntervention({
      runId: run.id,
      kind: 'approval',
      purpose: 'completion-approval',
      title: 'Approve completion?',
      options: ['approve', 'reject'],
    })
    const first = store.resolveIntervention(iv.id, { choice: 'approve' })
    const second = store.resolveIntervention(iv.id, { choice: 'reject' })
    expect(first?.resolution).toEqual({ choice: 'approve' })
    expect(second).toBeNull()
    expect(store.getIntervention(iv.id)?.status).toBe('resolved')
  })

  it('cancelPendingInterventions sweeps only pending rows', () => {
    const run = makeRun(store)
    const a = store.createIntervention({ runId: run.id, kind: 'approval', purpose: 'completion-approval', title: 'A', options: ['ok'] })
    store.resolveIntervention(a.id, { choice: 'ok' })
    store.createIntervention({ runId: run.id, kind: 'question', purpose: 'escalation', title: 'B', options: [] })
    store.cancelPendingInterventions(run.id)
    const all = store.listInterventions(run.id)
    expect(all.map((i) => i.status).sort()).toEqual(['canceled', 'resolved'])
    expect(store.listInterventions(run.id, 'canceled')).toHaveLength(1)
  })
})

describe('LoopStore lessons', () => {
  let store: LoopStore
  beforeEach(() => {
    store = makeStore()
  })
  afterEach(() => store.close())

  it('lessons resolve once and filter by recipe and status', () => {
    const run = makeRun(store)
    const a = store.addLesson({ recipeId: 'ci-repair', sourceRunId: run.id, kind: 'budget', text: 'Raise turns.' })
    store.addLesson({ recipeId: 'ci-repair', sourceRunId: run.id, kind: 'retry-policy', text: 'Add retries.' })
    store.addLesson({ recipeId: 'other', sourceRunId: run.id, kind: 'budget', text: 'Unrelated.' })

    expect(store.resolveLesson(a.id, 'approved')?.status).toBe('approved')
    expect(store.resolveLesson(a.id, 'rejected')).toBeNull() // guarded

    expect(store.listLessons('ci-repair')).toHaveLength(2)
    expect(store.listLessons('ci-repair', 'approved').map((l) => l.text)).toEqual(['Raise turns.'])
    expect(store.listLessons(undefined, 'suggested')).toHaveLength(2)
    expect(store.getLesson('nope')).toBeNull()
  })
})

describe('v1 table cleanup', () => {
  it('drops leftover goal_runs tables on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-loopdb-'))
    const dbPath = join(dir, 'runs.db')
    try {
      const raw = new Database(dbPath)
      raw.exec(`CREATE TABLE goal_runs (id TEXT); CREATE TABLE goal_run_turns (id TEXT);`)
      raw.close()
      const store = new LoopStore(dbPath)
      store.close()
      const check = new Database(dbPath)
      const tables = (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
      check.close()
      expect(tables).not.toContain('goal_runs')
      expect(tables).not.toContain('goal_run_turns')
      expect(tables).toContain('loop_runs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('LoopArtifactStore', () => {
  it('content-addresses bodies, is idempotent, and guards bad hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-artifacts-'))
    try {
      const artifacts = new LoopArtifactStore(dir)
      const h1 = artifacts.put('hello world')
      const h2 = artifacts.put(Buffer.from('hello world'))
      expect(h1).toBe(h2)
      expect(artifacts.get(h1)?.toString()).toBe('hello world')
      expect(artifacts.get('0'.repeat(64))).toBeNull()
      expect(artifacts.get('../../etc/passwd')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
