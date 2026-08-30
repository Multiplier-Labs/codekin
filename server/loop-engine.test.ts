import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LoopEngine, buildMakerPrompt, type SessionHost, type LoopEvaluatorApi, type StartLoopRunInput } from './loop-engine.js'
import { LoopStore } from './loop-store.js'
import { LoopArtifactStore } from './loop-artifacts.js'
import { parseLoopRecipe, type LoopRecipe } from './loop-recipe.js'
import type { CommandEvaluationOutcome } from './loop-evaluators.js'
import type { CommandEvaluatorConfig } from './loop-recipe.js'
import type { FinalizeResult, LoopFinalizerApi } from './loop-finalizer.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSession {
  id: string
  name: string
  workingDir: string
  provider?: string
  allowedTools?: string[]
  inputs: string[]
  outputHistory: Array<{ type: string; data?: string; costUsd?: number }>
  started: boolean
  stopped: boolean
}

class FakeHost implements SessionHost {
  sessions = new Map<string, FakeSession>()
  private resultListeners: Array<(sid: string, isError: boolean) => void> = []
  private promptListeners: Array<
    (sid: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void
  > = []
  private counter = 0

  constructor(private readonly worktreeRoot: string) {}

  create(name: string, workingDir: string, options?: { provider?: string; allowedTools?: string[] }): { id: string } {
    const id = `sess-${++this.counter}`
    this.sessions.set(id, {
      id,
      name,
      workingDir,
      provider: options?.provider,
      allowedTools: options?.allowedTools,
      inputs: [],
      outputHistory: [],
      started: false,
      stopped: false,
    })
    return { id }
  }

  async createWorktree(sessionId: string): Promise<string | null> {
    const dir = join(this.worktreeRoot, sessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  startClaude(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (s) s.started = true
    return true
  }

  sendInput(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.inputs.push(data)
  }

  stopClaude(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.stopped = true
  }

  get(sessionId: string): FakeSession | undefined {
    return this.sessions.get(sessionId)
  }

  onSessionResult(listener: (sid: string, isError: boolean) => void): () => void {
    this.resultListeners.push(listener)
    return () => {
      this.resultListeners = this.resultListeners.filter((l) => l !== listener)
    }
  }

  onSessionPrompt(
    listener: (sid: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void,
  ): () => void {
    this.promptListeners.push(listener)
    return () => {
      this.promptListeners = this.promptListeners.filter((l) => l !== listener)
    }
  }

  emitResult(sessionId: string, isError = false): void {
    for (const l of [...this.resultListeners]) l(sessionId, isError)
  }

  emitPrompt(sessionId: string, toolName: string, requestId: string): void {
    for (const l of [...this.promptListeners]) l(sessionId, 'permission', toolName, requestId)
  }

  lastSession(): FakeSession {
    return [...this.sessions.values()][this.sessions.size - 1]
  }
}

function pass(config: CommandEvaluatorConfig): CommandEvaluationOutcome {
  const command = Array.isArray(config.command) ? config.command.join(' ') : config.command
  return {
    evaluatorId: config.id,
    status: 'pass',
    classification: null,
    summary: `\`${command}\` passed`,
    outputTail: 'ok',
    fullOutput: 'ok',
    command,
    exitCode: 0,
    fingerprint: null,
    retryable: false,
    durationMs: 5,
    timedOut: false,
  }
}

function fail(config: CommandEvaluatorConfig, fingerprint = 'fp-1'): CommandEvaluationOutcome {
  return { ...pass(config), status: 'fail', classification: 'code', summary: 'tests failed', exitCode: 1, fingerprint, outputTail: 'FAIL x' }
}

function envError(config: CommandEvaluatorConfig): CommandEvaluationOutcome {
  return { ...fail(config, 'fp-env'), status: 'error', classification: 'environment', retryable: true, summary: 'timed out' }
}

class FakeEval implements LoopEvaluatorApi {
  /** Next command outcomes, shifted per call; empty = pass. */
  commandQueue: CommandEvaluationOutcome[] = []
  changedFiles: string[] = ['src/x.ts']
  diffSummary = ' 1 file changed'
  diffText = 'diff --git a/src/x.ts b/src/x.ts'
  commandCalls = 0

  runCommandEvaluator = async (config: CommandEvaluatorConfig): Promise<CommandEvaluationOutcome> => {
    this.commandCalls += 1
    return this.commandQueue.shift() ?? pass(config)
  }
  runTestReportEvaluator = async (config: { id: string; command: string | string[] }): Promise<CommandEvaluationOutcome> => {
    this.commandCalls += 1
    return this.commandQueue.shift() ?? pass(config as CommandEvaluatorConfig)
  }
  getDiffSummary = async () => this.diffSummary
  getDiff = async () => this.diffText
  getChangedFiles = async () => this.changedFiles
  revParseHead = async () => 'base-sha-1'
}

class FakeFinalizer implements LoopFinalizerApi {
  calls: Array<{ branch: string; action: string }> = []
  result: FinalizeResult = { prUrl: 'https://github.com/x/y/pull/1', note: 'opened PR', clean: true }
  async finalize(opts: { branch: string; action: string }): Promise<FinalizeResult> {
    this.calls.push({ branch: opts.branch, action: opts.action })
    return this.result
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function recipeFromYaml(opts: {
  mode?: string
  rubric?: boolean
  turns?: number
  costUsd?: number
  noProgressAttempts?: number
  protectedPaths?: string[]
  retryMaxAttempts?: number
  planRequired?: boolean
} = {}): LoopRecipe {
  const md = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-repair, name: Repair CI }
agent: { provider: claude }
workspace:
  protectedPaths: [${(opts.protectedPaths ?? []).map((p) => JSON.stringify(p)).join(', ')}]
plan: { required: ${opts.planRequired ?? false} }
evaluators:
  - id: tests
    type: command
    command: npm test
${opts.retryMaxAttempts ? `    retry: { maxAttempts: ${opts.retryMaxAttempts} }\n` : ''}${
    opts.rubric ? `  - { id: review, type: rubric, provider: different-from-maker }\n` : ''
  }budgets: { turns: ${opts.turns ?? 6}, costUsd: ${opts.costUsd ?? 10}, noProgressAttempts: ${opts.noProgressAttempts ?? 3} }
policy: { mode: ${opts.mode ?? 'guarded'} }
---
Fix the failing CI.
`
  return parseLoopRecipe(md, '/x/ci-repair.md', 'builtin')
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('LoopEngine', () => {
  let root: string
  let repo: string
  let host: FakeHost
  let store: LoopStore
  let evalApi: FakeEval
  let finalizer: FakeFinalizer
  let engine: LoopEngine

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codekin-engine-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    host = new FakeHost(join(root, 'wt'))
    store = new LoopStore(':memory:')
    evalApi = new FakeEval()
    finalizer = new FakeFinalizer()
    engine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  function input(recipe: LoopRecipe): StartLoopRunInput {
    return { recipe, goal: recipe.outcome, repo, branch: 'loop/ci-1', provider: 'claude' }
  }

  async function startAndTurn(recipe: LoopRecipe): Promise<string> {
    const run = await engine.startRun(input(recipe))
    host.emitResult(store.getRun(run.id)!.makerSessionId!)
    await settle()
    return run.id
  }

  it('happy path: preflight → act → evaluate pass → finalize → completed', async () => {
    const run = await engine.startRun(input(recipeFromYaml()))
    expect(store.getRun(run.id)?.baseSha).toBe('base-sha-1')
    const maker = host.get(store.getRun(run.id)!.makerSessionId!)!
    expect(maker.started).toBe(true)
    expect(maker.inputs[0]).toContain('## Outcome')
    expect(maker.inputs[0]).toContain('`npm test`')

    host.emitResult(maker.id)
    await settle()

    const final = store.getRun(run.id)!
    expect(final.state).toBe('done')
    expect(final.outcome).toBe('completed')
    expect(final.prUrl).toBe('https://github.com/x/y/pull/1')
    expect(finalizer.calls).toEqual([{ branch: 'loop/ci-1', action: 'pull-request' }])
    expect(store.listEvaluations(run.id)).toHaveLength(1)
    expect(store.listArtifacts(run.id)).toHaveLength(1)
    const types = store.listEvents(run.id).map((e) => e.type)
    expect(types).toContain('preflight_completed')
    expect(types).toContain('evaluation_completed')
    expect(types).toContain('finalized')
    expect(types).toContain('run_completed')
  })

  it('failed evaluation feeds output back to the maker, then completes on the next turn', async () => {
    const recipe = recipeFromYaml()
    evalApi.commandQueue = [fail(recipe.evaluators[0] as CommandEvaluatorConfig)]
    const runId = await startAndTurn(recipe)

    const run = store.getRun(runId)!
    expect(run.state).toBe('executing')
    const maker = host.get(run.makerSessionId!)!
    expect(maker.inputs[1]).toContain('Evaluation failed')
    expect(maker.inputs[1]).toContain('FAIL x')

    evalApi.diffSummary = ' 2 files changed'
    host.emitResult(maker.id)
    await settle()
    expect(store.getRun(runId)!.outcome).toBe('completed')
    expect(store.getRun(runId)!.turnCount).toBe(2)
  })

  it('retries a transient environment error within the same turn', async () => {
    const recipe = recipeFromYaml({ retryMaxAttempts: 2 })
    evalApi.commandQueue = [envError(recipe.evaluators[0] as CommandEvaluatorConfig)]
    const runId = await startAndTurn(recipe)
    expect(store.getRun(runId)!.outcome).toBe('completed')
    expect(evalApi.commandCalls).toBe(2)
    expect(store.listEvaluations(runId).map((e) => e.status)).toEqual(['error', 'pass'])
  })

  it('no material progress escalates after the configured attempts', async () => {
    const recipe = recipeFromYaml({ noProgressAttempts: 2 })
    const tests = recipe.evaluators[0] as CommandEvaluatorConfig
    evalApi.commandQueue = [fail(tests, 'same-fp'), fail(tests, 'same-fp'), fail(tests, 'same-fp')]
    const runId = await startAndTurn(recipe)
    const maker = host.get(store.getRun(runId)!.makerSessionId!)!

    host.emitResult(maker.id) // same diff, same fingerprint → noProgress 1
    await settle()
    expect(host.get(store.getRun(runId)!.makerSessionId!)!.inputs.at(-1)).toContain('different approach')
    host.emitResult(maker.id) // noProgress 2 → escalate
    await settle()

    const run = store.getRun(runId)!
    expect(run.state).toBe('awaiting_approval')
    const [iv] = store.listInterventions(runId, 'pending')
    expect(iv.purpose).toBe('escalation')
    expect(iv.body).toContain('No material progress')
  })

  it('protected-path violations feed back, then escalate after repeated strikes', async () => {
    const recipe = recipeFromYaml({ protectedPaths: ['.github/**'] })
    evalApi.changedFiles = ['.github/workflows/ci.yml']
    const runId = await startAndTurn(recipe)
    const maker = host.get(store.getRun(runId)!.makerSessionId!)!
    expect(maker.inputs.at(-1)).toContain('protected files')

    host.emitResult(maker.id)
    await settle()
    host.emitResult(maker.id)
    await settle()
    expect(store.getRun(runId)!.state).toBe('awaiting_approval')
    expect(store.listInterventions(runId, 'pending')[0].body).toContain('protected paths')
  })

  it('escalation resolved with continue restarts the maker with guidance; stop cancels', async () => {
    const recipe = recipeFromYaml({ protectedPaths: ['.github/**'] })
    evalApi.changedFiles = ['.github/workflows/ci.yml']
    const runId = await startAndTurn(recipe)
    for (let i = 0; i < 2; i++) {
      host.emitResult(store.getRun(runId)!.makerSessionId!)
      await settle()
    }
    const [iv] = store.listInterventions(runId, 'pending')

    expect(await engine.resolveIntervention(iv.id, 'continue', 'revert the workflow change')).toBe(true)
    await settle()
    const resumed = store.getRun(runId)!
    expect(resumed.state).toBe('executing')
    const newMaker = host.get(resumed.makerSessionId!)!
    expect(newMaker.inputs[0]).toContain('chose to continue')
    expect(newMaker.inputs[0]).toContain('revert the workflow change')

    // Second escalation → stop.
    evalApi.changedFiles = ['.github/workflows/ci.yml']
    for (let i = 0; i < 3; i++) {
      host.emitResult(store.getRun(runId)!.makerSessionId!)
      await settle()
    }
    const pending = store.listInterventions(runId, 'pending')
    expect(await engine.resolveIntervention(pending[0].id, 'stop')).toBe(true)
    await settle()
    expect(store.getRun(runId)!.outcome).toBe('canceled')
  })

  it('budget boundary asks for an extension in guarded mode; extend continues, stop fails', async () => {
    const recipe = recipeFromYaml({ turns: 1 })
    const tests = recipe.evaluators[0] as CommandEvaluatorConfig
    evalApi.commandQueue = [fail(tests)]
    const runId = await startAndTurn(recipe)
    // Turn 1 consumed the budget; next turn hits the boundary.
    host.emitResult(store.getRun(runId)!.makerSessionId!)
    await settle()

    expect(store.getRun(runId)!.state).toBe('awaiting_approval')
    const [iv] = store.listInterventions(runId, 'pending')
    expect(iv.purpose).toBe('budget-extension')

    expect(await engine.resolveIntervention(iv.id, 'extend')).toBe(true)
    await settle()
    expect(store.getRun(runId)!.state).toBe('executing')

    // Exhaust again (extension added ceil(1*0.5)=1 turn → boundary on next turn).
    evalApi.commandQueue = [fail(tests)]
    host.emitResult(store.getRun(runId)!.makerSessionId!)
    await settle()
    const second = store.listInterventions(runId, 'pending')
    expect(second).toHaveLength(1)
    expect(await engine.resolveIntervention(second[0].id, 'stop')).toBe(true)
    expect(store.getRun(runId)!.outcome).toBe('failed')
  })

  it('autonomous mode stops with a partial result at the budget boundary', async () => {
    const recipe = recipeFromYaml({ mode: 'autonomous', turns: 1 })
    evalApi.commandQueue = [fail(recipe.evaluators[0] as CommandEvaluatorConfig)]
    const runId = await startAndTurn(recipe)
    host.emitResult(store.getRun(runId)!.makerSessionId!)
    await settle()
    const run = store.getRun(runId)!
    expect(run.outcome).toBe('failed')
    expect(run.stateReason).toContain('partial result')
    expect(store.listInterventions(runId)).toHaveLength(0)
  })

  it('guided mode gates completion behind an approval; approve finalizes', async () => {
    const runId = await startAndTurn(recipeFromYaml({ mode: 'guided' }))
    expect(store.getRun(runId)!.state).toBe('awaiting_approval')
    const [iv] = store.listInterventions(runId, 'pending')
    expect(iv.purpose).toBe('completion-approval')
    expect(finalizer.calls).toHaveLength(0)

    expect(await engine.resolveIntervention(iv.id, 'approve')).toBe(true)
    await settle()
    expect(store.getRun(runId)!.outcome).toBe('completed')
    expect(finalizer.calls).toHaveLength(1)
  })

  it('guided rejection feeds the note back and re-enters the loop', async () => {
    const runId = await startAndTurn(recipeFromYaml({ mode: 'guided' }))
    const [iv] = store.listInterventions(runId, 'pending')
    expect(await engine.resolveIntervention(iv.id, 'reject', 'also fix the flaky test')).toBe(true)
    await settle()
    const run = store.getRun(runId)!
    expect(run.state).toBe('executing')
    expect(host.get(run.makerSessionId!)!.inputs[0]).toContain('also fix the flaky test')
  })

  it('rejects a resolution choice outside the offered options', async () => {
    const runId = await startAndTurn(recipeFromYaml({ mode: 'guided' }))
    const [iv] = store.listInterventions(runId, 'pending')
    expect(await engine.resolveIntervention(iv.id, 'merge-it')).toBe(false)
    expect(store.getIntervention(iv.id)?.status).toBe('pending')
  })

  it('rubric review: approve finalizes; the reviewer is a different provider and read-only', async () => {
    const runId = await startAndTurn(recipeFromYaml({ rubric: true }))
    const run = store.getRun(runId)!
    expect(run.state).toBe('reviewing')
    const reviewer = host.lastSession()
    expect(reviewer.provider).toBe('codex')
    expect(reviewer.inputs[0]).toContain('## Diff')
    expect(reviewer.allowedTools).not.toContain('Write')

    reviewer.outputHistory.push({ type: 'output', data: 'Looks solid.\nVERDICT: approve' })
    host.emitResult(reviewer.id)
    await settle()
    expect(store.getRun(runId)!.outcome).toBe('completed')
    expect(store.listEvaluations(runId).map((e) => e.status)).toEqual(['pass', 'pass'])
  })

  it('rubric request_changes feeds review back to the maker', async () => {
    const runId = await startAndTurn(recipeFromYaml({ rubric: true }))
    const reviewer = host.lastSession()
    reviewer.outputHistory.push({ type: 'output', data: 'VERDICT: request_changes\nREASON: tests were weakened' })
    host.emitResult(reviewer.id)
    await settle()
    const run = store.getRun(runId)!
    expect(run.state).toBe('executing')
    expect(host.get(run.makerSessionId!)!.inputs.at(-1)).toContain('tests were weakened')
    expect(reviewer.stopped).toBe(true)
  })

  it('rubric escalate (and unparseable verdicts) create an intervention', async () => {
    const runId = await startAndTurn(recipeFromYaml({ rubric: true }))
    const reviewer = host.lastSession()
    reviewer.outputHistory.push({ type: 'output', data: 'hard to say!' })
    host.emitResult(reviewer.id)
    await settle()
    expect(store.getRun(runId)!.state).toBe('awaiting_approval')
    expect(store.listInterventions(runId, 'pending')[0].purpose).toBe('escalation')
  })

  it('pause parks durably and resume continues in the same worktree with a fresh session', async () => {
    const run = await engine.startRun(input(recipeFromYaml()))
    const first = store.getRun(run.id)!
    const worktree = first.worktreePath!
    expect(engine.pause(run.id)).toBe(true)
    expect(store.getRun(run.id)!.state).toBe('paused')
    expect(host.get(first.makerSessionId!)!.stopped).toBe(true)

    engine.steer(run.id, 'prefer a config-level fix')
    expect(await engine.resume(run.id)).toBe(true)
    await settle()
    const resumed = store.getRun(run.id)!
    expect(resumed.state).toBe('executing')
    expect(resumed.makerSessionId).not.toBe(first.makerSessionId)
    expect(resumed.worktreePath).toBe(worktree)
    const maker = host.get(resumed.makerSessionId!)!
    expect(maker.workingDir).toBe(worktree)
    expect(maker.inputs[0]).toContain('Resuming after a pause')
    expect(maker.inputs[0]).toContain('prefer a config-level fix')
  })

  it('steer during an active run is delivered at the next boundary', async () => {
    const recipe = recipeFromYaml()
    evalApi.commandQueue = [fail(recipe.evaluators[0] as CommandEvaluatorConfig)]
    const run = await engine.startRun(input(recipe))
    engine.steer(run.id, 'focus on the auth module')
    host.emitResult(store.getRun(run.id)!.makerSessionId!)
    await settle()
    expect(host.get(store.getRun(run.id)!.makerSessionId!)!.inputs.at(-1)).toContain('Operator instruction: focus on the auth module')
  })

  it('cancel stops sessions, cancels pending interventions, and is terminal', async () => {
    const runId = await startAndTurn(recipeFromYaml({ mode: 'guided' }))
    expect(store.listInterventions(runId, 'pending')).toHaveLength(1)
    expect(engine.cancel(runId)).toBe(true)
    const run = store.getRun(runId)!
    expect(run.state).toBe('done')
    expect(run.outcome).toBe('canceled')
    expect(store.listInterventions(runId, 'pending')).toHaveLength(0)
    expect(engine.cancel(runId)).toBe(false)
  })

  it('session prompts surface as a state reason and event, deduped per request', async () => {
    const run = await engine.startRun(input(recipeFromYaml()))
    const maker = store.getRun(run.id)!.makerSessionId!
    host.emitPrompt(maker, 'Bash', 'req-1')
    host.emitPrompt(maker, 'Bash', 'req-1')
    expect(store.getRun(run.id)!.stateReason).toContain('waiting on approval for Bash')
    expect(store.listEvents(run.id).filter((e) => e.type === 'session_blocked')).toHaveLength(1)
  })

  it('preflight fails cleanly for a missing repo', async () => {
    const recipe = recipeFromYaml()
    const run = await engine.startRun({ recipe, goal: recipe.outcome, repo: join(root, 'nope'), branch: 'b', provider: 'claude' })
    expect(run.state).toBe('done')
    expect(run.outcome).toBe('failed')
    expect(run.stateReason).toContain('Preflight failed')
  })

  describe('recovery', () => {
    it('leaves durable wait states waiting, resumes interrupted runs, fails unrecoverable ones', async () => {
      // Interrupted mid-execution with a surviving worktree.
      const interrupted = await engine.startRun(input(recipeFromYaml()))
      // Simulate a restart: drop live contexts without touching the store.
      const freshEngine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer)

      // Paused run — must be left alone.
      const paused = await engine.startRun(input(recipeFromYaml()))
      engine.pause(paused.id)

      // Unrecoverable: worktree deleted.
      const broken = await engine.startRun(input(recipeFromYaml()))
      rmSync(store.getRun(broken.id)!.worktreePath!, { recursive: true, force: true })

      const summary = await freshEngine.recoverAll()
      expect(summary.waiting).toContain(paused.id)
      expect(summary.resumed).toContain(interrupted.id)
      expect(summary.failed).toContain(broken.id)

      expect(store.getRun(paused.id)!.state).toBe('paused')
      const resumed = store.getRun(interrupted.id)!
      expect(resumed.state).toBe('executing')
      expect(host.get(resumed.makerSessionId!)!.inputs[0]).toContain('restarted while this run was in flight')
      const failed = store.getRun(broken.id)!
      expect(failed.outcome).toBe('failed')
      expect(failed.stateReason).toContain('no longer available')
    })

    it('restores checkpointed counters so budgets survive a restart', async () => {
      const recipe = recipeFromYaml({ turns: 3 })
      const tests = recipe.evaluators[0] as CommandEvaluatorConfig
      evalApi.commandQueue = [fail(tests)]
      const runId = await startAndTurn(recipe) // turn 1 checkpointed

      const freshEngine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer)
      await freshEngine.recoverAll()
      const resumed = store.getRun(runId)!
      expect(resumed.state).toBe('executing')
      // Two more failing turns reach the 3-turn budget (1 survived the restart).
      evalApi.commandQueue = [fail(tests, 'fp-a'), fail(tests, 'fp-b')]
      evalApi.diffSummary = ' 2 files changed'
      host.emitResult(resumed.makerSessionId!)
      await settle()
      evalApi.diffSummary = ' 3 files changed'
      host.emitResult(store.getRun(runId)!.makerSessionId!)
      await settle()
      expect(store.listInterventions(runId, 'pending')[0]?.purpose).toBe('budget-extension')
    })

    it('re-runs finalize for a run interrupted while finalizing', async () => {
      const runId = await startAndTurn(recipeFromYaml())
      expect(store.getRun(runId)!.outcome).toBe('completed')
      // Rewind the run to `finalizing` as if the crash hit mid-finalize.
      store.patchRun(runId, { state: 'finalizing', outcome: null, completedAt: null })

      const freshEngine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer)
      const summary = await freshEngine.recoverAll()
      expect(summary.resumed).toContain(runId)
      expect(store.getRun(runId)!.outcome).toBe('completed')
      expect(finalizer.calls.length).toBe(2) // idempotent by design
    })
  })

  describe('plan stage', () => {
    it('guarded mode: plan is captured as an artifact, then the same session executes', async () => {
      const run = await engine.startRun(input(recipeFromYaml({ planRequired: true })))
      expect(store.getRun(run.id)!.state).toBe('planning')
      const maker = host.get(store.getRun(run.id)!.makerSessionId!)!
      expect(maker.inputs[0]).toContain('plan only')
      expect(maker.inputs[0]).toContain('Do NOT modify any files yet')

      maker.outputHistory.push({ type: 'output', data: '1. Fix the flaky mock in x.test.ts\n2. Run the suite' })
      host.emitResult(maker.id)
      await settle()

      // Plan retained, same session moved on to execution.
      const plans = store.listArtifacts(run.id).filter((a) => a.kind === 'plan')
      expect(plans).toHaveLength(1)
      expect(store.getRun(run.id)!.state).toBe('executing')
      expect(maker.inputs.at(-1)).toContain('Execute it now')
      expect(store.listStages(run.id).map((s) => s.kind)).toContain('plan')

      // Next turn evaluates and completes as usual.
      host.emitResult(maker.id)
      await settle()
      expect(store.getRun(run.id)!.outcome).toBe('completed')
    })

    it('guided mode gates on plan approval; approve resumes with the plan in context', async () => {
      const run = await engine.startRun(input(recipeFromYaml({ planRequired: true, mode: 'guided' })))
      const maker = host.get(store.getRun(run.id)!.makerSessionId!)!
      maker.outputHistory.push({ type: 'output', data: 'Step 1: edit parser.ts' })
      host.emitResult(maker.id)
      await settle()

      expect(store.getRun(run.id)!.state).toBe('awaiting_approval')
      const [iv] = store.listInterventions(run.id, 'pending')
      expect(iv.purpose).toBe('plan-approval')
      expect(iv.body).toContain('Step 1: edit parser.ts')
      expect(iv.options).toEqual(['approve', 'revise', 'stop'])

      expect(await engine.resolveIntervention(iv.id, 'approve')).toBe(true)
      await settle()
      const resumed = store.getRun(run.id)!
      expect(resumed.state).toBe('executing')
      const fresh = host.get(resumed.makerSessionId!)!
      expect(fresh.inputs[0]).toContain('plan was approved')
      expect(fresh.inputs[0]).toContain('Step 1: edit parser.ts')
    })

    it('guided revise returns to planning with the note and previous plan', async () => {
      const run = await engine.startRun(input(recipeFromYaml({ planRequired: true, mode: 'guided' })))
      const maker = host.get(store.getRun(run.id)!.makerSessionId!)!
      maker.outputHistory.push({ type: 'output', data: 'Plan v1' })
      host.emitResult(maker.id)
      await settle()
      const [iv] = store.listInterventions(run.id, 'pending')

      expect(await engine.resolveIntervention(iv.id, 'revise', 'cover the edge case too')).toBe(true)
      await settle()
      const revised = store.getRun(run.id)!
      expect(revised.state).toBe('planning')
      const fresh = host.get(revised.makerSessionId!)!
      expect(fresh.inputs[0]).toContain('plan only')
      expect(fresh.inputs[0]).toContain('cover the edge case too')
      expect(fresh.inputs[0]).toContain('Plan v1')
    })

    it('planning survives a restart and resumes in the planning phase', async () => {
      const run = await engine.startRun(input(recipeFromYaml({ planRequired: true })))
      expect(store.getRun(run.id)!.state).toBe('planning')

      const freshEngine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer)
      const summary = await freshEngine.recoverAll()
      expect(summary.resumed).toContain(run.id)
      const resumed = store.getRun(run.id)!
      expect(resumed.state).toBe('planning')
      expect(host.get(resumed.makerSessionId!)!.inputs[0]).toContain('plan only')
    })

    it('steer with revisePlan asks for a plan revision at the next boundary', async () => {
      const recipe = recipeFromYaml()
      evalApi.commandQueue = [fail(recipe.evaluators[0] as CommandEvaluatorConfig)]
      const run = await engine.startRun(input(recipe))
      engine.steer(run.id, 'use the config-level fix', true)
      host.emitResult(store.getRun(run.id)!.makerSessionId!)
      await settle()
      const maker = host.get(store.getRun(run.id)!.makerSessionId!)!
      expect(maker.inputs.at(-1)).toContain('revise your plan')
      expect(maker.inputs.at(-1)).toContain('use the config-level fix')
    })
  })

  describe('phase 3 evaluators', () => {
    /** Recipe with an arbitrary evaluator block (YAML list entries). */
    function recipeWithEvaluators(evaluatorYaml: string, mode = 'guarded'): LoopRecipe {
      const md = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-repair, name: Repair CI }
agent: { provider: claude }
evaluators:
${evaluatorYaml}
budgets: { turns: 6, costUsd: 10 }
policy: { mode: ${mode} }
---
Fix the failing CI.
`
      return parseLoopRecipe(md, '/x/ci-repair.md', 'builtin')
    }

    it('diff-policy failure is fed back with the violations', async () => {
      const recipe = recipeWithEvaluators(
        ['  - { id: tests, type: command, command: npm test }', '  - { id: scope, type: diff-policy, forbidPaths: ["dist/**"] }'].join('\n'),
      )
      evalApi.changedFiles = ['src/x.ts', 'dist/bundle.js']
      const runId = await startAndTurn(recipe)
      const run = store.getRun(runId)!
      expect(run.state).toBe('executing') // fed back, not completed
      const maker = host.get(run.makerSessionId!)!
      expect(maker.inputs.at(-1)).toContain('forbidden-path')
      const scope = store.listEvaluations(runId).find((e) => e.evaluatorId === 'scope')
      expect(scope).toMatchObject({ status: 'fail', classification: 'policy' })
    })

    it('artifact evaluator requires the file to exist in the worktree', async () => {
      const recipe = recipeWithEvaluators(
        ['  - { id: tests, type: command, command: npm test }', '  - { id: report, type: artifact, path: "out/report.md" }'].join('\n'),
      )
      const runId = await startAndTurn(recipe)
      expect(store.getRun(runId)!.state).toBe('executing')
      expect(host.get(store.getRun(runId)!.makerSessionId!)!.inputs.at(-1)).toContain('required artifact missing')

      // Produce the artifact in the worktree → next cycle completes.
      const cwd = store.getRun(runId)!.worktreePath!
      mkdirSync(join(cwd, 'out'), { recursive: true })
      const { writeFileSync } = await import('fs')
      writeFileSync(join(cwd, 'out', 'report.md'), '# report body')
      evalApi.diffSummary = ' 2 files changed'
      host.emitResult(store.getRun(runId)!.makerSessionId!)
      await settle()
      expect(store.getRun(runId)!.outcome).toBe('completed')
    })

    it('human evaluator gates completion; waive completes with warnings; fail feeds back', async () => {
      const recipe = recipeWithEvaluators(
        ['  - { id: tests, type: command, command: npm test }', '  - { id: signoff, type: human, title: "Read well?" }'].join('\n'),
      )
      const runId = await startAndTurn(recipe)
      expect(store.getRun(runId)!.state).toBe('awaiting_approval')
      const [iv] = store.listInterventions(runId, 'pending')
      expect(iv.purpose).toBe('human-evaluation:signoff')
      expect(iv.options).toEqual(['pass', 'waive', 'fail'])
      expect(finalizer.calls).toHaveLength(0)

      // fail → note goes back to the maker
      expect(await engine.resolveIntervention(iv.id, 'fail', 'tighten the wording')).toBe(true)
      await settle()
      const run = store.getRun(runId)!
      expect(run.state).toBe('executing')
      expect(host.get(run.makerSessionId!)!.inputs[0]).toContain('tighten the wording')

      // next cycle → waive → completed with warnings
      evalApi.diffSummary = ' 2 files changed'
      host.emitResult(run.makerSessionId!)
      await settle()
      const [iv2] = store.listInterventions(runId, 'pending')
      expect(await engine.resolveIntervention(iv2.id, 'waive')).toBe(true)
      await settle()
      const done = store.getRun(runId)!
      expect(done.outcome).toBe('completed_with_warnings')
      expect(done.stateReason).toContain('signoff')
    })

    it('a required composite over a failed optional evaluator blocks completion', async () => {
      const recipe = recipeWithEvaluators(
        [
          '  - { id: tests, type: command, command: npm test }',
          '  - { id: lint, type: command, command: npm run lint, required: false }',
          '  - { id: gate, type: composite, op: all, of: [tests, lint] }',
        ].join('\n'),
      )
      const tests = recipe.evaluators[0] as CommandEvaluatorConfig
      const lint = recipe.evaluators[1] as CommandEvaluatorConfig
      evalApi.commandQueue = [pass(tests), fail(lint, 'lint-fp')]
      const runId = await startAndTurn(recipe)
      const run = store.getRun(runId)!
      expect(run.state).toBe('executing')
      expect(host.get(run.makerSessionId!)!.inputs.at(-1)).toContain('composite "gate"')
      expect(store.listEvaluations(runId).find((e) => e.evaluatorId === 'gate')?.status).toBe('fail')

      evalApi.diffSummary = ' 2 files changed'
      host.emitResult(run.makerSessionId!)
      await settle()
      expect(store.getRun(runId)!.outcome).toBe('completed')
    })

    describe('ci monitoring', () => {
      function ciRecipe(): LoopRecipe {
        return recipeWithEvaluators(
          ['  - { id: tests, type: command, command: npm test }', '  - { id: checks, type: ci, checks: ["test-and-lint"], timeout: 1m }'].join('\n'),
        )
      }

      it('green checks finish the run after finalize', async () => {
        const ci = { checkStatus: vi.fn(async () => [{ name: 'test-and-lint', status: 'pass' as const }]) }
        engine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer, ci)
        engine.ciPollMs = 5
        const runId = await startAndTurn(ciRecipe())
        await settle()
        const run = store.getRun(runId)!
        expect(run.outcome).toBe('completed')
        expect(run.stateReason).toContain('CI green')
        expect(store.listEvaluations(runId).find((e) => e.evaluatorId === 'checks')?.status).toBe('pass')
        expect(ci.checkStatus).toHaveBeenCalled()
      })

      it('a red required check feeds back into the loop and the next pass completes', async () => {
        let calls = 0
        const ci = {
          checkStatus: vi.fn(async () => [{ name: 'test-and-lint', status: (calls++ === 0 ? 'fail' : 'pass') as 'fail' | 'pass' }]),
        }
        engine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer, ci)
        engine.ciPollMs = 5
        const runId = await startAndTurn(ciRecipe())
        await settle()

        // Red CI → maker restarted with the failing check names.
        const run = store.getRun(runId)!
        expect(run.state).toBe('executing')
        const maker = host.get(run.makerSessionId!)!
        expect(maker.inputs[0]).toContain('Remote CI checks failed')
        expect(maker.inputs[0]).toContain('test-and-lint')

        evalApi.diffSummary = ' 2 files changed'
        host.emitResult(run.makerSessionId!)
        await settle(10)
        expect(store.getRun(runId)!.outcome).toBe('completed')
        expect(finalizer.calls).toHaveLength(2)
      })

      it('pending checks past the timeout ask the operator; finish yields a qualified outcome', async () => {
        const ci = { checkStatus: vi.fn(async () => [{ name: 'test-and-lint', status: 'pending' as const }]) }
        engine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer, ci)
        engine.ciPollMs = 5
        const recipe = recipeWithEvaluators(
          ['  - { id: tests, type: command, command: npm test }', '  - { id: checks, type: ci, timeout: 1s }'].join('\n'),
        )
        const runId = await startAndTurn(recipe)
        await new Promise((r) => setTimeout(r, 1100))
        await settle()

        expect(store.getRun(runId)!.state).toBe('awaiting_approval')
        const [iv] = store.listInterventions(runId, 'pending')
        expect(iv.purpose).toBe('ci-timeout')
        expect(await engine.resolveIntervention(iv.id, 'finish')).toBe(true)
        expect(store.getRun(runId)!.outcome).toBe('completed_with_warnings')
      })

      it('recovery re-enters CI monitoring after a restart', async () => {
        const ci = { checkStatus: vi.fn(async () => [{ name: 'test-and-lint', status: 'pass' as const }]) }
        const slowCi = { checkStatus: vi.fn(async () => [{ name: 'test-and-lint', status: 'pending' as const }]) }
        engine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer, slowCi)
        engine.ciPollMs = 5
        const runId = await startAndTurn(ciRecipe())
        await settle()
        expect(store.getRun(runId)!.state).toBe('monitoring_ci')

        const freshEngine = new LoopEngine(host, store, new LoopArtifactStore(join(root, 'artifacts')), evalApi, finalizer, ci)
        freshEngine.ciPollMs = 5
        const summary = await freshEngine.recoverAll()
        expect(summary.resumed).toContain(runId)
        await settle(10)
        expect(store.getRun(runId)!.outcome).toBe('completed')
      })
    })

