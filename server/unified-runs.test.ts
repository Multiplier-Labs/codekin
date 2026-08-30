/** Tests for the unified run read model — field mapping, status folding, and merge ordering. */
import { describe, it, expect } from 'vitest'
import { fromWorkflowRun, fromLoopRun, loopLifecycleStatus, mergeRuns } from './unified-runs.js'
import type { WorkflowRun } from './workflow-engine.js'
import type { LoopRun } from './loop-store.js'
import { parseLoopRecipe } from './loop-recipe.js'

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wf-1',
    kind: 'code-review.daily',
    status: 'succeeded',
    input: { repoPath: '/srv/repos/example' },
    output: null,
    error: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    startedAt: '2026-08-29T10:00:01.000Z',
    completedAt: '2026-08-29T10:05:00.000Z',
    sessionId: 'sess-wf',
    ...overrides,
  }
}

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

function loopRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'lr-1',
    recipeId: 'ci-autorepair',
    recipeHash: recipe.contentHash,
    recipe,
    goal: 'green',
    repo: '/srv/repos/example',
    branch: 'loop/ci',
    baseSha: 'abc123',
    provider: 'claude',
    model: null,
    state: 'done',
    stateReason: null,
    outcome: 'completed',
    makerSessionId: 'sess-maker',
    worktreePath: '/wt/x',
    turnCount: 3,
    costUsd: 1.25,
    prUrl: 'https://github.com/acme/x/pull/9',
    createdAt: '2026-08-29T11:00:00.000Z',
    startedAt: '2026-08-29T11:00:01.000Z',
    completedAt: '2026-08-29T11:30:00.000Z',
    ...overrides,
  }
}

describe('fromWorkflowRun', () => {
  it('maps fields and reads repo from input.repoPath', () => {
    const u = fromWorkflowRun(workflowRun())
    expect(u).toMatchObject({
      engine: 'workflow',
      kind: 'code-review.daily',
      status: 'succeeded',
      repo: '/srv/repos/example',
      branch: null,
      costUsd: null,
      sessionId: 'sess-wf',
    })
  })

  it('tolerates a missing repoPath', () => {
    expect(fromWorkflowRun(workflowRun({ input: {} })).repo).toBeNull()
  })
})

describe('loopLifecycleStatus', () => {
  it('folds terminal (state, outcome) pairs into the lifecycle vocabulary', () => {
    expect(loopLifecycleStatus(loopRun({ state: 'done', outcome: 'completed' }))).toBe('succeeded')
    expect(loopLifecycleStatus(loopRun({ state: 'done', outcome: 'completed_with_warnings' }))).toBe('succeeded')
    expect(loopLifecycleStatus(loopRun({ state: 'done', outcome: 'failed' }))).toBe('failed')
    expect(loopLifecycleStatus(loopRun({ state: 'done', outcome: 'canceled' }))).toBe('canceled')
  })

  it('maps active states onto their nearest lifecycle members', () => {
    expect(loopLifecycleStatus(loopRun({ state: 'created', outcome: null }))).toBe('queued')
    expect(loopLifecycleStatus(loopRun({ state: 'executing', outcome: null }))).toBe('running')
    expect(loopLifecycleStatus(loopRun({ state: 'evaluating', outcome: null }))).toBe('verifying')
    expect(loopLifecycleStatus(loopRun({ state: 'reviewing', outcome: null }))).toBe('checking')
    expect(loopLifecycleStatus(loopRun({ state: 'awaiting_approval', outcome: null }))).toBe('blocked')
    expect(loopLifecycleStatus(loopRun({ state: 'paused', outcome: null }))).toBe('paused')
    expect(loopLifecycleStatus(loopRun({ state: 'finalizing', outcome: null }))).toBe('running')
  })
})

describe('fromLoopRun', () => {
  it('maps fields including recipe id, branch, cost, and PR url', () => {
    const u = fromLoopRun(loopRun())
    expect(u).toMatchObject({
      engine: 'loop',
      kind: 'ci-autorepair',
      status: 'succeeded',
      rawStatus: 'completed',
      branch: 'loop/ci',
      costUsd: 1.25,
      prUrl: 'https://github.com/acme/x/pull/9',
      sessionId: 'sess-maker',
      error: null,
    })
  })

  it('keeps the engine-native word in rawStatus and surfaces failure reasons', () => {
    const active = fromLoopRun(loopRun({ state: 'evaluating', outcome: null }))
    expect(active.status).toBe('verifying')
    expect(active.rawStatus).toBe('evaluating')

    const failed = fromLoopRun(loopRun({ state: 'done', outcome: 'failed', stateReason: 'budget exhausted' }))
    expect(failed.error).toBe('budget exhausted')
  })
})

describe('mergeRuns', () => {
  it('interleaves engines newest-first and honors the limit', () => {
    const merged = mergeRuns(
      [workflowRun({ id: 'w-old', createdAt: '2026-08-29T09:00:00.000Z' }), workflowRun({ id: 'w-new', createdAt: '2026-08-29T12:00:00.000Z' })],
      [loopRun({ id: 'g-mid', createdAt: '2026-08-29T11:00:00.000Z' })],
      2,
    )
    expect(merged.map((r) => r.id)).toEqual(['w-new', 'g-mid'])
  })

  it('breaks created-at ties deterministically', () => {
    const t = '2026-08-29T10:00:00.000Z'
    const a = mergeRuns([workflowRun({ id: 'aaa', createdAt: t })], [loopRun({ id: 'zzz', createdAt: t })], 10)
    const b = mergeRuns([workflowRun({ id: 'aaa', createdAt: t })], [loopRun({ id: 'zzz', createdAt: t })], 10)
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id))
    expect(a.map((r) => r.id)).toEqual(['zzz', 'aaa'])
  })
})
