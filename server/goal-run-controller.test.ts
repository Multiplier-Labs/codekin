/** Tests for GoalRunController — drives the loop with a fake session host + verifier and asserts state transitions and the evidence ledger. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GoalRunController, type SessionHost, type VerifierApi } from './goal-run-controller.js'
import { GoalRunStore, type CreateGoalRunInput, type GoalRunSpec } from './goal-run-store.js'
import type { VerifyResult } from './verifier-runner.js'

const PASS: VerifyResult = { passed: true, results: [{ command: 'npm test', exitCode: 0, outputTail: 'ok', durationMs: 1, timedOut: false }] }
const FAIL: VerifyResult = { passed: false, results: [{ command: 'npm test', exitCode: 1, outputTail: 'FAIL a.test', durationMs: 1, timedOut: false }] }

/** Flush the controller's resolved-promise async chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

class FakeHost implements SessionHost {
  outputHistory: { type: string; data?: string; costUsd?: number }[] = []
  sent: string[] = []
  stopped: string[] = []
  worktreePath = '/wt/feat'
  private listener: ((sessionId: string, isError: boolean) => void) | null = null
  private nextId = 1
  lastSessionId = ''

  create(): { id: string } {
    this.lastSessionId = `sess-${this.nextId++}`
    return { id: this.lastSessionId }
  }
  createWorktree(): Promise<string | null> {
    return Promise.resolve(this.worktreePath)
  }
  startClaude(): boolean {
    return true
  }
  sendInput(_sessionId: string, data: string): void {
    this.sent.push(data)
  }
  stopClaude(sessionId: string): void {
    this.stopped.push(sessionId)
  }
  get(): { outputHistory: { type: string; data?: string; costUsd?: number }[]; worktreePath?: string } {
    return { outputHistory: this.outputHistory, worktreePath: this.worktreePath }
  }
  onSessionResult(listener: (sessionId: string, isError: boolean) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  /** Simulate a maker turn ending. */
  async fire(isError = false): Promise<void> {
    this.listener?.(this.lastSessionId, isError)
    await flush()
  }
}

class FakeVerifier implements VerifierApi {
  changed: string[] = ['src/a.ts']
  diff = 'src/a.ts | 2 +-'
  queue: VerifyResult[] = []
  fallback: VerifyResult = PASS
  runVerifier(): Promise<VerifyResult> {
    return Promise.resolve(this.queue.shift() ?? this.fallback)
  }
  getDiffSummary(): Promise<string> {
    return Promise.resolve(this.diff)
  }
  getChangedFiles(): Promise<string[]> {
    return Promise.resolve(this.changed)
  }
}

function spec(overrides: Partial<GoalRunSpec> = {}): GoalRunSpec {
  return {
    maker: { provider: 'claude' },
    checker: null,
    verify: ['npm test'],
    readonly: ['.github/workflows/**'],
    maxTurns: 12,
    maxCostUsd: 5,
    completionPolicy: 'pr',
    ...overrides,
  }
}

function input(s: GoalRunSpec): CreateGoalRunInput {
  return { kind: 'ci-autorepair', goal: 'make checks pass', spec: s, repo: '/repo', branch: 'fix/ci' }
}

describe('GoalRunController', () => {
  let store: GoalRunStore
  let host: FakeHost
  let verifier: FakeVerifier
  let controller: GoalRunController

  beforeEach(() => {
    store = new GoalRunStore(':memory:')
    host = new FakeHost()
    verifier = new FakeVerifier()
    controller = new GoalRunController(host, store, verifier)
  })

  afterEach(() => {
    store.close()
  })

  it('spawns a maker in a worktree and sends the goal prompt', async () => {
    const run = await controller.startRun(input(spec()))
    expect(run.status).toBe('running')
    expect(run.makerSessionId).toBe('sess-1')
    expect(host.sent[0]).toContain('# Goal Run: ci-autorepair')
    expect(host.sent[0]).toContain('make checks pass')
  })

  it('finalizes as succeeded when the verifier passes', async () => {
    const run = await controller.startRun(input(spec()))
    await host.fire()
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('succeeded')
    expect(updated?.completedAt).toBeTruthy()
    // a finalize (push + PR) instruction was sent
    expect(host.sent.some((s) => s.includes('open a pull request'))).toBe(true)
    // evidence ledger has a verifier row that passed
    const turns = store.listTurns(run.id)
    expect(turns.some((t) => t.role === 'verifier' && t.exitCode === 0)).toBe(true)
    expect(controller.activeRunIds()).toHaveLength(0)
  })

  it('feeds a verify failure back to the maker, then succeeds on the next turn', async () => {
    verifier.queue = [FAIL]
    const run = await controller.startRun(input(spec()))

    await host.fire() // turn 1 → fail
    expect(store.getRun(run.id)?.status).toBe('running')
    expect(host.sent.some((s) => s.includes('Verification failed'))).toBe(true)

    verifier.diff = 'src/a.ts | 5 +++--' // diff changed so verify re-runs (debounce miss)
    await host.fire() // turn 2 → pass (fallback)
    expect(store.getRun(run.id)?.status).toBe('succeeded')
    const failingTurn = store.listTurns(run.id).find((t) => t.role === 'verifier' && t.exitCode === 1)
    expect(failingTurn?.outputTail).toContain('FAIL a.test')
  })

  it('fails the run when the turn budget is exhausted', async () => {
    verifier.fallback = FAIL
    const run = await controller.startRun(input(spec({ maxTurns: 2 })))

    verifier.diff = 'd1'
    await host.fire() // turn 1 → fail, re-prompt
    expect(store.getRun(run.id)?.status).toBe('running')

    verifier.diff = 'd2'
    await host.fire() // turn 2 → budget exhausted
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('failed')
    expect(updated?.turnCount).toBe(2)
    expect(host.stopped).toContain('sess-1')
  })

  it('fails immediately when the cost budget is exceeded', async () => {
    const run = await controller.startRun(input(spec({ maxCostUsd: 5 })))
    host.outputHistory.push({ type: 'usage', costUsd: 6 })
    await host.fire()
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('failed')
    expect(updated?.costUsd).toBe(6)
  })

  it('re-prompts on readonly violations and escalates after repeated strikes', async () => {
    verifier.changed = ['.github/workflows/ci.yml']
    const run = await controller.startRun(input(spec({ maxTurns: 20 })))

    await host.fire() // strike 1
    await host.fire() // strike 2
    expect(store.getRun(run.id)?.status).toBe('running')
    expect(host.sent.filter((s) => s.includes('protected files')).length).toBe(2)

    await host.fire() // strike 3 → escalate
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('awaiting_human')
    expect(host.stopped).toContain('sess-1')
  })

  it('nudges and stays running when no files changed yet', async () => {
    verifier.changed = []
    const run = await controller.startRun(input(spec()))
    await host.fire()
    expect(store.getRun(run.id)?.status).toBe('running')
    expect(host.sent.some((s) => s.includes('No file changes detected'))).toBe(true)
  })
})
