/** Tests for GoalRunController — drives the loop with a fake session host + verifier and asserts state transitions and the evidence ledger. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GoalRunController, parseCheckerVerdict, type SessionHost, type VerifierApi } from './goal-run-controller.js'
import { GoalRunStore, type CreateGoalRunInput, type GoalRunSpec } from './goal-run-store.js'
import type { FinalizeOptions, FinalizeResult, FinalizerApi } from './goal-run-finalizer.js'
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
  private promptListeners: ((sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void)[] = []
  private nextId = 1
  lastSessionId = ''
  createdIds: string[] = []
  createOpts: (Record<string, unknown> | undefined)[] = []

  create(_name?: string, _dir?: string, opts?: Record<string, unknown>): { id: string } {
    this.lastSessionId = `sess-${this.nextId++}`
    this.createdIds.push(this.lastSessionId)
    this.createOpts.push(opts)
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
  onSessionPrompt(
    listener: (sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void,
  ): () => void {
    this.promptListeners.push(listener)
    return () => {
      this.promptListeners = this.promptListeners.filter((l) => l !== listener)
    }
  }
  /** Simulate a session blocking on a tool approval or question. */
  firePrompt(sessionId: string, toolName = 'Bash', requestId = `req-${sessionId}`, promptType: 'permission' | 'question' = 'permission'): void {
    for (const l of [...this.promptListeners]) l(sessionId, promptType, toolName, requestId)
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

class FakeFinalizer implements FinalizerApi {
  calls: FinalizeOptions[] = []
  result: FinalizeResult = {
    prUrl: 'https://github.com/acme/repo/pull/7',
    note: 'Verification passed; opened PR: https://github.com/acme/repo/pull/7',
  }
  finalize(opts: FinalizeOptions): Promise<FinalizeResult> {
    this.calls.push(opts)
    return Promise.resolve(this.result)
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
  let finalizer: FakeFinalizer
  let controller: GoalRunController

  beforeEach(() => {
    store = new GoalRunStore(':memory:')
    host = new FakeHost()
    verifier = new FakeVerifier()
    finalizer = new FakeFinalizer()
    controller = new GoalRunController(host, store, verifier, finalizer)
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

  it('finalizes deterministically and captures the PR url when the verifier passes', async () => {
    const run = await controller.startRun(input(spec()))
    await host.fire()
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('succeeded')
    expect(updated?.completedAt).toBeTruthy()
    // Codekin finalized deterministically: the maker was stopped and the finalizer
    // was invoked with the run's worktree, branch and completion policy.
    expect(host.stopped).toContain('sess-1')
    expect(finalizer.calls).toHaveLength(1)
    expect(finalizer.calls[0].branch).toBe('fix/ci')
    expect(finalizer.calls[0].policy).toBe('pr')
    expect(finalizer.calls[0].cwd).toBe('/wt/feat')
    // the captured PR url is persisted and the note recorded in the ledger
    expect(updated?.prUrl).toBe('https://github.com/acme/repo/pull/7')
    const turns = store.listTurns(run.id)
    expect(turns.some((t) => t.role === 'verifier' && t.exitCode === 0)).toBe(true)
    expect(turns.some((t) => t.outputTail?.includes('opened PR'))).toBe(true)
    expect(controller.activeRunIds()).toHaveLength(0)
  })

  it('still succeeds (with null prUrl) when finalization fails to open a PR', async () => {
    finalizer.result = { prUrl: null, note: 'Verification passed; branch pushed but PR creation failed: offline' }
    const run = await controller.startRun(input(spec()))
    await host.fire()
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('succeeded')
    expect(updated?.prUrl).toBeNull()
    const turns = store.listTurns(run.id)
    expect(turns.some((t) => t.outputTail?.includes('PR creation failed'))).toBe(true)
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
      expect(finalizer.calls).toHaveLength(1) // deterministic finalization ran on approve
      expect(updated?.prUrl).toBe('https://github.com/acme/repo/pull/7')
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

  describe('abortRun (Cut 4)', () => {
    it('stops the maker and marks an active run aborted', async () => {
      const run = await controller.startRun(input(spec()))
      expect(controller.activeRunIds()).toContain(run.id)

      const aborted = controller.abortRun(run.id)
      expect(aborted).toBe(true)
      expect(store.getRun(run.id)?.status).toBe('aborted')
      expect(store.getRun(run.id)?.completedAt).not.toBeNull()
      expect(host.stopped).toContain(run.makerSessionId)
      expect(controller.activeRunIds()).not.toContain(run.id)
      // An abort note is recorded in the evidence ledger.
      expect(store.listTurns(run.id).some((t) => t.outputTail === 'Run aborted by user.')).toBe(true)
    })

    it('returns false for an unknown run', () => {
      expect(controller.abortRun('does-not-exist')).toBe(false)
    })

    it('refuses to abort an already-terminal run', async () => {
      const run = await controller.startRun(input(spec()))
      host.outputHistory.push({ type: 'usage', costUsd: 0.1 })
      await host.fire() // verify passes (no checker) → succeeded
      expect(store.getRun(run.id)?.status).toBe('succeeded')

      expect(controller.abortRun(run.id)).toBe(false)
      expect(store.getRun(run.id)?.status).toBe('succeeded')
    })

    it('marks a persisted-but-inactive run aborted without a session stop', () => {
      const run = store.createRun(input(spec()))
      store.patchRun(run.id, { status: 'running' })

      const aborted = controller.abortRun(run.id)
      expect(aborted).toBe(true)
      expect(store.getRun(run.id)?.status).toBe('aborted')
      expect(host.stopped).toHaveLength(0)
    })
  })

  describe('session allowlists', () => {
    it('creates the maker with the headless-agent allowlist', async () => {
      await controller.startRun(input(spec()))
      const tools = host.createOpts[0]?.allowedTools as string[]
      expect(tools).toContain('Bash(npm:*)')
      expect(tools).toContain('Write')
    })

    it('creates the checker with a read-only allowlist', async () => {
      await controller.startRun(input(spec({ checker: { provider: 'opencode' } })))
      await host.fire() // verify passes → checker spawns
      const tools = host.createOpts[1]?.allowedTools as string[]
      expect(tools).toContain('Read')
      expect(tools).not.toContain('Write')
      expect(tools).not.toContain('Edit')
    })
  })

  describe('blocked prompts', () => {
    it('marks the run blocked with one ledger row when the maker waits on approval', async () => {
      const run = await controller.startRun(input(spec()))
      host.firePrompt('sess-1', 'Bash', 'req-1')
      host.firePrompt('sess-1', 'Bash', 'req-1') // re-broadcast on client join — deduped

      expect(store.getRun(run.id)?.status).toBe('blocked')
      const rows = store.listTurns(run.id).filter((t) => t.outputTail?.startsWith('Blocked:'))
      expect(rows).toHaveLength(1)
      expect(rows[0].role).toBe('maker')
      expect(rows[0].outputTail).toContain('Bash')
    })

    it('resumes the loop when the prompt is answered and the turn completes', async () => {
      const run = await controller.startRun(input(spec()))
      host.firePrompt('sess-1')
      expect(store.getRun(run.id)?.status).toBe('blocked')

      verifier.queue = [FAIL]
      await host.fire() // answered → turn ends → verify fails → loop continues
      expect(store.getRun(run.id)?.status).toBe('running')
    })

    it('ignores prompts from unrelated sessions', async () => {
      const run = await controller.startRun(input(spec()))
      host.firePrompt('sess-other')
      expect(store.getRun(run.id)?.status).toBe('running')
    })
  })

  describe('failInterrupted', () => {
    it('fails persisted non-terminal runs and leaves terminal + active runs alone', async () => {
      const stuck = store.createRun(input(spec()))
      store.patchRun(stuck.id, { status: 'verifying' })
      const done = store.createRun(input(spec()))
      store.patchRun(done.id, { status: 'succeeded', completedAt: new Date().toISOString() })
      const live = await controller.startRun(input(spec()))

      const failed = controller.failInterrupted()
      expect(failed).toEqual([stuck.id])
      expect(store.getRun(stuck.id)?.status).toBe('failed')
      expect(store.getRun(stuck.id)?.completedAt).not.toBeNull()
      expect(store.listTurns(stuck.id).some((t) => t.outputTail?.includes('server restart'))).toBe(true)
      expect(store.getRun(done.id)?.status).toBe('succeeded')
      expect(store.getRun(live.id)?.status).toBe('running')
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
