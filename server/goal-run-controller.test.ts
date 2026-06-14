/** Tests for GoalRunController — drives the loop with a fake session host + verifier and asserts state transitions and the evidence ledger. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GoalRunController, parseCheckerVerdict, type SessionHost, type VerifierApi } from './goal-run-controller.js'
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
  private listeners: ((sessionId: string, isError: boolean) => void)[] = []
  private nextId = 1
  lastSessionId = ''
  createdIds: string[] = []

  create(): { id: string } {
    this.lastSessionId = `sess-${this.nextId++}`
    this.createdIds.push(this.lastSessionId)
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
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }
  /** Simulate the maker (first created session) turn ending. */
  async fire(isError = false): Promise<void> {
    await this.fireSession(this.createdIds[0], isError)
  }
  /** Simulate a specific session's turn ending. */
  async fireSession(sessionId: string, isError = false): Promise<void> {
    for (const l of [...this.listeners]) l(sessionId, isError)
    await flush()
  }
}

class FakeVerifier implements VerifierApi {
  changed: string[] = ['src/a.ts']
  diff = 'src/a.ts | 2 +-'
  diffText = 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1'
  queue: VerifyResult[] = []
  fallback: VerifyResult = PASS
  runVerifier(): Promise<VerifyResult> {
    return Promise.resolve(this.queue.shift() ?? this.fallback)
  }
  getDiffSummary(): Promise<string> {
    return Promise.resolve(this.diff)
  }
  getDiff(): Promise<string> {
    return Promise.resolve(this.diffText)
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

  describe('maker–checker (Cut 2)', () => {
    const withChecker = () => spec({ checker: { provider: 'opencode' }, maxTurns: 20 })

    it('runs a second-provider checker after verify passes, then finalizes on approve', async () => {
      host.outputHistory.push({ type: 'output', data: 'Looks correct and in scope.\nVERDICT: approve' })
      const run = await controller.startRun(input(withChecker()))

      await host.fire() // maker turn 1 → verify passes → checker spawned
      expect(store.getRun(run.id)?.status).toBe('checking')
      expect(host.createdIds).toHaveLength(2)
      expect(host.sent.some((s) => s.includes('# Goal Run Review'))).toBe(true)

      await host.fireSession(host.createdIds[1]) // checker → approve
      const updated = store.getRun(run.id)
      expect(updated?.status).toBe('succeeded')
      expect(host.sent.some((s) => s.includes('open a pull request'))).toBe(true)
      expect(host.stopped).toContain(host.createdIds[1]) // checker torn down
      const checkerTurn = store.listTurns(run.id).find((t) => t.role === 'checker')
      expect(checkerTurn?.verdict).toBe('approve')
      expect(controller.activeRunIds()).toHaveLength(0)
    })

    it('feeds request_changes back to the maker and approves on the next round', async () => {
      host.outputHistory.push({ type: 'output', data: 'VERDICT: request_changes\nREASON: add a regression test' })
      const run = await controller.startRun(input(withChecker()))

      await host.fire() // maker turn 1 → verify pass → checker
      await host.fireSession(host.createdIds[1]) // checker → request_changes
      expect(store.getRun(run.id)?.status).toBe('running')
      expect(host.sent.some((s) => s.includes('add a regression test'))).toBe(true)
      expect(host.stopped).toContain(host.createdIds[1])

      verifier.diff = 'src/a.ts | 9 +++++++--' // diff changed so verify re-runs
      host.outputHistory.push({ type: 'output', data: 'Now correct.\nVERDICT: approve' })
      await host.fire() // maker turn 2 → verify pass → new checker
      expect(host.createdIds).toHaveLength(3)
      await host.fireSession(host.createdIds[2]) // checker → approve
      expect(store.getRun(run.id)?.status).toBe('succeeded')
    })

    it('escalates to a human on an escalate verdict', async () => {
      host.outputHistory.push({ type: 'output', data: 'VERDICT: escalate\nREASON: risky data migration' })
      const run = await controller.startRun(input(spec({ checker: { provider: 'codex' } })))

      await host.fire()
      await host.fireSession(host.createdIds[1])
      const updated = store.getRun(run.id)
      expect(updated?.status).toBe('awaiting_human')
      expect(host.stopped).toContain(host.createdIds[0]) // maker stopped
    })

    it('escalates when the checker verdict cannot be parsed', async () => {
      host.outputHistory.push({ type: 'output', data: 'I am not really sure about this change.' })
      const run = await controller.startRun(input(withChecker()))

      await host.fire()
      await host.fireSession(host.createdIds[1])
      expect(store.getRun(run.id)?.status).toBe('awaiting_human')
      const checkerTurn = store.listTurns(run.id).find((t) => t.role === 'checker')
      expect(checkerTurn?.verdict).toBeNull()
    })
  })
})

describe('parseCheckerVerdict', () => {
  it('parses a trailing verdict line with a reason', () => {
    expect(parseCheckerVerdict('Some review.\nVERDICT: request_changes\nREASON: missing test')).toEqual({
      verdict: 'request_changes',
      reason: 'missing test',
    })
  })

  it('takes the last verdict when instructions are echoed', () => {
    const text = 'Options: VERDICT: approve, VERDICT: escalate.\n\nMy decision:\nVERDICT: approve'
    expect(parseCheckerVerdict(text)).toEqual({ verdict: 'approve' })
  })

  it('returns null when no verdict marker is present', () => {
    expect(parseCheckerVerdict('looks fine to me')).toBeNull()
  })
})
