/**
 * LoopEngine — the Loops 2.0 durable state machine.
 *
 * Drives an outcome-driven loop around a coding session:
 *
 *   preflight → act → evaluate → (review) → decide → … → finalize
 *
 * The decision node is deterministic code (docs/LOOPS-REWRITE-SPEC.md §7): the
 * maker proposes changes but never decides whether its own acceptance
 * criteria passed. Evaluation is command evaluators (deterministic gate)
 * followed by rubric evaluators (an independent, different-provider model).
 *
 * Durability: every transition appends a `loop_events` row; orchestration
 * counters are checkpointed after each decided turn; and `recoverAll()`
 * resumes interrupted runs after a restart instead of failing them. Provider
 * sessions are NOT resumed in-provider — recovery restarts at a stage
 * boundary with a regenerated context prompt in the surviving worktree
 * (spec §16.3, decided 2026-08-30).
 *
 * Wait states (`paused`, `awaiting_approval`) are durable: they hold no
 * process, survive restarts untouched, and resume via `resume()` /
 * `resolveIntervention()`, which rebuild the runtime context on demand.
 *
 * Dependencies (SessionHost, evaluator API, finalizer, git) are injected so
 * the loop logic is unit-testable without spawning real sessions.
 */

import { existsSync } from 'fs'
import { execGit } from './diff-manager.js'
import { matchesAnyGlob } from './glob-match.js'
import { AGENT_ALLOWED_TOOLS, READONLY_AGENT_ALLOWED_TOOLS } from './agent-allowlist.js'
import {
  runCommandEvaluator,
  runTestReportEvaluator,
  analyzeDiffPolicy,
  checkArtifactRequirement,
  failureFingerprint,
  getDiffSummary,
  getDiff,
  getChangedFiles,
  buildRubricPrompt,
  parseRubricVerdict,
  displayCommand,
  type CommandEvaluationOutcome,
} from './loop-evaluators.js'
import { defaultLoopFinalizer, type LoopFinalizerApi } from './loop-finalizer.js'
import {
  resolveRubricProvider,
  type LoopProvider,
  type LoopRecipe,
  type RubricEvaluatorConfig,
  type CommandEvaluatorConfig,
  type TestReportEvaluatorConfig,
  type CompositeEvaluatorConfig,
  type HumanEvaluatorConfig,
  type CiEvaluatorConfig,
} from './loop-recipe.js'
import type { LoopRun, LoopRunOutcome, LoopRunState, LoopStore } from './loop-store.js'
import type { LoopArtifactStore } from './loop-artifacts.js'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

interface CreateOpts {
  provider?: LoopProvider
  model?: string
  source?: 'agent'
  allowedTools?: string[]
}

interface HistoryMsg {
  type: string
  data?: string
  costUsd?: number
}

interface SessionView {
  outputHistory: HistoryMsg[]
  worktreePath?: string
}

/** The slice of SessionManager the engine depends on (same seam as v1). */
export interface SessionHost {
  create(name: string, workingDir: string, options?: CreateOpts): { id: string }
  createWorktree(sessionId: string, workingDir: string, targetBranch?: string, baseBranch?: string): Promise<string | null>
  startClaude(sessionId: string): boolean
  sendInput(sessionId: string, data: string): void
  stopClaude(sessionId: string): void
  get(sessionId: string): SessionView | undefined
  onSessionResult(listener: (sessionId: string, isError: boolean) => void): () => void
  onSessionPrompt(
    listener: (sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void,
  ): () => void
}

/** Evaluator + git surface — defaults to the real implementations. */
export interface LoopEvaluatorApi {
  runCommandEvaluator: typeof runCommandEvaluator
  runTestReportEvaluator: typeof runTestReportEvaluator
  getDiffSummary(cwd: string): Promise<string>
  getDiff(cwd: string): Promise<string>
  getChangedFiles(cwd: string): Promise<string[]>
  revParseHead(repo: string, ref?: string): Promise<string>
  /** Raw git (argv-only) in a working directory — worktree capture, worker commits, integration merges. */
  git(args: string[], cwd: string): Promise<string>
}

const defaultEvaluatorApi: LoopEvaluatorApi = {
  runCommandEvaluator,
  runTestReportEvaluator,
  getDiffSummary,
  getDiff,
  getChangedFiles,
  revParseHead: async (repo, ref) => (await execGit(['rev-parse', ref ?? 'HEAD'], repo)).trim(),
  git: (args, cwd) => execGit(args, cwd),
}

export interface StartLoopRunInput {
  recipe: LoopRecipe
  goal: string
  repo: string
  branch: string
  /** Branch the worktree is created from; repo default branch when omitted. */
  baseBranch?: string | null
  provider: LoopProvider
  model?: string | null
}

/** Remote CI surface — defaults to `gh pr checks`; injectable for tests. */
export interface LoopCiApi {
  /** Status of the checks reported at the branch's PR. */
  checkStatus(cwd: string, branch: string): Promise<Array<{ name: string; status: 'pending' | 'pass' | 'fail' }>>
}

const defaultCiApi: LoopCiApi = {
  async checkStatus(cwd, branch) {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const out = await promisify(execFile)('gh', ['pr', 'checks', branch, '--json', 'name,bucket'], { cwd, timeout: 30_000 }).then(
      (r) => r.stdout,
      (err: unknown) => {
        // `gh pr checks` exits 8 while checks are pending but still prints the JSON.
        const e = err as { stdout?: string }
        if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('[')) return e.stdout
        throw err
      },
    )
    const rows = JSON.parse(out) as Array<{ name: string; bucket: string }>
    return rows.map((r) => ({
      name: r.name,
      status: r.bucket === 'pass' || r.bucket === 'skipping' ? 'pass' : r.bucket === 'pending' ? 'pending' : 'fail',
    }))
  },
}

/** How often remote CI is polled while monitoring. */
const CI_POLL_MS = 30_000

/** Max consecutive protected-path violations before escalating to a human. */
const MAX_PROTECTED_STRIKES = 2
/** Each granted budget extension adds this fraction of the original budget. */
const EXTENSION_FRACTION = 0.5

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

/** Counters that survive restarts — serialized into loop_checkpoints. */
interface CheckpointState {
  /** 'planning' until the plan is produced (and approved in guided mode). */
  phase: 'planning' | 'acting'
  turnCount: number
  makerCostUsd: number
  reviewCostUsd: number
  lastDiffSummary: string | null
  /** Fingerprints of the most recent failing evaluate cycle. */
  lastFingerprints: string[]
  noProgressCount: number
  protectedStrikes: number
  budgetExtensions: number
  /** Human sign-offs still owed in this completion attempt. */
  pendingHumanIds: string[]
}

interface RunCtx extends CheckpointState {
  runId: string
  cwd: string
  makerSessionId: string | null
  reviewSessionId: string | null
  /** Length of the maker's assistant text when the current prompt was sent —
   * lets the plan handler read only the reply to that prompt. */
  assistantTextOffset: number
  /** Rubric evaluators still to run in this evaluate cycle. */
  pendingRubrics: RubricEvaluatorConfig[]
  /** Commands that passed in this cycle (context for the rubric prompt). */
  passedCommands: string[]
  processing: boolean
  reviewProcessing: boolean
  pauseRequested: boolean
  cancelRequested: boolean
  steerQueue: string[]
  notedPromptIds: Set<string>
  /** Live parallel-worker sessions (stopped on teardown). */
  workerSessionIds: string[]
  wallTimer: NodeJS.Timeout | null
  ciTimer: NodeJS.Timeout | null
  disposers: (() => void)[]
}

