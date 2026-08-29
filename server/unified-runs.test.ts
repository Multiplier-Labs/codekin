/** Tests for the unified run read model — field mapping, status canonicalization, and merge ordering. */
import { describe, it, expect } from 'vitest'
import { fromWorkflowRun, fromGoalRun, mergeRuns } from './unified-runs.js'
import type { WorkflowRun } from './workflow-engine.js'
import type { GoalRun } from './goal-run-store.js'

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

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    id: 'gr-1',
    kind: 'ci-autorepair',
    status: 'succeeded',
    goal: 'green',
    spec: { maker: { provider: 'claude' }, checker: null, verify: ['npm test'], maxTurns: 5, maxCostUsd: 2, completionPolicy: 'pr' },
    repo: '/srv/repos/example',
    branch: 'fix/ci',
    makerSessionId: 'sess-maker',
    checkerSessionId: null,
    turnCount: 3,
    costUsd: 1.25,
    verdict: null,
    prUrl: 'https://github.com/acme/x/pull/9',
    createdAt: '2026-08-29T11:00:00.000Z',
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

describe('fromGoalRun', () => {
  it('maps fields including branch, cost, and PR url', () => {
    const u = fromGoalRun(goalRun())
    expect(u).toMatchObject({
      engine: 'loop',
      branch: 'fix/ci',
      costUsd: 1.25,
      prUrl: 'https://github.com/acme/x/pull/9',
      sessionId: 'sess-maker',
    })
  })

  it("canonicalizes 'aborted' to 'canceled' while keeping rawStatus", () => {
    const u = fromGoalRun(goalRun({ status: 'aborted' }))
    expect(u.status).toBe('canceled')
    expect(u.rawStatus).toBe('aborted')
  })
})

describe('mergeRuns', () => {
  it('interleaves both engines newest-first and honors the limit', () => {
    const merged = mergeRuns(
      [workflowRun({ id: 'w-old', createdAt: '2026-08-29T09:00:00.000Z' }), workflowRun({ id: 'w-new', createdAt: '2026-08-29T12:00:00.000Z' })],
      [goalRun({ id: 'g-mid', createdAt: '2026-08-29T11:00:00.000Z' })],
      2,
    )
    expect(merged.map((r) => r.id)).toEqual(['w-new', 'g-mid'])
  })

  it('breaks created-at ties deterministically', () => {
    const t = '2026-08-29T10:00:00.000Z'
    const a = mergeRuns([workflowRun({ id: 'aaa', createdAt: t })], [goalRun({ id: 'zzz', createdAt: t })], 10)
    const b = mergeRuns([workflowRun({ id: 'aaa', createdAt: t })], [goalRun({ id: 'zzz', createdAt: t })], 10)
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id))
    expect(a.map((r) => r.id)).toEqual(['zzz', 'aaa'])
  })
})
