import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
} = {}): LoopRecipe {
  const md = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-repair, name: Repair CI }
agent: { provider: claude }
workspace:
  protectedPaths: [${(opts.protectedPaths ?? []).map((p) => JSON.stringify(p)).join(', ')}]
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