function freshCheckpointState(): CheckpointState {
  return {
    phase: 'acting',
    turnCount: 0,
    makerCostUsd: 0,
    reviewCostUsd: 0,
    lastDiffSummary: null,
    lastFingerprints: [],
    noProgressCount: 0,
    protectedStrikes: 0,
    budgetExtensions: 0,
    pendingHumanIds: [],
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class LoopEngine {
  private active = new Map<string, RunCtx>()

  constructor(
    private readonly host: SessionHost,
    private readonly store: LoopStore,
    private readonly artifacts: LoopArtifactStore,
    private readonly evaluator: LoopEvaluatorApi = defaultEvaluatorApi,
    private readonly finalizer: LoopFinalizerApi = defaultLoopFinalizer,
    private readonly ci: LoopCiApi = defaultCiApi,
  ) {}

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /** Create a run, preflight it, and kick off the maker. */
  async startRun(input: StartLoopRunInput): Promise<LoopRun> {
    const run = this.store.createRun({
      recipe: input.recipe,
      goal: input.goal,
      repo: input.repo,
      branch: input.branch,
      baseBranch: input.baseBranch ?? null,
      provider: input.provider,
      model: input.model ?? null,
    })
    this.store.appendEvent({ runId: run.id, type: 'run_created', actor: { type: 'user' }, payload: { recipeId: run.recipeId, repo: run.repo } })

    const ok = await this.preflight(run)
    if (!ok) return this.store.getRun(run.id) ?? run

    const ctx = this.buildCtx(run.id, run.repo, freshCheckpointState())
    if (input.recipe.plan.required) ctx.phase = 'planning'
    this.checkpoint(ctx)
    this.active.set(run.id, ctx)
    await this.beginActing(ctx, this.store.getRun(run.id) ?? run, null)
    return this.store.getRun(run.id) ?? run
  }

  /**
   * Validate before spending: repo exists, HEAD resolves (recorded as the base
   * SHA). Recipe validity is the loader's job; command availability is proven
   * by the first evaluate cycle rather than guessed here.
   */
  private async preflight(run: LoopRun): Promise<boolean> {
    this.setState(run.id, 'preflight')
    const stage = this.store.createStage(run.id, 'preflight')
    try {
      if (!existsSync(run.repo)) throw new Error(`repository path does not exist: ${run.repo}`)
      const baseSha = await this.evaluator.revParseHead(run.repo, run.baseBranch ?? undefined)
      this.store.patchRun(run.id, { baseSha, startedAt: new Date().toISOString() })
      this.store.completeStage(stage.id, 'succeeded')
      this.store.appendEvent({ runId: run.id, type: 'preflight_completed', stageId: stage.id, payload: { baseSha } })
      return true
    } catch (err) {
      const reason = `Preflight failed: ${errMsg(err)}`
      this.store.completeStage(stage.id, 'failed')
      this.finishRun(run.id, 'failed', reason)
      return false
    }
  }

  /** Spawn a maker session (fresh worktree on first start, existing one on resume). */
  private async beginActing(ctx: RunCtx, run: LoopRun, resumeNote: string | null): Promise<void> {
    // Resume reattaches by working directly in the surviving worktree; a first
    // start creates the worktree off the session's repo checkout.
    const resumeCwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null
    const session = this.host.create(`loop:${run.recipeId}:${run.branch}`, resumeCwd ?? run.repo, {
      provider: run.provider,
      model: run.model ?? undefined,
      source: 'agent',
      allowedTools: AGENT_ALLOWED_TOOLS,
    })
    ctx.makerSessionId = session.id

    if (resumeCwd) {
      ctx.cwd = resumeCwd
    } else {
      const worktree = await this.host.createWorktree(session.id, run.repo, run.branch, run.baseBranch ?? undefined)
      ctx.cwd = worktree ?? run.repo
    }
    this.store.patchRun(run.id, { makerSessionId: session.id, worktreePath: ctx.cwd })

    ctx.disposers.push(
      this.host.onSessionResult((sid, isError) => {
        if (sid !== ctx.makerSessionId) return
        void this.onMakerResult(ctx, isError)
      }),
      this.host.onSessionPrompt((sid, promptType, toolName, requestId) => {
        this.onSessionBlocked(ctx, sid, promptType, toolName, requestId)
      }),
    )
    this.armWallTimer(ctx, run)

    const planning = ctx.phase === 'planning'
    this.setState(run.id, planning ? 'planning' : 'executing')
    if (planning) this.store.createStage(run.id, 'plan')
    this.host.startClaude(session.id)
    ctx.assistantTextOffset = 0
    const lessons = this.approvedLessons(run)
    if (lessons.length) {
      this.store.appendEvent({ runId: run.id, type: 'lessons_applied', payload: { count: lessons.length } })
    }
    const prompt = planning
      ? buildPlanningPrompt(run, resumeNote, this.drainSteers(ctx), lessons)
      : buildMakerPrompt(run, this.remaining(ctx, run), resumeNote, this.drainSteers(ctx), lessons)
    this.host.sendInput(session.id, prompt)
    this.store.appendEvent({
      runId: run.id,
      type: 'maker_started',
      payload: { sessionId: session.id, resumed: resumeNote !== null, phase: ctx.phase },
    })
  }

  private buildCtx(runId: string, cwd: string, state: CheckpointState): RunCtx {
    return {
      ...state,
      runId,
      cwd,
      makerSessionId: null,
      reviewSessionId: null,
      assistantTextOffset: 0,
      pendingRubrics: [],
      passedCommands: [],
      processing: false,
      reviewProcessing: false,
      pauseRequested: false,
      cancelRequested: false,
      steerQueue: [],
      notedPromptIds: new Set(),
      workerSessionIds: [],
      wallTimer: null,
      ciTimer: null,
      disposers: [],
    }
  }

  // -------------------------------------------------------------------------
  // The decision node
  // -------------------------------------------------------------------------

  private async onMakerResult(ctx: RunCtx, isError: boolean): Promise<void> {
    if (ctx.processing) return
    ctx.processing = true
    try {
      const run = this.store.getRun(ctx.runId)
      if (!run || !this.active.has(ctx.runId)) return

      ctx.turnCount += 1
      ctx.makerCostUsd = readCumulativeCost(this.host.get(ctx.makerSessionId ?? '')?.outputHistory ?? [])
      this.store.patchRun(run.id, { turnCount: ctx.turnCount, costUsd: this.totalCost(ctx), stateReason: null })
      this.store.appendEvent({
        runId: run.id,
        type: 'maker_turn_completed',
        actor: { type: 'agent', id: 'maker' },
        payload: { turn: ctx.turnCount, costUsd: this.totalCost(ctx), isError },
      })

      // 1–2. User intent first: cancel, then pause, at this safe boundary.
      if (ctx.cancelRequested) {
        this.completeCancel(ctx, run)
        return
      }
      if (ctx.pauseRequested) {
        this.parkPaused(ctx, run)
        return
      }

      // 3. Maker process error: retry within budget, else budget boundary.
      if (isError) {
        if (this.budgetExhausted(ctx, run)) {
          this.onBudgetBoundary(ctx, run)
          return
        }
        this.sendMakerFeedback(ctx, run, 'The previous turn ended with an error. Review the outcome and continue.')
        return
      }

      // 4. Budgets (turns, cost, wall time).
      if (this.budgetExhausted(ctx, run)) {
        this.onBudgetBoundary(ctx, run)
        return
      }

      // 5. Planning phase: capture the plan artifact and route — no
      // evaluation until the maker is executing.
      if (ctx.phase === 'planning') {
        this.onPlanProduced(ctx, run)
        return
      }

      // 6. Protected paths: violation re-prompts; repeats escalate.
      const changedFiles = await this.evaluator.getChangedFiles(ctx.cwd)
      const protectedPaths = run.recipe.workspace.protectedPaths
      const violations = protectedPaths.length ? changedFiles.filter((f) => matchesAnyGlob(f, protectedPaths)) : []
      if (violations.length) {
        ctx.protectedStrikes += 1
        this.store.appendEvent({ runId: run.id, type: 'protected_path_violation', payload: { files: violations, strike: ctx.protectedStrikes } })
        if (ctx.protectedStrikes > MAX_PROTECTED_STRIKES) {
          this.escalate(ctx, run, `The agent repeatedly modified protected paths: ${violations.join(', ')}`)
          return
        }
        this.sendMakerFeedback(
          ctx,
          run,
          [
            `You modified protected files that must not change: ${violations.join(', ')}.`,
            `Protected patterns: ${protectedPaths.join(', ')}.`,
            `Revert those changes and achieve the outcome without touching them.`,
          ].join('\n'),
        )
        return
      }
      ctx.protectedStrikes = 0

      // 7. No changes yet: a clean tree must not masquerade as success.
      if (changedFiles.length === 0) {
        this.sendMakerFeedback(ctx, run, 'No file changes detected yet. Make the changes required to achieve the outcome.')
        return
      }

      // 8. Evaluate.
      await this.evaluate(ctx, run)
    } finally {
      ctx.processing = false
    }
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /**
   * The maker replied to the planning prompt. Retain the plan as an artifact,
   * then gate on approval (guided) or proceed straight to execution.
   */
  private onPlanProduced(ctx: RunCtx, run: LoopRun): void {
    const history = this.host.get(ctx.makerSessionId ?? '')?.outputHistory ?? []
    const full = extractAssistantText(history)
    const planText = (full.slice(ctx.assistantTextOffset).trim() || full.trim()) || '(the maker produced no plan text)'

    const stage = this.store.listStages(run.id).filter((s) => s.kind === 'plan' && s.status === 'running').at(-1)
    if (stage) this.store.completeStage(stage.id, 'succeeded')
    const artifactHash = this.artifacts.put(planText)
    const artifact = this.store.addArtifact({
      runId: run.id,
      kind: 'plan',
      label: `plan (turn ${ctx.turnCount})`,
      contentHash: artifactHash,
      sizeBytes: Buffer.byteLength(planText),
    })
    this.store.appendEvent({
      runId: run.id,
      type: 'plan_created',
      stageId: stage?.id,
      actor: { type: 'agent', id: 'maker' },
      payload: { artifactId: artifact.id },
    })

    if (run.recipe.policy.mode === 'guided') {
      this.createEngineIntervention(ctx, run, {
        purpose: 'plan-approval',
        title: `Approve the plan for "${run.recipe.name}"?`,
        body: planText.slice(0, 4000),
        options: ['approve', 'revise', 'stop'],
      })
      return
    }
    this.proceedToActing(ctx, run)
  }

  /** Same session continues from plan to execution — unless the plan fanned out workstreams. */
  private proceedToActing(ctx: RunCtx, run: LoopRun): void {
    ctx.phase = 'acting'
    this.checkpoint(ctx)
    const streams = this.plannedWorkstreams(run)
    if (streams) {
      void this.runWorkers(ctx, run, streams)
      return
    }
    const remaining = this.remaining(ctx, run)
    this.sendMakerFeedback(
      ctx,
      run,
      [
        'The plan is recorded. Execute it now.',
        `- Make the smallest changes that achieve the outcome; follow your plan and note deviations.`,
        `- Evaluators run after each of your turns; failures come back as feedback.`,
        `- Remaining budget: ${remaining.turns} turns, $${remaining.costUsd.toFixed(2)}.`,
      ].join('\n'),
    )
  }

  // -------------------------------------------------------------------------
  // Scoped parallel workers + deterministic integration
  // -------------------------------------------------------------------------

  /**
   * Workstreams the plan declared, when they are provably independent —
   * validated in deterministic code, never trusted from the model: at least
   * two streams, every stream scoped, and scopes pairwise disjoint by literal
   * prefix (conservative — overlapping prefixes fall back to sequential).
   */
  private plannedWorkstreams(run: LoopRun): Workstream[] | null {
    if (run.recipe.workers.maxParallel <= 1) return null
    const plan = this.latestPlanText(run.id)
    if (!plan) return null
    const streams = parseWorkstreams(plan)
    if (streams.length < 2 || !workstreamScopesDisjoint(streams)) return null
    return streams.slice(0, 8)
  }

  /**
   * Fan the plan's workstreams out to child maker sessions in child worktrees
   * branched off the run branch (after committing the pre-worker state), then
   * integrate deterministically: each child's work is committed engine-side,
   * scope-checked against its declared globs, and merged with `--no-ff`. Any
   * merge conflict aborts the merge and escalates — no model resolves it
   * silently. The main maker session handles all post-integration repairs
   * sequentially.
   */
  private async runWorkers(ctx: RunCtx, run: LoopRun, streams: Workstream[]): Promise<void> {
    this.setState(run.id, 'executing', `Running ${streams.length} parallel workstreams.`)
    const stage = this.store.createStage(run.id, 'act')
    try {
      // Children branch from a committed state so no work-in-progress is lost.
      await this.evaluator.git(['add', '-A'], ctx.cwd)
      await this.evaluator.git(['commit', '--allow-empty', '-m', 'loop: pre-workstream state'], ctx.cwd)
    } catch (err) {
      this.store.completeStage(stage.id, 'failed')
      this.sendMakerFeedback(ctx, run, `Could not prepare the worktree for parallel workstreams (${errMsg(err)}). Execute the plan sequentially instead.`)
      return
    }
    this.store.appendEvent({
      runId: run.id,
      type: 'workers_started',
      stageId: stage.id,
      payload: { streams: streams.map((w) => ({ name: w.name, scopes: w.scopes })), maxParallel: run.recipe.workers.maxParallel },
    })

    const results: Array<{ stream: Workstream; branch: string; ok: boolean; note: string }> = []
    const queue = streams.map((stream, i) => ({ stream, i }))
    const runNext = async (): Promise<void> => {
      const item = queue.shift()
      if (!item) return
      results.push(await this.runOneWorker(ctx, run, item.stream, item.i))
      await runNext()
    }
    // A bounded pool: maxParallel lanes each drain the shared queue.
    await Promise.all(Array.from({ length: Math.min(run.recipe.workers.maxParallel, streams.length) }, () => runNext()))

    if (!this.active.has(run.id)) return // canceled/paused mid-flight
    const usable = results.filter((r) => r.ok)
    if (!usable.length) {
      this.store.completeStage(stage.id, 'failed')
      this.sendMakerFeedback(
        ctx,
        run,
        `All parallel workstreams failed or violated their scopes:\n${results.map((r) => `- ${r.stream.name}: ${r.note}`).join('\n')}\nExecute the plan sequentially instead.`,
      )
      return
    }
    this.store.completeStage(stage.id, 'succeeded')
    await this.integrateWorkers(ctx, run, results)
  }

  private runOneWorker(ctx: RunCtx, run: LoopRun, stream: Workstream, index: number): Promise<{ stream: Workstream; branch: string; ok: boolean; note: string }> {
    return new Promise((resolve) => {
      const branch = `${run.branch}-w${index}`
      const finish = async (isError: boolean, sessionId: string, cwd: string | null): Promise<void> => {
        ctx.workerSessionIds = ctx.workerSessionIds.filter((id) => id !== sessionId)
        ctx.turnCount += 1
        ctx.makerCostUsd += readCumulativeCost(this.host.get(sessionId)?.outputHistory ?? [])
        this.store.patchRun(run.id, { turnCount: ctx.turnCount, costUsd: this.totalCost(ctx) })
        this.host.stopClaude(sessionId)
        let ok = false
        let note: string
        if (isError || !cwd) {
          note = 'worker session errored'
        } else {
          try {
            // Deterministic commit of whatever the child produced — the merge
            // never depends on the model remembering to commit.
            await this.evaluator.git(['add', '-A'], cwd)
            await this.evaluator.git(['commit', '-m', `loop worker: ${stream.name}`], cwd).catch(() => {})
            const changed = (await this.evaluator.git(['diff', '--name-only', `${run.branch}...HEAD`], cwd))
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
            const violations = changed.filter((f) => !matchesAnyGlob(f, stream.scopes))
            if (!changed.length) note = 'no changes produced'
            else if (violations.length) note = `changed files outside its scope: ${violations.join(', ')}`
            else {
              ok = true
              note = `${changed.length} file(s) within scope`
            }
          } catch (err) {
            note = `could not inspect worker result: ${errMsg(err)}`
          }
        }
        this.store.appendEvent({
          runId: run.id,
          type: 'worker_completed',
          actor: { type: 'agent', id: `worker:${stream.name}` },
          payload: { name: stream.name, branch, ok, note },
        })
        resolve({ stream, branch, ok, note })
      }

      void (async () => {
        const session = this.host.create(`loop:${run.recipeId}:worker:${stream.name}`, run.repo, {
          provider: run.provider,
          model: run.model ?? undefined,
          source: 'agent',
          allowedTools: AGENT_ALLOWED_TOOLS,
        })
        ctx.workerSessionIds.push(session.id)
        const cwd = await this.host.createWorktree(session.id, run.repo, branch, run.branch)
        if (!cwd) {
          await finish(true, session.id, null)
          return
        }
        const dispose = this.host.onSessionResult((sid, isError) => {
          if (sid !== session.id) return
          dispose()
          void finish(isError, session.id, cwd)
        })
        ctx.disposers.push(dispose)
        this.host.startClaude(session.id)
        this.host.sendInput(session.id, buildWorkerPrompt(run, stream))
      })()
    })
  }

  private async integrateWorkers(
    ctx: RunCtx,
    run: LoopRun,
    results: Array<{ stream: Workstream; branch: string; ok: boolean; note: string }>,
  ): Promise<void> {
    const stage = this.store.createStage(run.id, 'integrate')
    const merged: string[] = []
    const skipped = results.filter((r) => !r.ok).map((r) => `${r.stream.name} (${r.note})`)
    for (const result of results.filter((r) => r.ok)) {
      try {
        await this.evaluator.git(['merge', '--no-ff', '-m', `loop: integrate ${result.stream.name}`, result.branch], ctx.cwd)
        merged.push(result.stream.name)
      } catch (err) {
        await this.evaluator.git(['merge', '--abort'], ctx.cwd).catch(() => {})
        this.store.completeStage(stage.id, 'failed')
        this.store.appendEvent({ runId: run.id, type: 'integration_conflict', stageId: stage.id, payload: { branch: result.branch, error: errMsg(err) } })
        this.escalate(
          ctx,
          run,
          `Integrating workstream "${result.stream.name}" (branch ${result.branch}) hit a merge conflict. Continue to let the agent integrate the remaining branches manually, or stop.`,
        )
        return
      }
    }
    this.store.completeStage(stage.id, 'succeeded')
    this.store.appendEvent({ runId: run.id, type: 'integration_completed', stageId: stage.id, payload: { merged, skipped } })
    if (skipped.length) {
      this.sendMakerFeedback(
        ctx,
        run,
        `Workstreams integrated: ${merged.join(', ')}. These were dropped and still need doing sequentially: ${skipped.join('; ')}.`,
      )
      return
    }
    await this.evaluate(ctx, run)
  }

  /** Latest retained plan text, for regenerated context after a wait state. */
  private latestPlanText(runId: string): string | null {
    const plan = this.store
      .listArtifacts(runId)
      .filter((a) => a.kind === 'plan')
      .at(-1)
    if (!plan) return null
    return this.artifacts.get(plan.contentHash)?.toString() ?? null
  }

  /** Run the command evaluators in order (short-circuit on required failure). */
  private async evaluate(ctx: RunCtx, run: LoopRun): Promise<void> {
    this.setState(run.id, 'evaluating')
    const stage = this.store.createStage(run.id, 'evaluate')
    const diffSummary = await this.evaluator.getDiffSummary(ctx.cwd)

    const rubrics = run.recipe.evaluators.filter((e): e is RubricEvaluatorConfig => e.type === 'rubric')

    ctx.passedCommands = []
    const fingerprints: string[] = []
    let requiredFailure: CommandEvaluationOutcome | null = null

    // Deterministic locals run in recipe order; the first required failure
    // short-circuits — it is what the maker needs to see next. Rubric, human,
    // ci, and composite evaluators are handled after this gate.
    for (const config of run.recipe.evaluators) {
      let outcome: CommandEvaluationOutcome
      if (config.type === 'command' || config.type === 'test-report') {
        outcome = await this.runDeterministicWithRetry(ctx, run, stage.id, config)
        if (outcome.status === 'pass') ctx.passedCommands.push(outcome.command)
      } else if (config.type === 'diff-policy') {
        const diff = await this.evaluator.getDiff(ctx.cwd)
        const changedFiles = await this.evaluator.getChangedFiles(ctx.cwd)
        const violations = analyzeDiffPolicy(config, diff, changedFiles)
        outcome = this.recordLocalEvaluation(ctx, run, stage.id, config.id, {
          pass: violations.length === 0,
          summary: violations.length ? `diff policy: ${violations.length} violation(s)` : 'diff policy: clean',
          detail: violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n') || 'no violations',
          classification: 'policy',
        })
      } else if (config.type === 'artifact') {
        const check = checkArtifactRequirement(config, ctx.cwd)
        outcome = this.recordLocalEvaluation(ctx, run, stage.id, config.id, {
          pass: check.ok,
          summary: check.ok ? `required artifact present: ${check.detail}` : `required artifact missing: ${check.detail}`,
          detail: check.detail,
          classification: 'policy',
        })
      } else {
        continue
      }
      if (outcome.status === 'pass') continue
      if (outcome.fingerprint) fingerprints.push(outcome.fingerprint)
      if (config.required) {
        requiredFailure = outcome
        break
      }
    }

    if (requiredFailure) {
      this.store.completeStage(stage.id, 'failed')
      this.onEvaluationFailed(ctx, run, diffSummary, fingerprints, requiredFailure)
      return
    }

    this.store.completeStage(stage.id, 'succeeded')
    ctx.lastDiffSummary = diffSummary
    ctx.lastFingerprints = []
    ctx.noProgressCount = 0
    this.checkpoint(ctx)

    if (rubrics.length) {
      ctx.pendingRubrics = [...rubrics]
      await this.startNextRubric(ctx, run)
      return
    }
    this.startHumanEvaluations(ctx, run)
  }

  /** Record a synchronous deterministic check (diff-policy, artifact) uniformly. */
  private recordLocalEvaluation(
    ctx: RunCtx,
    run: LoopRun,
    stageId: string,
    evaluatorId: string,
    result: { pass: boolean; summary: string; detail: string; classification: 'policy' },
  ): CommandEvaluationOutcome {
    const artifactHash = this.artifacts.put(result.detail)
    const artifact = this.store.addArtifact({
      runId: run.id,
      kind: 'report',
      label: `${evaluatorId} (turn ${ctx.turnCount})`,
      contentHash: artifactHash,
      sizeBytes: Buffer.byteLength(result.detail),
    })
    const fingerprint = result.pass ? null : failureFingerprint(evaluatorId, null, result.detail)
    this.store.addEvaluation({
      runId: run.id,
      stageId,
      evaluatorId,
      status: result.pass ? 'pass' : 'fail',
      classification: result.pass ? null : result.classification,
      summary: result.summary,
      fingerprint,
      retryable: false,
      durationMs: 0,
      costUsd: null,
      evidenceArtifactIds: [artifact.id],
    })
    this.store.appendEvent({
      runId: run.id,
      type: 'evaluation_completed',
      stageId,
      payload: { evaluatorId, status: result.pass ? 'pass' : 'fail', summary: result.summary, artifactId: artifact.id },
    })
    return {
      evaluatorId,
      status: result.pass ? 'pass' : 'fail',
      classification: result.pass ? null : result.classification,
      summary: result.summary,
      outputTail: result.detail,
      fullOutput: result.detail,
      command: evaluatorId,
      exitCode: result.pass ? 0 : 1,
      fingerprint,
      retryable: false,
      durationMs: 0,
      timedOut: false,
    }
  }

  private async runDeterministicWithRetry(
    ctx: RunCtx,
    run: LoopRun,
    stageId: string,
    config: CommandEvaluatorConfig | TestReportEvaluatorConfig,
  ): Promise<CommandEvaluationOutcome> {
    let outcome: CommandEvaluationOutcome
    let attemptsLeft = Math.max(1, config.retryMaxAttempts)
    do {
      const attempt = this.store.createAttempt(stageId, run.id)
      outcome =
        config.type === 'command'
          ? await this.evaluator.runCommandEvaluator(config, ctx.cwd)
          : await this.evaluator.runTestReportEvaluator(config, ctx.cwd)
      const artifactHash = this.artifacts.put(outcome.fullOutput)
      const artifact = this.store.addArtifact({
        runId: run.id,
        kind: 'log',
        label: `${outcome.command} (turn ${ctx.turnCount})`,
        contentHash: artifactHash,
        sizeBytes: Buffer.byteLength(outcome.fullOutput),
      })
      this.store.addEvaluation({
        runId: run.id,
        stageId,
        evaluatorId: config.id,
        status: outcome.status,
        classification: outcome.classification,
        summary: outcome.summary,
        fingerprint: outcome.fingerprint,
        retryable: outcome.retryable,
        durationMs: outcome.durationMs,
        costUsd: null,
        evidenceArtifactIds: [artifact.id],
      })
      this.store.completeAttempt(attempt.id, outcome.status === 'pass' ? 'succeeded' : 'failed', outcome.status === 'pass' ? undefined : outcome.summary)
      this.store.appendEvent({
        runId: run.id,
        type: 'evaluation_completed',
        stageId,
        attemptId: attempt.id,
        payload: { evaluatorId: config.id, status: outcome.status, summary: outcome.summary, artifactId: artifact.id },
      })
      attemptsLeft -= 1
      // Only transient (environment) errors earn a retry — a real test failure
      // re-running unchanged code would just burn the budget.
    } while (outcome.retryable && attemptsLeft > 0)
    return outcome
  }

  /** A required command evaluator failed: detect no-progress, then feed back or escalate. */
  private onEvaluationFailed(
    ctx: RunCtx,
    run: LoopRun,
    diffSummary: string,
    fingerprints: string[],
    failure: CommandEvaluationOutcome,
  ): void {
    const sameDiff = ctx.lastDiffSummary !== null && diffSummary === ctx.lastDiffSummary
    const sameFailure = fingerprints.length > 0 && arraysEqual(fingerprints, ctx.lastFingerprints)
    if (sameDiff || sameFailure) {
      ctx.noProgressCount += 1
    } else {
      ctx.noProgressCount = 0
    }
    ctx.lastDiffSummary = diffSummary
    ctx.lastFingerprints = fingerprints
    this.checkpoint(ctx)

    if (ctx.noProgressCount >= run.recipe.budgets.noProgressAttempts) {
      this.escalate(
        ctx,
        run,
        `No material progress after ${ctx.noProgressCount} attempts — the same failure keeps recurring: ${failure.summary}`,
      )
      return
    }

    const replanNudge =
      ctx.noProgressCount > 0
        ? '\nYour previous fix attempt did not change this result. Step back, reconsider the diagnosis, and try a different approach.'
        : ''
    this.sendMakerFeedback(
      ctx,
      run,
      [
        `Evaluation failed: ${failure.summary}`,
        // For local policy checks the "command" is just the evaluator id — noise.
        failure.command !== failure.evaluatorId ? `Command: \`${failure.command}\`` : '',
        failure.outputTail ? `\nOutput:\n${failure.outputTail}` : '',
        `\nFix the cause and continue. Do not modify tests to make them pass.${replanNudge}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  // -------------------------------------------------------------------------
  // Rubric review
  // -------------------------------------------------------------------------

  private async startNextRubric(ctx: RunCtx, run: LoopRun): Promise<void> {
    const config = ctx.pendingRubrics.shift()
    if (!config) {
      this.startHumanEvaluations(ctx, run)
      return
    }
    this.setState(run.id, 'reviewing')
    const stage = this.store.createStage(run.id, 'review')
    const provider = resolveRubricProvider(config.provider, run.provider)
    const diff = await this.evaluator.getDiff(ctx.cwd)

    const session = this.host.create(`loop:${run.recipeId}:review:${run.branch}`, run.repo, {
      provider,
      model: config.model,
      source: 'agent',
      allowedTools: READONLY_AGENT_ALLOWED_TOOLS,
    })
    // The maker's edits are uncommitted, so the reviewer gets its own worktree
    // on a review branch and the diff travels in the prompt.
    await this.host.createWorktree(session.id, run.repo, `${run.branch}-review`, run.branch)
    ctx.reviewSessionId = session.id
    ctx.reviewProcessing = false

    ctx.disposers.push(
      this.host.onSessionResult((sid, isError) => {
        if (sid !== ctx.reviewSessionId) return
        void this.onRubricResult(ctx, config, stage.id, isError)
      }),
    )
    this.host.startClaude(session.id)
    this.host.sendInput(
      session.id,
      buildRubricPrompt({
        recipeName: run.recipe.name,
        goal: run.goal,
        passedCommands: ctx.passedCommands,
        diff,
        instructions: config.instructions,
      }),
    )
    this.store.appendEvent({ runId: run.id, type: 'review_started', stageId: stage.id, payload: { evaluatorId: config.id, provider } })
  }

  private async onRubricResult(ctx: RunCtx, config: RubricEvaluatorConfig, stageId: string, isError: boolean): Promise<void> {
    if (ctx.reviewProcessing) return
    ctx.reviewProcessing = true
    try {
      const run = this.store.getRun(ctx.runId)
      if (!run || !this.active.has(ctx.runId) || !ctx.reviewSessionId) return

      const history = this.host.get(ctx.reviewSessionId)?.outputHistory ?? []
      ctx.reviewCostUsd += readCumulativeCost(history)
      this.store.patchRun(run.id, { costUsd: this.totalCost(ctx) })

      const text = extractAssistantText(history)
      const parsed = isError ? null : parseRubricVerdict(text)
      const reason = parsed?.reason ?? (isError ? 'review session errored' : 'unparseable review verdict')
      const artifactHash = this.artifacts.put(text || reason)
      const artifact = this.store.addArtifact({
        runId: run.id,
        kind: 'review',
        label: `${config.id} review (turn ${ctx.turnCount})`,
        contentHash: artifactHash,
        sizeBytes: Buffer.byteLength(text || reason),
      })
      this.store.addEvaluation({
        runId: run.id,
        stageId,
        evaluatorId: config.id,
        status: parsed?.verdict === 'approve' ? 'pass' : parsed?.verdict === 'request_changes' ? 'fail' : 'error',
        classification: parsed ? null : 'ambiguous',
        summary: parsed ? `review: ${parsed.verdict}${parsed.reason ? ` — ${parsed.reason}` : ''}` : reason,
        fingerprint: null,
        retryable: false,
        durationMs: 0,
        costUsd: null,
        evidenceArtifactIds: [artifact.id],
      })
      this.disposeReview(ctx)
      this.store.appendEvent({
        runId: run.id,
        type: 'review_verdict',
        stageId,
        actor: { type: 'agent', id: 'reviewer' },
        payload: { evaluatorId: config.id, verdict: parsed?.verdict ?? null, reason },
      })

      if (!parsed || parsed.verdict === 'escalate') {
        this.store.completeStage(stageId, 'failed')
        this.escalate(ctx, run, parsed?.reason ?? reason)
        return
      }
      if (parsed.verdict === 'approve') {
        this.store.completeStage(stageId, 'succeeded')
        await this.startNextRubric(ctx, run)
        return
      }
      // request_changes: feed the review back and resume the loop.
      this.store.completeStage(stageId, 'failed')
      ctx.pendingRubrics = []
      this.sendMakerFeedback(
        ctx,
        run,
        [
          'An independent reviewer assessed your change and requested changes before it can land.',
          parsed.reason ? `Reviewer feedback: ${parsed.reason}` : 'The reviewer did not approve the change.',
          'Address the feedback and continue. Do not weaken tests to satisfy evaluation.',
        ].join('\n'),
      )
    } finally {
      ctx.reviewProcessing = false
    }
  }

  private disposeReview(ctx: RunCtx): void {
    if (!ctx.reviewSessionId) return
    this.host.stopClaude(ctx.reviewSessionId)
    ctx.reviewSessionId = null
  }

  // -------------------------------------------------------------------------
  // Human sign-off evaluators
  // -------------------------------------------------------------------------

  /**
   * After deterministic + rubric evaluators pass, each `human` evaluator asks
   * for an explicit sign-off (pass / waive / fail). One completion attempt
   * asks once per evaluator; a later cycle (after new changes) asks again.
   */
  private startHumanEvaluations(ctx: RunCtx, run: LoopRun): void {
    ctx.pendingHumanIds = run.recipe.evaluators.filter((e): e is HumanEvaluatorConfig => e.type === 'human').map((e) => e.id)
    this.nextHumanEvaluation(ctx, run)
  }

  private nextHumanEvaluation(ctx: RunCtx, run: LoopRun): void {
    const evaluatorId = ctx.pendingHumanIds[0]
    if (evaluatorId === undefined) {
      void this.afterEvaluationsComplete(ctx, run)
      return
    }
    const config = run.recipe.evaluators.find((e): e is HumanEvaluatorConfig => e.type === 'human' && e.id === evaluatorId)
    if (!config) {
      ctx.pendingHumanIds = ctx.pendingHumanIds.slice(1)
      this.nextHumanEvaluation(ctx, run)
      return
    }
    this.createEngineIntervention(ctx, run, {
      purpose: `human-evaluation:${config.id}`,
      title: config.title,
      body: `Evaluator "${config.id}" needs your sign-off. Waiving keeps the run green but qualifies the outcome; failing sends your note back to the agent.`,
      options: ['pass', 'waive', 'fail'],
    })
  }

  /** Record a human verdict as an evaluation row (its own review stage). */
  private recordHumanEvaluation(run: LoopRun, evaluatorId: string, status: 'pass' | 'waived' | 'fail', note?: string): void {
    const stage = this.store.createStage(run.id, 'review')
    this.store.addEvaluation({
      runId: run.id,
      stageId: stage.id,
      evaluatorId,
      status,
      classification: null,
      summary: `human sign-off: ${status}${note ? ` — ${note}` : ''}`,
      fingerprint: null,
      retryable: false,
      durationMs: 0,
      costUsd: null,
      evidenceArtifactIds: [],
    })
    this.store.completeStage(stage.id, status === 'fail' ? 'failed' : 'succeeded')
  }

  // -------------------------------------------------------------------------
  // Composite evaluators
  // -------------------------------------------------------------------------

  /**
   * Composites fold other evaluators' latest results (waived counts toward
   * pass, with the warning it already carries). A failing required composite
   * behaves like any required failure: feedback and another cycle.
   */
  private evaluateComposites(run: LoopRun): { ok: boolean; failure?: string } {
    const composites = run.recipe.evaluators.filter((e): e is CompositeEvaluatorConfig => e.type === 'composite')
    if (!composites.length) return { ok: true }
    const latest = new Map<string, string>()
    for (const ev of this.store.listEvaluations(run.id)) latest.set(ev.evaluatorId, ev.status)
    let failure: string | undefined
    for (const config of composites) {
      const passes = config.of.map((id) => {
        const status = latest.get(id)
        return status === 'pass' || status === 'waived'
      })
      const ok = config.op === 'all' ? passes.every(Boolean) : passes.some(Boolean)
      const detail = config.of.map((id) => `${id}=${latest.get(id) ?? 'not-evaluated'}`).join(', ')
      const stage = this.store.createStage(run.id, 'evaluate')
      this.store.addEvaluation({
        runId: run.id,
        stageId: stage.id,
        evaluatorId: config.id,
        status: ok ? 'pass' : 'fail',
        classification: ok ? null : 'policy',
        summary: `composite ${config.op}(${config.of.join(', ')}): ${ok ? 'pass' : 'fail'} (${detail})`,
        fingerprint: null,
        retryable: false,
        durationMs: 0,
        costUsd: null,
        evidenceArtifactIds: [],
      })
      this.store.completeStage(stage.id, ok ? 'succeeded' : 'failed')
      this.store.appendEvent({
        runId: run.id,
        type: 'evaluation_completed',
        stageId: stage.id,
        payload: { evaluatorId: config.id, status: ok ? 'pass' : 'fail', summary: detail },
      })
      if (!ok && config.required && !failure) failure = `composite "${config.id}" requires ${config.op} of [${detail}]`
    }
    return failure ? { ok: false, failure } : { ok: true }
  }

  /** All rubric + human gates cleared: settle composites, then the completion gate. */
  private async afterEvaluationsComplete(ctx: RunCtx, run: LoopRun): Promise<void> {
    const composite = this.evaluateComposites(run)
    if (!composite.ok) {
      const feedback = `Evaluation failed.\n${composite.failure ?? 'A required composite evaluator failed.'}\nFix the cause and continue.`
      // After a human intervention the maker session is gone — restart it.
      if (ctx.makerSessionId) this.sendMakerFeedback(ctx, run, feedback)
      else await this.resumeActing(ctx, run, feedback)
      return
    }
    this.completionGate(ctx, run)
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /** All evaluators passed. Guided mode asks a human first; otherwise finalize. */
  private completionGate(ctx: RunCtx, run: LoopRun): void {
    if (run.recipe.policy.mode === 'guided') {
      this.createEngineIntervention(ctx, run, {
        purpose: 'completion-approval',
        title: `Approve completion of "${run.recipe.name}"?`,
        body: `All evaluators passed on branch ${run.branch}. Approve to ${run.recipe.completion.action === 'pull-request' ? 'commit, push, and open a PR' : 'commit the changes locally'}.`,
        options: ['approve', 'reject'],
      })
      return
    }
    void this.finalizeRun(ctx, run)
  }

  private async finalizeRun(ctx: RunCtx, run: LoopRun): Promise<void> {
    this.setState(run.id, 'finalizing')
    const stage = this.store.createStage(run.id, 'finalize')
    if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
    const result = await this.finalizer.finalize({
      cwd: ctx.cwd,
      branch: run.branch,
      action: run.recipe.completion.action,
      title: buildPrTitle(run),
      body: buildPrBody(run),
    })
    this.store.completeStage(stage.id, result.clean ? 'succeeded' : 'failed')
    this.store.patchRun(run.id, { prUrl: result.prUrl })
    this.store.appendEvent({ runId: run.id, type: 'finalized', stageId: stage.id, payload: { prUrl: result.prUrl, note: result.note } })

    // With ci evaluators and an actual PR, completion waits for the remote
    // checks — a red check re-enters the loop instead of ending the run.
    const ciConfigs = run.recipe.evaluators.filter((e): e is CiEvaluatorConfig => e.type === 'ci')
    if (ciConfigs.length && run.recipe.completion.action === 'pull-request' && result.prUrl) {
      this.startCiMonitoring(ctx, run)
      return
    }

    const warnings = this.collectWarnings(run, result.clean)
    if (ciConfigs.length && !result.prUrl) warnings.push('ci evaluators were skipped: no PR was opened')
    this.finishRun(run.id, warnings.length ? 'completed_with_warnings' : 'completed', warnings.length ? warnings.join('; ') : result.note)
  }

  // -------------------------------------------------------------------------
  // Remote CI monitoring
  // -------------------------------------------------------------------------

  /**
   * Poll the PR's checks until every ci evaluator concludes. Green finishes
   * the run; a required red feeds the failing checks back to the maker (the
   * next pass re-pushes and monitoring restarts); silence past the timeout
   * asks the operator. Restart-safe: `monitoring_ci` recovery re-enters here
   * (the timeout window restarts — acceptable for a poll loop).
   */
  private startCiMonitoring(ctx: RunCtx, run: LoopRun): void {
    this.setState(run.id, 'monitoring_ci', 'Waiting for remote CI checks on the PR.')
    const stage = this.store.createStage(run.id, 'ci')
    const configs = run.recipe.evaluators.filter((e): e is CiEvaluatorConfig => e.type === 'ci')
    const startedAt = Date.now()
    const timeoutMs = Math.max(...configs.map((c) => c.timeoutMs))
    this.active.set(run.id, ctx)

    const poll = async (): Promise<void> => {
      ctx.ciTimer = null
      const current = this.store.getRun(run.id)
      if (!current || current.state !== 'monitoring_ci' || !this.active.has(run.id)) return
      let checks: Array<{ name: string; status: 'pending' | 'pass' | 'fail' }>
      try {
        checks = await this.ci.checkStatus(ctx.cwd, run.branch)
      } catch (err) {
        // Transient `gh` failures should not kill the watch.
        this.store.appendEvent({ runId: run.id, type: 'ci_poll_error', stageId: stage.id, payload: { error: errMsg(err) } })
        checks = []
      }

      const settled: Array<{ config: CiEvaluatorConfig; failed: string[]; ok: boolean }> = []
      let anyPending = checks.length === 0
      for (const config of configs) {
        const relevant = config.checks.length ? checks.filter((c) => config.checks.includes(c.name)) : checks
        const missing = config.checks.filter((name) => !checks.some((c) => c.name === name))
        if (relevant.some((c) => c.status === 'pending') || missing.length || relevant.length === 0) {
          anyPending = true
          continue
        }
        const failed = relevant.filter((c) => c.status === 'fail').map((c) => c.name)
        settled.push({ config, failed, ok: failed.length === 0 })
      }

      if (!anyPending && settled.length === configs.length) {
        for (const { config, failed, ok } of settled) {
          this.store.addEvaluation({
            runId: run.id,
            stageId: stage.id,
            evaluatorId: config.id,
            status: ok ? 'pass' : 'fail',
            classification: ok ? null : 'code',
            summary: ok ? 'remote CI checks green' : `remote CI failed: ${failed.join(', ')}`,
            fingerprint: ok ? null : failureFingerprint(config.id, null, failed.sort().join(',')),
            retryable: false,
            durationMs: Date.now() - startedAt,
            costUsd: null,
            evidenceArtifactIds: [],
          })
          this.store.appendEvent({
            runId: run.id,
            type: 'ci_concluded',
            stageId: stage.id,
            payload: { evaluatorId: config.id, ok, failed },
          })
        }
        const requiredFailure = settled.find((s) => !s.ok && s.config.required)
        if (requiredFailure) {
          this.store.completeStage(stage.id, 'failed')
          if (this.budgetExhausted(ctx, run)) {
            this.onBudgetBoundary(ctx, run)
            return
          }
          await this.resumeActing(
            ctx,
            run,
            `Remote CI checks failed on the PR: ${requiredFailure.failed.join(', ')}. Investigate the CI failure, fix the cause, and continue — the loop will re-evaluate and update the PR.`,
          )
          return
        }
        this.store.completeStage(stage.id, 'succeeded')
        const warnings = this.collectWarnings(run, true)
        this.teardown(ctx)
        this.finishRun(run.id, warnings.length ? 'completed_with_warnings' : 'completed', warnings.length ? warnings.join('; ') : 'Remote CI green.')
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        this.store.completeStage(stage.id, 'failed')
        this.createEngineIntervention(ctx, run, {
          purpose: 'ci-timeout',
          title: `CI checks did not conclude within ${Math.round(timeoutMs / 60000)} minutes`,
          body: 'Keep waiting (restarts the window), finish with the CI outcome unresolved (qualified result), or stop the run.',
          options: ['keep-waiting', 'finish', 'stop'],
        })
        return
      }

      ctx.ciTimer = setTimeout(() => void poll(), this.ciPollMs)
      ctx.ciTimer.unref?.()
    }
    void poll()
  }

  /** @internal Poll cadence — overridable in tests. */
  ciPollMs = CI_POLL_MS

  /** Anything that qualifies an otherwise-green result. */
  private collectWarnings(run: LoopRun, finalizeClean: boolean): string[] {
    const warnings: string[] = []
    if (!finalizeClean) warnings.push('finalization did not fully land (see events)')
    const evaluations = this.store.listEvaluations(run.id)
    const lastByEvaluator = new Map<string, (typeof evaluations)[number]>()
    for (const ev of evaluations) lastByEvaluator.set(ev.evaluatorId, ev)
    for (const ev of lastByEvaluator.values()) {
      if (ev.status === 'waived') warnings.push(`evaluator ${ev.evaluatorId} was waived`)
      if (ev.status === 'fail' && !isRequired(run.recipe, ev.evaluatorId)) warnings.push(`optional evaluator ${ev.evaluatorId} failed`)
    }
    return warnings
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  private effectiveBudget(ctx: RunCtx, run: LoopRun): { turns: number; costUsd: number; wallMs: number | null } {
    const factor = 1 + ctx.budgetExtensions * EXTENSION_FRACTION
    const b = run.recipe.budgets
    return {
      turns: Math.ceil(b.turns * factor),
      costUsd: b.costUsd * factor,
      wallMs: b.wallTimeMs === undefined ? null : Math.ceil(b.wallTimeMs * factor),
    }
  }

  private remaining(ctx: RunCtx, run: LoopRun): { turns: number; costUsd: number } {
    const budget = this.effectiveBudget(ctx, run)
    return { turns: Math.max(0, budget.turns - ctx.turnCount), costUsd: Math.max(0, budget.costUsd - this.totalCost(ctx)) }
  }

  private budgetExhausted(ctx: RunCtx, run: LoopRun): boolean {
    const budget = this.effectiveBudget(ctx, run)
    if (ctx.turnCount >= budget.turns || this.totalCost(ctx) >= budget.costUsd) return true
    if (budget.wallMs !== null && run.startedAt && Date.now() - Date.parse(run.startedAt) >= budget.wallMs) return true
    return false
  }

  private budgetReason(ctx: RunCtx, run: LoopRun): string {
    const budget = this.effectiveBudget(ctx, run)
    if (ctx.turnCount >= budget.turns) return `turn budget exhausted (${ctx.turnCount}/${budget.turns})`
    if (this.totalCost(ctx) >= budget.costUsd) return `cost budget exhausted ($${this.totalCost(ctx).toFixed(2)}/$${budget.costUsd.toFixed(2)})`
    return `wall-time budget exhausted`
  }

  /**
   * Budget boundary (spec §7.7): ask for a bounded extension, except in
   * autonomous mode, which stops with a partial result instead of waiting on
   * a human who opted not to be in the loop.
   */
  private onBudgetBoundary(ctx: RunCtx, run: LoopRun): void {
    const reason = this.budgetReason(ctx, run)
    this.store.appendEvent({ runId: run.id, type: 'budget_boundary', payload: { reason } })
    if (run.recipe.policy.mode === 'autonomous') {
      this.finishRun(run.id, 'failed', `${reason}; stopped with partial result (autonomous mode)`)
      return
    }
    this.createEngineIntervention(ctx, run, {
      purpose: 'budget-extension',
      title: `Budget boundary: ${reason}`,
      body: `Extend adds ${Math.round(EXTENSION_FRACTION * 100)}% of the original turn/cost/time budget and continues; stop ends the run with a partial result.`,
      options: ['extend', 'stop'],
    })
  }

  /**
   * Wall-time enforcement between boundaries: when the deadline passes while
   * the maker is mid-turn, stop its session — the resulting session-result
   * event lands at the decision node, which sees the exhausted budget.
   */
  private armWallTimer(ctx: RunCtx, run: LoopRun): void {
    this.clearWallTimer(ctx)
    const budget = this.effectiveBudget(ctx, run)
    if (budget.wallMs === null || !run.startedAt) return
    const remainingMs = Date.parse(run.startedAt) + budget.wallMs - Date.now()
    if (remainingMs <= 0) return
    ctx.wallTimer = setTimeout(() => {
      const current = this.store.getRun(ctx.runId)
      if (!current || current.state === 'done' || !this.active.has(ctx.runId)) return
      this.store.appendEvent({ runId: ctx.runId, type: 'wall_time_exceeded', payload: {} })
      // Stopping the session produces a session-result event; the decision
      // node then sees the exhausted wall budget. No direct call here — that
      // would double-process the turn.
      if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
    }, remainingMs)
    ctx.wallTimer.unref?.()
  }

  private clearWallTimer(ctx: RunCtx): void {
    if (ctx.wallTimer) {
      clearTimeout(ctx.wallTimer)
      ctx.wallTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // Interventions & escalation
  // -------------------------------------------------------------------------

  private escalate(ctx: RunCtx, run: LoopRun, reason: string): void {
    this.createEngineIntervention(ctx, run, {
      purpose: 'escalation',
      title: `Loop run needs a decision`,
      body: reason,
      options: ['continue', 'stop'],
    })
  }

  /** Park the run in a durable wait state with a pending intervention. */
  private createEngineIntervention(
    ctx: RunCtx,
    run: LoopRun,
    input: { purpose: string; title: string; body: string; options: string[] },
  ): void {
    const intervention = this.store.createIntervention({ runId: run.id, kind: 'approval', ...input })
    this.store.appendEvent({
      runId: run.id,
      type: 'intervention_created',
      payload: { interventionId: intervention.id, purpose: input.purpose, title: input.title, body: input.body, options: input.options },
    })
    this.setState(run.id, 'awaiting_approval', input.title)
    // Waiting holds no process: stop the maker; the worktree carries the state.
    if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
    this.disposeReview(ctx)
    this.checkpoint(ctx)
    this.teardown(ctx)
  }

  /**
   * Resolve a pending intervention and route by purpose. Works after a
   * restart: the runtime context is rebuilt from the checkpoint on demand.
   */
  async resolveIntervention(interventionId: string, choice: string, note?: string): Promise<boolean> {
    const before = this.store.getIntervention(interventionId)
    if (!before || before.status !== 'pending') return false
    if (before.options.length && !before.options.includes(choice)) return false
    const resolved = this.store.resolveIntervention(interventionId, { choice, note })
    if (!resolved) return false
    const run = this.store.getRun(resolved.runId)
    if (!run) return false
    this.store.appendEvent({
      runId: run.id,
      type: 'intervention_resolved',
      actor: { type: 'user' },
      payload: { interventionId, purpose: resolved.purpose, choice, note: note ?? null },
    })

    const ctx = await this.reviveCtx(run)
    if (!ctx) {
      this.finishRun(run.id, 'failed', 'Could not rebuild run context (worktree missing?)')
      return true
    }

    if (resolved.purpose.startsWith('human-evaluation:')) {
      const evaluatorId = resolved.purpose.slice('human-evaluation:'.length)
      ctx.pendingHumanIds = ctx.pendingHumanIds.filter((id) => id !== evaluatorId)
      this.checkpoint(ctx)
      if (choice === 'fail') {
        this.recordHumanEvaluation(run, evaluatorId, 'fail', note)
        await this.resumeActing(
          ctx,
          run,
          `The human sign-off "${evaluatorId}" failed.${note ? ` Feedback: ${note}` : ''} Address this and continue.`,
        )
        return true
      }
      this.recordHumanEvaluation(run, evaluatorId, choice === 'waive' ? 'waived' : 'pass', note)
      this.nextHumanEvaluation(ctx, run)
      return true
    }

    switch (resolved.purpose) {
      case 'ci-timeout': {
        if (choice === 'keep-waiting') {
          this.startCiMonitoring(ctx, run)
        } else if (choice === 'finish') {
          this.teardown(ctx)
          this.finishRun(run.id, 'completed_with_warnings', 'Completed with remote CI still unresolved (operator decision).')
        } else {
          this.teardown(ctx)
          this.finishRun(run.id, 'canceled', `Stopped while waiting on CI.${note ? ` Note: ${note}` : ''}`)
        }
        return true
      }
      case 'plan-approval': {
        if (choice === 'approve') {
          ctx.phase = 'acting'
          this.checkpoint(ctx)
          const streams = this.plannedWorkstreams(run)
          if (streams) {
            void this.runWorkers(ctx, run, streams)
            return true
          }
          const plan = this.latestPlanText(run.id)
          await this.resumeActing(
            ctx,
            run,
            `Your plan was approved${note ? ` with this note: ${note}` : ''}. Execute it now.${plan ? `\n\nApproved plan:\n${plan}` : ''}`,
          )
        } else if (choice === 'revise') {
          const plan = this.latestPlanText(run.id)
          await this.resumeActing(
            ctx,
            run,
            `The operator requested plan revisions${note ? `: ${note}` : ''}.${plan ? `\n\nPrevious plan:\n${plan}` : ''}`,
          )
        } else {
          this.teardown(ctx)
          this.finishRun(run.id, 'canceled', `Stopped at plan approval.${note ? ` Note: ${note}` : ''}`)
        }
        return true
      }
      case 'completion-approval': {
        if (choice === 'approve') {
          // finalizeRun stops the maker itself; no fresh session needed.
          await this.finalizeRun(ctx, run)
        } else {
          await this.resumeActing(ctx, run, `The operator rejected completion.${note ? ` Feedback: ${note}` : ''} Address this and continue.`)
        }
        return true
      }
      case 'budget-extension': {
        if (choice === 'extend') {
          ctx.budgetExtensions += 1
          this.checkpoint(ctx)
          this.store.appendEvent({ runId: run.id, type: 'budget_extended', actor: { type: 'user' }, payload: { extensions: ctx.budgetExtensions } })
          await this.resumeActing(ctx, run, 'The operator extended the budget. Continue working toward the outcome.')
        } else {
          this.teardown(ctx)
          this.finishRun(run.id, 'failed', 'Budget exhausted; stopped with partial result by the operator.')
        }
        return true
      }
      case 'escalation':
      default: {
        if (choice === 'continue') {
          await this.resumeActing(ctx, run, `The operator reviewed the escalation and chose to continue.${note ? ` Guidance: ${note}` : ''}`)
        } else {
          this.teardown(ctx)
          this.finishRun(run.id, 'canceled', `Stopped by the operator at an escalation.${note ? ` Note: ${note}` : ''}`)
        }
        return true
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pause / resume / cancel / steer
  // -------------------------------------------------------------------------

  /** Pause after the current safe boundary (immediately when already between turns). */
  pause(runId: string): boolean {
    const run = this.store.getRun(runId)
    if (!run || run.state === 'done' || run.state === 'paused' || run.state === 'awaiting_approval') return false
    const ctx = this.active.get(runId)
    this.store.appendEvent({ runId, type: 'pause_requested', actor: { type: 'user' }, payload: {} })
    if (!ctx) {
      // No live context (shouldn't happen for active states post-recovery) — park directly.
      this.setState(runId, 'paused', 'Paused by the user.')
      return true
    }
    if (ctx.processing || ctx.reviewProcessing) {
      ctx.pauseRequested = true
      this.setState(runId, 'pausing', 'Pausing after the current step…')
      return true
    }
    this.parkPaused(ctx, run)
    return true
  }

  private parkPaused(ctx: RunCtx, run: LoopRun): void {
    if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
    this.disposeReview(ctx)
    this.checkpoint(ctx)
    this.setState(run.id, 'paused', 'Paused by the user.')
    this.store.appendEvent({ runId: run.id, type: 'paused', actor: { type: 'user' }, payload: { turn: ctx.turnCount } })
    this.teardown(ctx)
  }

  /** Resume a paused run: fresh session, surviving worktree, regenerated context. */
  async resume(runId: string): Promise<boolean> {
    const run = this.store.getRun(runId)
    if (!run || run.state !== 'paused') return false
    const ctx = await this.reviveCtx(run)
    if (!ctx) {
      this.finishRun(runId, 'failed', 'Could not resume: run context is not recoverable (worktree missing?)')
      return false
    }
    this.store.appendEvent({ runId, type: 'resumed', actor: { type: 'user' }, payload: {} })
    await this.resumeActing(ctx, run, 'Resuming after a pause.')
    return true
  }

  /** Stop now. The worktree is kept for inspection; sessions are killed. */
  cancel(runId: string): boolean {
    const run = this.store.getRun(runId)
    if (!run || run.state === 'done') return false
    const ctx = this.active.get(runId)
    this.store.appendEvent({ runId, type: 'cancel_requested', actor: { type: 'user' }, payload: {} })
    if (ctx) {
      if (ctx.processing || ctx.reviewProcessing) {
        ctx.cancelRequested = true
        this.setState(runId, 'canceling')
        return true
      }
      this.completeCancel(ctx, run)
      return true
    }
    this.finishRun(runId, 'canceled', 'Canceled by the user.')
    return true
  }

  private completeCancel(ctx: RunCtx, run: LoopRun): void {
    if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
    this.disposeReview(ctx)
    this.teardown(ctx)
    this.finishRun(run.id, 'canceled', 'Canceled by the user.')
  }

  /**
   * Queue an operator instruction. It reaches the maker at the next safe
   * boundary (mid-turn injection interleaves unpredictably across providers);
   * for a waiting run it is delivered on resume.
   */
  steer(runId: string, instruction: string, revisePlan = false): boolean {
    const run = this.store.getRun(runId)
    if (!run || run.state === 'done') return false
    this.store.appendEvent({ runId, type: 'steer_received', actor: { type: 'user' }, payload: { instruction, revisePlan } })
    if (revisePlan) {
      instruction = `Before continuing, revise your plan to account for this, state the revised plan, then follow it: ${instruction}`
    }
    const ctx = this.active.get(runId)
    if (ctx) {
      ctx.steerQueue.push(instruction)
    } else {
      // Waiting run: persist via checkpoint so resume picks it up.
      const cp = this.store.latestCheckpoint(runId)
      const state = (cp?.state ?? freshCheckpointState()) as CheckpointState & { steerQueue?: string[] }
      state.steerQueue = [...(state.steerQueue ?? []), instruction]
      this.store.saveCheckpoint(runId, state)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Boot-time reconciliation. Never blanket-fails: durable wait states are
   * left waiting; interrupted active runs resume at a stage boundary in their
   * surviving worktree; only unrecoverable runs (missing worktree/repo) fail.
   */
  async recoverAll(): Promise<{ resumed: string[]; waiting: string[]; failed: string[] }> {
    const resumed: string[] = []
    const waiting: string[] = []
    const failed: string[] = []
    for (const run of this.store.listRuns({ activeOnly: true })) {
      if (this.active.has(run.id)) continue
      if (run.state === 'paused' || run.state === 'awaiting_approval') {
        waiting.push(run.id)
        continue
      }
      this.setState(run.id, 'recovering', 'Reconciling after a server restart.')
      this.store.appendEvent({ runId: run.id, type: 'recovery_started', payload: { fromState: run.state } })
      try {
        if (run.state === 'canceling') {
          this.finishRun(run.id, 'canceled', 'Cancel completed after restart.')
          continue
        }
        if (run.state === 'pausing') {
          this.setState(run.id, 'paused', 'Paused (recovered after restart).')
          waiting.push(run.id)
          continue
        }
        const ctx = await this.reviveCtx(run)
        if (!ctx) {
          this.finishRun(run.id, 'failed', 'Interrupted by a restart and the worktree is no longer available.')
          failed.push(run.id)
          continue
        }
        if (run.state === 'finalizing') {
          await this.finalizeRun(ctx, run) // idempotent: re-commit is a no-op, existing PR is recovered
          resumed.push(run.id)
          continue
        }
        if (run.state === 'monitoring_ci') {
          this.startCiMonitoring(ctx, run) // the poll window restarts; the checks are remote state
          resumed.push(run.id)
          continue
        }
        await this.resumeActing(ctx, run, 'Codekin restarted while this run was in flight. Reassess the current state of the worktree and continue toward the outcome.')
        resumed.push(run.id)
      } catch (err) {
        this.finishRun(run.id, 'failed', `Recovery failed: ${errMsg(err)}`)
        failed.push(run.id)
      }
    }
    return { resumed, waiting, failed }
  }

  /** Rebuild a runtime context for a run without one (restart or wait state). */
  private async reviveCtx(run: LoopRun): Promise<RunCtx | null> {
    const existing = this.active.get(run.id)
    if (existing) return existing
    const cwd = run.worktreePath ?? run.repo
    if (!existsSync(cwd)) return null
    const cp = this.store.latestCheckpoint(run.id)
    const state = { ...freshCheckpointState(), ...((cp?.state as Partial<CheckpointState> | undefined) ?? {}) }
    const ctx = this.buildCtx(run.id, cwd, state)
    const savedSteers = (cp?.state as { steerQueue?: string[] } | undefined)?.steerQueue
    if (savedSteers?.length) ctx.steerQueue.push(...savedSteers)
    this.active.set(run.id, ctx)
    return ctx
  }

  /** Restart the maker at a stage boundary (resume/recovery/intervention paths). */
  private async resumeActing(ctx: RunCtx, run: LoopRun, note: string): Promise<void> {
    const fresh = this.store.getRun(run.id) ?? run
    await this.beginActing(ctx, fresh, note)
  }

  // -------------------------------------------------------------------------
  // Session-prompt bridging
  // -------------------------------------------------------------------------

  /**
   * A maker/reviewer tool call fell through the allowlist and waits on a
   * human. Loop sessions are exempt from last-client-leave auto-deny, so
   * surface it: a state reason + event (the Phase 2 UI renders these as
   * inline cards; today the session view answers the prompt).
   */
  private onSessionBlocked(
    ctx: RunCtx,
    sessionId: string,
    promptType: 'permission' | 'question',
    toolName: string | undefined,
    requestId: string | undefined,
  ): void {
    const role = sessionId === ctx.makerSessionId ? 'maker' : sessionId === ctx.reviewSessionId ? 'reviewer' : null
    if (!role) return
    const run = this.store.getRun(ctx.runId)
    if (!run || !this.active.has(ctx.runId)) return
    const dedupKey = requestId ?? `${sessionId}:${toolName ?? promptType}`
    if (ctx.notedPromptIds.has(dedupKey)) return
    ctx.notedPromptIds.add(dedupKey)
    const what = promptType === 'question' ? 'a question' : `approval for ${toolName ?? 'a tool'}`
    this.store.patchRun(run.id, { stateReason: `The ${role} session is waiting on ${what}.` })
    this.store.appendEvent({
      runId: run.id,
      type: 'session_blocked',
      actor: { type: 'agent', id: role },
      payload: { sessionId, promptType, toolName: toolName ?? null, requestId: requestId ?? null },
    })
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  private sendMakerFeedback(ctx: RunCtx, run: LoopRun, message: string): void {
    const steers = this.drainSteers(ctx)
    const full = steers ? `${steers}\n\n${message}` : message
    // No live maker (post-intervention or worker-only phase): restart one at
    // the stage boundary with the feedback as its context.
    if (!ctx.makerSessionId) {
      void this.resumeActing(ctx, run, full)
      return
    }
    this.host.sendInput(ctx.makerSessionId, full)
    this.setState(run.id, 'executing')
  }

  private drainSteers(ctx: RunCtx): string | null {
    if (!ctx.steerQueue.length) return null
    const text = ctx.steerQueue.map((s) => `Operator instruction: ${s}`).join('\n')
    ctx.steerQueue = []
    return text
  }

  private setState(runId: string, state: LoopRunState, reason?: string): void {
    this.store.patchRun(runId, { state, stateReason: reason ?? null })
    this.store.appendEvent({ runId, type: 'state_changed', payload: { state, reason: reason ?? null } })
  }

  private finishRun(runId: string, outcome: LoopRunOutcome, reason: string): void {
    this.store.patchRun(runId, { state: 'done', outcome, stateReason: reason, completedAt: new Date().toISOString() })
    if (outcome === 'canceled' || outcome === 'failed') this.store.cancelPendingInterventions(runId)
    this.store.appendEvent({ runId, type: 'run_completed', payload: { outcome, reason } })
    const ctx = this.active.get(runId)
    if (ctx) {
      if (ctx.makerSessionId) this.host.stopClaude(ctx.makerSessionId)
      this.disposeReview(ctx)
      this.teardown(ctx)
    }
    if (outcome !== 'canceled') {
      this.reflect(runId)
      const finished = this.store.getRun(runId)
      if (finished?.recipe.policy.reflection === 'model') {
        this.modelReflect(finished).catch((err: unknown) => {
          console.error(`[loop-engine] Model reflection for run ${runId} failed:`, err)
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reflection → suggested lessons (spec §11)
  // -------------------------------------------------------------------------

  /**
   * Deterministic reflection over the finished run's own evidence — no model
   * call. Each finding becomes a `suggested` lesson scoped to the recipe; a
   * user approves it into future runs' context or rejects it. Nothing here
   * ever rewrites a recipe or policy.
   */
  private reflect(runId: string): void {
    const run = this.store.getRun(runId)
    if (!run) return
    const evaluations = this.store.listEvaluations(runId)
    const events = this.store.listEvents(runId, 0, 1000)
    const existing = new Set(this.store.listLessons(run.recipeId).map((l) => l.text))
    const suggest = (kind: string, text: string) => {
      if (existing.has(text)) return
      existing.add(text)
      const lesson = this.store.addLesson({ recipeId: run.recipeId, sourceRunId: runId, kind, text })
      this.store.appendEvent({ runId, type: 'lesson_suggested', payload: { lessonId: lesson.id, kind, text } })
    }

    // Transient environment errors on evaluators without a retry allowance.
    for (const ev of evaluations) {
      if (ev.status !== 'error' || ev.classification !== 'environment') continue
      const config = run.recipe.evaluators.find((e) => e.id === ev.evaluatorId)
      if (config && (config.type === 'command' || config.type === 'test-report') && config.retryMaxAttempts <= 1) {
        suggest('retry-policy', `Evaluator "${ev.evaluatorId}" hit a transient environment error; consider retry: { maxAttempts: 2 }.`)
      }
    }

    // Budget pressure: finished close to (or at) a cap.
    if (run.outcome === 'completed' || run.outcome === 'completed_with_warnings') {
      if (run.turnCount >= Math.ceil(run.recipe.budgets.turns * 0.8)) {
        suggest('budget', `Runs complete near the turn cap (${run.turnCount}/${run.recipe.budgets.turns}); consider raising budgets.turns.`)
      }
      if (run.costUsd >= run.recipe.budgets.costUsd * 0.8) {
        suggest('budget', `Runs complete near the cost cap ($${run.costUsd.toFixed(2)}/$${run.recipe.budgets.costUsd}); consider raising budgets.costUsd.`)
      }
    }
    if (run.outcome === 'failed' && (run.stateReason?.includes('budget') ?? false)) {
      suggest('budget', `A run failed at the budget boundary (${run.stateReason ?? ''}); consider larger budgets or a narrower outcome.`)
    }

    // Recurring reviewer pushback → the rubric wants standing guidance.
    const requestChanges = events.filter((e) => e.type === 'review_verdict' && (e.payload as { verdict?: string }).verdict === 'request_changes')
    if (requestChanges.length >= 2) {
      suggest('review-guidance', `The reviewer requested changes ${requestChanges.length}× in one run; consider adding standing instructions to the rubric evaluator.`)
    }

    // Protected paths kept getting touched → the outcome should name them.
    if (events.some((e) => e.type === 'protected_path_violation')) {
      suggest('outcome-guidance', `The agent modified protected paths; consider naming them explicitly in the outcome prompt.`)
    }
  }

  /** Approved lessons for a recipe — injected into maker/planning prompts. */
  private approvedLessons(run: LoopRun): string[] {
    return this.store.listLessons(run.recipeId, 'approved').map((l) => l.text)
  }

  /** Reflection sessions that outlive this cap are stopped — post-run work must never linger. */
  reflectionTimeoutMs = 5 * 60 * 1000

  /**
   * Model-based reflection (spec §11, opt-in via `policy.reflection: model`):
   * a read-only session reviews the finished run's recipe and trajectory and
   * proposes lessons in a strict `LESSON: <category> | <text>` format. Output
   * is parsed deterministically, capped, deduped, and lands as `suggested`
   * next to the free heuristics — approval stays with the operator, always.
   * The full reflection text is retained as an artifact for evidence.
   */
  private modelReflect(run: LoopRun): Promise<void> {
    return new Promise((resolve) => {
      const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : run.repo
      if (!existsSync(cwd)) {
        resolve()
        return
      }
      const session = this.host.create(`loop:${run.recipeId}:reflect`, cwd, {
        provider: run.provider,
        model: run.model ?? undefined,
        source: 'agent',
        allowedTools: READONLY_AGENT_ALLOWED_TOOLS,
      })
      let done = false
      let dispose = () => {}
      const timer = setTimeout(() => {
        if (done) return
        done = true
        dispose()
        this.host.stopClaude(session.id)
        this.store.appendEvent({ runId: run.id, type: 'reflection_timeout', payload: { sessionId: session.id } })
        resolve()
      }, this.reflectionTimeoutMs)
      timer.unref?.()

      dispose = this.host.onSessionResult((sid, isError) => {
        if (sid !== session.id || done) return
        done = true
        clearTimeout(timer)
        dispose()
        const history = this.host.get(session.id)?.outputHistory ?? []
        const costUsd = readCumulativeCost(history)
        this.host.stopClaude(session.id)
        const text = extractAssistantText(history)

        if (!isError && text.trim()) {
          const artifactHash = this.artifacts.put(text)
          const artifact = this.store.addArtifact({
            runId: run.id,
            kind: 'reflection',
            label: 'model reflection',
            contentHash: artifactHash,
            sizeBytes: Buffer.byteLength(text),
          })
          const existing = new Set(this.store.listLessons(run.recipeId).map((l) => l.text))
          const suggested: string[] = []
          for (const lesson of parseReflectionLessons(text)) {
            if (existing.has(lesson.text)) continue
            existing.add(lesson.text)
            const row = this.store.addLesson({ recipeId: run.recipeId, sourceRunId: run.id, kind: lesson.category, text: lesson.text })
            suggested.push(row.id)
          }
          if (costUsd > 0) this.store.patchRun(run.id, { costUsd: run.costUsd + costUsd })
          this.store.appendEvent({
            runId: run.id,
            type: 'reflection_completed',
            actor: { type: 'agent', id: 'reflection' },
            payload: { suggested: suggested.length, artifactId: artifact.id, costUsd },
          })
        } else {
          this.store.appendEvent({ runId: run.id, type: 'reflection_completed', payload: { suggested: 0, error: isError } })
        }
        resolve()
      })

      this.host.startClaude(session.id)
      this.host.sendInput(session.id, buildReflectionPrompt(run, this.trajectorySummary(run)))
    })
  }

  /** Condensed, factual trajectory for the reflection prompt — evidence, not chat. */
  private trajectorySummary(run: LoopRun): string {
    const lines: string[] = []
    const evaluations = this.store.listEvaluations(run.id)
    for (const ev of evaluations.slice(-30)) lines.push(`evaluation ${ev.evaluatorId}: ${ev.status} — ${ev.summary}`)
    for (const iv of this.store.listInterventions(run.id)) {
      lines.push(`intervention (${iv.purpose}): ${iv.title} → ${iv.resolution?.choice ?? iv.status}${iv.resolution?.note ? ` (${iv.resolution.note})` : ''}`)
    }
    const notable = this.store
      .listEvents(run.id, 0, 1000)
      .filter((e) => ['protected_path_violation', 'budget_boundary', 'wall_time_exceeded', 'integration_conflict', 'session_blocked'].includes(e.type))
    for (const e of notable.slice(-15)) lines.push(`event ${e.type}: ${JSON.stringify(e.payload)}`)
    lines.push(`final: ${run.outcome ?? 'unknown'} after ${run.turnCount} turns, $${run.costUsd.toFixed(2)}${run.stateReason ? ` — ${run.stateReason}` : ''}`)
    return lines.join('\n')
  }

  // -------------------------------------------------------------------------
  // Checkpoint fork
  // -------------------------------------------------------------------------

  /**
   * Fork a run into a new one that starts from the source's current worktree
   * state — including uncommitted work, captured via `git stash create` (which
   * writes a commit without touching the tree). The fork gets fresh budgets,
   * the source's frozen recipe and goal, and a context note carrying the
   * source plan; both runs record the relationship as events.
   */
  async forkRun(runId: string): Promise<LoopRun | null> {
    const source = this.store.getRun(runId)
    if (!source || !source.worktreePath || !existsSync(source.worktreePath)) return null
    const cwd = source.worktreePath

    let sha: string
    try {
      await this.evaluator.git(['add', '-A'], cwd)
      sha = (await this.evaluator.git(['stash', 'create'], cwd)).trim()
    } finally {
      await this.evaluator.git(['reset'], cwd).catch(() => {})
    }
    if (!sha) sha = (await this.evaluator.git(['rev-parse', 'HEAD'], cwd)).trim()

    const forkBranch = `${source.branch}-fork-${Date.now().toString(36)}`
    const fork = this.store.createRun({
      recipe: source.recipe,
      goal: source.goal,
      repo: source.repo,
      branch: forkBranch,
      // The capture commit is the literal start point for the fork's worktree.
      baseBranch: sha,
      provider: source.provider,
      model: source.model,
    })
    this.store.patchRun(fork.id, { baseSha: sha, startedAt: new Date().toISOString() })
    this.store.appendEvent({ runId: fork.id, type: 'forked_from', actor: { type: 'user' }, payload: { sourceRunId: source.id, atTurn: source.turnCount, sha } })
    this.store.appendEvent({ runId: source.id, type: 'fork_created', actor: { type: 'user' }, payload: { forkRunId: fork.id, branch: forkBranch } })

    const ctx = this.buildCtx(fork.id, source.repo, freshCheckpointState())
    if (source.recipe.plan.required) ctx.phase = 'planning'
    this.checkpoint(ctx)
    this.active.set(fork.id, ctx)
    const sourcePlan = this.latestPlanText(source.id)
    const lastEval = this.store.listEvaluations(source.id).at(-1)
    await this.beginActing(
      ctx,
      this.store.getRun(fork.id) ?? fork,
      [
        `This run was forked from run ${source.id} at turn ${source.turnCount}; the worktree starts from that run's exact state.`,
        `Explore a different approach than the source run.`,
        sourcePlan ? `\nSource run's plan:\n${sourcePlan}` : '',
        lastEval ? `\nSource run's latest evaluation: ${lastEval.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return this.store.getRun(fork.id)
  }

  private checkpoint(ctx: RunCtx): void {
    const state: CheckpointState & { steerQueue?: string[] } = {
      phase: ctx.phase,
      turnCount: ctx.turnCount,
      makerCostUsd: ctx.makerCostUsd,
      reviewCostUsd: ctx.reviewCostUsd,
      lastDiffSummary: ctx.lastDiffSummary,
      lastFingerprints: ctx.lastFingerprints,
      noProgressCount: ctx.noProgressCount,
      protectedStrikes: ctx.protectedStrikes,
      budgetExtensions: ctx.budgetExtensions,
      pendingHumanIds: ctx.pendingHumanIds,
    }
    if (ctx.steerQueue.length) state.steerQueue = [...ctx.steerQueue]
    this.store.saveCheckpoint(ctx.runId, state)
  }

  private totalCost(ctx: RunCtx): number {
    return ctx.makerCostUsd + ctx.reviewCostUsd
  }

  private teardown(ctx: RunCtx): void {
    for (const sid of ctx.workerSessionIds) this.host.stopClaude(sid)
    ctx.workerSessionIds = []
    this.clearWallTimer(ctx)
    if (ctx.ciTimer) {
      clearTimeout(ctx.ciTimer)
      ctx.ciTimer = null
    }
    for (const dispose of ctx.disposers) dispose()
    ctx.disposers = []
    this.active.delete(ctx.runId)
  }
}

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

export function buildMakerPrompt(
  run: LoopRun,
  remaining: { turns: number; costUsd: number },
  resumeNote: string | null,
  steers: string | null,
  lessons: string[] = [],
): string {
  const commands = run.recipe.evaluators.filter((e) => e.type === 'command')
  const lines = [
    `# Loop Run: ${run.recipe.name}`,
    '',
    `## Outcome`,
    run.goal,
    '',
    `## Acceptance (these evaluators must pass)`,
    ...commands.map((c) => `- \`${displayCommand(c.command)}\`${c.required ? '' : ' (optional)'}`),
  ]
  if (run.recipe.evaluators.some((e) => e.type === 'rubric')) {
    lines.push(`- an independent reviewer will assess the final diff against the outcome`)
  }
  if (run.recipe.workspace.protectedPaths.length) {
    lines.push('', `## Do NOT modify these paths`, ...run.recipe.workspace.protectedPaths.map((g) => `- \`${g}\``))
  }
  lines.push(
    '',
    `## Rules`,
    `- Work on branch \`${run.branch}\` in this worktree.`,
    `- Make the smallest change that achieves the outcome. Do not weaken or delete tests to pass evaluation.`,
    `- Evaluators run after each of your turns; failures come back to you as feedback.`,
    `- Remaining budget: ${remaining.turns} turns, $${remaining.costUsd.toFixed(2)}.`,
  )
  if (lessons.length) lines.push('', `## Lessons from previous runs (operator-approved)`, ...lessons.map((l) => `- ${l}`))
  if (resumeNote) lines.push('', `## Note`, resumeNote)
  if (steers) lines.push('', steers)
  return lines.join('\n')
}

export function buildPlanningPrompt(run: LoopRun, resumeNote: string | null, steers: string | null, lessons: string[] = []): string {
  const commands = run.recipe.evaluators.filter((e) => e.type === 'command')
  const lines = [
    `# Loop Run: ${run.recipe.name} — Planning`,
    '',
    `## Outcome`,
    run.goal,
    '',
    `## Acceptance (these evaluators must eventually pass)`,
    ...commands.map((c) => `- \`${displayCommand(c.command)}\`${c.required ? '' : ' (optional)'}`),
  ]
  if (run.recipe.workspace.protectedPaths.length) {
    lines.push('', `## Paths that must NOT change`, ...run.recipe.workspace.protectedPaths.map((g) => `- \`${g}\``))
  }
  lines.push(
    '',
    `## Your task — plan only`,
    `Investigate the repository as needed, then reply with a concrete implementation plan BEFORE modifying any files:`,
    `- numbered steps, each naming the files you expect to touch;`,
    `- how the change will be verified against the evaluators above;`,
    `- risks or open questions, if any.`,
    `Do NOT modify any files yet. End your reply with the plan.`,
  )
  if (run.recipe.workers.maxParallel > 1) {
    lines.push(
      '',
      `## Optional: parallel workstreams (up to ${run.recipe.workers.maxParallel})`,
      `If — and only if — the work splits into truly independent parts that touch disjoint paths, declare them at the end of the plan, one block each:`,
      '```',
      'WORKSTREAM: <short-name>',
      'SCOPE: <comma-separated path globs this stream may touch>',
      'TASK: <what this stream does>',
      '```',
      `Scopes must not overlap. When in doubt, declare none — sequential execution is the default.`,
    )
  }
  if (lessons.length) lines.push('', `## Lessons from previous runs (operator-approved)`, ...lessons.map((l) => `- ${l}`))
  if (resumeNote) lines.push('', `## Note`, resumeNote)
  if (steers) lines.push('', steers)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Model reflection (pure)
// ---------------------------------------------------------------------------

export const REFLECTION_CATEGORIES = ['evaluator', 'context', 'plan', 'classification', 'budget'] as const
export type ReflectionCategory = (typeof REFLECTION_CATEGORIES)[number]

/** Cap on lessons accepted from one reflection pass. */
const MAX_REFLECTION_LESSONS = 5

/**
 * Parse `LESSON: <category> | <text>` lines. Unknown categories and malformed
 * lines are dropped; at most MAX_REFLECTION_LESSONS survive — the model
 * proposes, deterministic code decides what is even eligible for review.
 */
export function parseReflectionLessons(text: string): Array<{ category: ReflectionCategory; text: string }> {
  const lessons: Array<{ category: ReflectionCategory; text: string }> = []
  for (const m of text.matchAll(/^LESSON:\s*([a-z-]+)\s*\|\s*(.+)$/gim)) {
    const category = m[1].toLowerCase()
    const body = m[2].trim()
    if (!REFLECTION_CATEGORIES.includes(category as ReflectionCategory)) continue
    if (!body || body.length > 500) continue
    if (lessons.some((l) => l.text === body)) continue
    lessons.push({ category: category as ReflectionCategory, text: body })
    if (lessons.length >= MAX_REFLECTION_LESSONS) break
  }
  return lessons
}

export function buildReflectionPrompt(run: LoopRun, trajectory: string): string {
  const evaluators = run.recipe.evaluators.map((e) => `  - ${e.id} (${e.type}${e.required ? '' : ', optional'})`)
  const lines = [
    `# Loop Run Reflection: ${run.recipe.name}`,
    '',
    `A loop run just finished. Review how it went and suggest improvements to the RECIPE — not to the code it produced.`,
    '',
    `## Outcome pursued`,
    run.goal,
    '',
    `## Recipe`,
    `- mode: ${run.recipe.policy.mode}; budgets: ${run.recipe.budgets.turns} turns, $${run.recipe.budgets.costUsd}`,
    `- evaluators:`,
    ...evaluators,
  ]
  if (run.recipe.workspace.protectedPaths.length) {
    lines.push(`- protected paths: ${run.recipe.workspace.protectedPaths.join(', ')}`)
  }
  lines.push(
    '',
    `## What actually happened`,
    trajectory,
    '',
    `## Your job`,
    `Suggest at most ${MAX_REFLECTION_LESSONS} high-confidence lessons that would make FUTURE runs of this recipe succeed faster or more safely. Only suggest what this run's evidence supports. You may inspect the repository read-only.`,
    `Categories: evaluator (a missing or misconfigured check), context (repo knowledge the agent lacked), plan (a better plan pattern), classification (a command or failure classified wrongly), budget (limits mis-sized).`,
    '',
    `## Required format`,
    `One line per lesson, nothing else on those lines:`,
    '`LESSON: <category> | <one concrete, self-contained sentence>`',
    `If the run's evidence supports no lesson, reply exactly: NO LESSONS`,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Workstreams (pure)
// ---------------------------------------------------------------------------

export interface Workstream {
  name: string
  /** Globs the stream may touch — enforced deterministically after the fact. */
  scopes: string[]
  task: string
}

/**
 * Parse WORKSTREAM blocks out of a plan:
 *
 *   WORKSTREAM: backend
 *   SCOPE: server/**
 *   TASK: Move the API handlers ...
 *
 * Anything malformed is dropped — a plan without valid streams simply runs
 * sequentially.
 */
export function parseWorkstreams(planText: string): Workstream[] {
  const streams: Workstream[] = []
  const blocks = planText.split(/^WORKSTREAM:\s*/m).slice(1)
  for (const block of blocks) {
    const newline = block.indexOf('\n')
    const name = (newline === -1 ? block : block.slice(0, newline)).trim()
    const body = newline === -1 ? '' : block.slice(newline + 1)
    const scopeMatch = /^SCOPE:\s*(.+)$/m.exec(body)
    const taskMatch = /^TASK:\s*([\s\S]*)$/m.exec(body)
    if (!name || !scopeMatch || !taskMatch) continue
    const scopes = scopeMatch[1].split(',').map((g) => g.trim()).filter(Boolean)
    const task = taskMatch[1].trim()
    if (scopes.length && task) streams.push({ name, scopes, task })
  }
  return streams
}

/**
 * Conservative disjointness: compare the literal prefixes (up to the first
 * glob character) across streams — if any prefix contains another, the
 * streams could touch the same files and parallelism is refused.
 */
export function workstreamScopesDisjoint(streams: Workstream[]): boolean {
  const prefixes = streams.map((s) => s.scopes.map((g) => g.split(/[*?[]/)[0]))
  for (let i = 0; i < streams.length; i++) {
    for (let j = i + 1; j < streams.length; j++) {
      for (const a of prefixes[i]) {
        for (const b of prefixes[j]) {
          if (a.startsWith(b) || b.startsWith(a)) return false
        }
      }
    }
  }
  return true
}

export function buildWorkerPrompt(run: LoopRun, stream: Workstream): string {
  return [
    `# Loop Workstream: ${stream.name} (${run.recipe.name})`,
    '',
    `## Overall outcome`,
    run.goal,
    '',
    `## Your workstream`,
    stream.task,
    '',
    `## Hard constraints`,
    `- You may ONLY modify files matching: ${stream.scopes.join(', ')}`,
    `- Other workstreams run in parallel on the rest of the codebase — do not touch anything outside your scope.`,
    `- Make the smallest change that completes your workstream. Do not weaken or delete tests.`,
    `- You have ONE working session; finish the workstream in it. Your changes are committed and integrated automatically.`,
  ].join('\n')
}

export function buildPrTitle(run: LoopRun): string {
  const firstLine = run.goal.split('\n')[0].trim()
  return firstLine ? `${run.recipeId}: ${firstLine}` : `${run.recipeId} (loop run)`
}

export function buildPrBody(run: LoopRun): string {
  const commands = run.recipe.evaluators.filter((e) => e.type === 'command')
  return [
    run.goal.trim(),
    '',
    '## Evaluation',
    ...commands.map((c) => `- \`${displayCommand(c.command)}\``),
    '',
    `Opened automatically by a Codekin loop run (\`${run.recipeId}\`). Do not merge without review.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Latest cumulative session cost from the usage messages in output history. */
function readCumulativeCost(history: HistoryMsg[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.type === 'usage' && typeof m.costUsd === 'number') return m.costUsd
  }
  return 0
}

/** Concatenate the assistant's text output from a session's history. */
function extractAssistantText(history: HistoryMsg[]): string {
  let out = ''
  for (const m of history) {
    if (m.type === 'output' && typeof m.data === 'string') out += m.data
  }
  return out
}

function isRequired(recipe: LoopRecipe, evaluatorId: string): boolean {
  return recipe.evaluators.find((e) => e.id === evaluatorId)?.required ?? true
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