    it('run detail scorecard covers every criterion including pending ones', async () => {
      const recipe = recipeWithEvaluators(
        ['  - { id: tests, type: command, command: npm test }', '  - { id: signoff, type: human, title: "OK?" }'].join('\n'),
      )
      const tests = recipe.evaluators[0] as CommandEvaluatorConfig
      evalApi.commandQueue = [fail(tests)]
      const runId = await startAndTurn(recipe)
      // Scorecard is computed by the routes layer from the same data; verify the parts here.
      const evaluations = store.listEvaluations(runId)
      expect(evaluations.find((e) => e.evaluatorId === 'tests')?.status).toBe('fail')
      expect(evaluations.find((e) => e.evaluatorId === 'signoff')).toBeUndefined() // pending
    })
  })

  it('buildMakerPrompt lists evaluators, protected paths, and remaining budget', () => {
    const recipe = recipeFromYaml({ protectedPaths: ['docs/**'] })
    const run = {
      recipe,
      recipeId: recipe.id,
      goal: 'Fix it',
      branch: 'loop/x',
    } as Parameters<typeof buildMakerPrompt>[0]
    const prompt = buildMakerPrompt(run, { turns: 4, costUsd: 2.5 }, null, null)
    expect(prompt).toContain('`npm test`')
    expect(prompt).toContain('docs/**')
    expect(prompt).toContain('4 turns, $2.50')
  })
})
