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
  getDiffSummary,
  getDiff,
  getChangedFiles,
  buildRubricPrompt,
  parseRubricVerdict,
  displayCommand,
  type CommandEvaluationOutcome,
} from './loop-evaluators.js'
import { defaultLoopFinalizer, type LoopFinalizerApi } from './loop-finalizer.js'
import { resolveRubricProvider, type LoopProvider, type LoopRecipe, type RubricEvaluatorConfig, type CommandEvaluatorConfig } from './loop-recipe.js'
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
  getDiffSummary(cwd: string): Promise<string>
  getDiff(cwd: string): Promise<string>
  getChangedFiles(cwd: string): Promise<string[]>
  revParseHead(repo: string, ref?: string): Promise<string>
}

const defaultEvaluatorApi: LoopEvaluatorApi = {
  runCommandEvaluator,
  getDiffSummary,
  getDiff,
  getChangedFiles,
  revParseHead: async (repo, ref) => (await execGit(['rev-parse', ref ?? 'HEAD'], repo)).trim(),
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
  wallTimer: NodeJS.Timeout | null
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
    const prompt = planning
      ? buildPlanningPrompt(run, resumeNote, this.drainSteers(ctx))
      : buildMakerPrompt(run, this.remaining(ctx, run), resumeNote, this.drainSteers(ctx))
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
      wallTimer: null,
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

  /** Same session continues from plan to execution. */
  private proceedToActing(ctx: RunCtx, run: LoopRun): void {
    ctx.phase = 'acting'
    this.checkpoint(ctx)
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

    const commands = run.recipe.evaluators.filter((e): e is CommandEvaluatorConfig => e.type === 'command')
    const rubrics = run.recipe.evaluators.filter((e): e is RubricEvaluatorConfig => e.type === 'rubric')

    ctx.passedCommands = []
    const fingerprints: string[] = []
    let requiredFailure: CommandEvaluationOutcome | null = null

    for (const config of commands) {
      const outcome = await this.runCommandWithRetry(ctx, run, stage.id, config)
      if (outcome.status === 'pass') {
        ctx.passedCommands.push(outcome.command)
        continue
      }
      if (outcome.fingerprint) fingerprints.push(outcome.fingerprint)
      if (config.required) {
        requiredFailure = outcome
        break // first required failure is what the maker needs to see next
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
    this.completionGate(ctx, run)
  }

  private async runCommandWithRetry(
    ctx: RunCtx,
    run: LoopRun,
    stageId: string,
    config: CommandEvaluatorConfig,
  ): Promise<CommandEvaluationOutcome> {
    let outcome: CommandEvaluationOutcome
    let attemptsLeft = Math.max(1, config.retryMaxAttempts)
    do {
      const attempt = this.store.createAttempt(stageId, run.id)
      outcome = await this.evaluator.runCommandEvaluator(config, ctx.cwd)
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
        `Evaluation failed.`,
        `Command: \`${failure.command}\``,
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
      this.completionGate(ctx, run)
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

    const warnings = this.collectWarnings(run, result.clean)
    this.finishRun(run.id, warnings.length ? 'completed_with_warnings' : 'completed', warnings.length ? warnings.join('; ') : result.note)
  }

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

    switch (resolved.purpose) {
      case 'plan-approval': {
        if (choice === 'approve') {
          ctx.phase = 'acting'
          this.checkpoint(ctx)
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
    if (ctx.makerSessionId) this.host.sendInput(ctx.makerSessionId, full)
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
    }
    if (ctx.steerQueue.length) state.steerQueue = [...ctx.steerQueue]
    this.store.saveCheckpoint(ctx.runId, state)
  }

  private totalCost(ctx: RunCtx): number {
    return ctx.makerCostUsd + ctx.reviewCostUsd
  }

  private teardown(ctx: RunCtx): void {
    this.clearWallTimer(ctx)
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
  if (resumeNote) lines.push('', `## Note`, resumeNote)
  if (steers) lines.push('', steers)
  return lines.join('\n')
}

export function buildPlanningPrompt(run: LoopRun, resumeNote: string | null, steers: string | null): string {
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
  if (resumeNote) lines.push('', `## Note`, resumeNote)
  if (steers) lines.push('', steers)
  return lines.join('\n')
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
