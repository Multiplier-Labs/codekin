/**
 * GoalRunController — the loop engine (Cut 1, single-provider).
 *
 * Drives a durable act → verify → continue/stop loop around an existing coding
 * session:
 *
 *   1. spawn a maker session in an isolated worktree on the run's branch
 *   2. send the goal prompt
 *   3. on each maker turn (onSessionResult):
 *        - update turn/cost budgets; stop with `failed` if exhausted
 *        - enforce readonly-glob constraints against the diff
 *        - run the deterministic verifier (debounced to changed diffs)
 *        - verify fails  → feed the failure back as the next turn
 *        - verify passes → finalize (completion policy 'pr'; never auto-merge)
 *
 * The maker–checker review pass (Cut 2) plugs in at the single seam marked
 * `onVerifyPassed` — when a checker provider is configured, that hook will spawn
 * a second-provider session on the maker's branch and route its verdict. Until
 * then, a passing verifier finalizes directly.
 *
 * Dependencies (SessionHost, VerifierApi) are injected so the loop logic is
 * unit-testable without spawning a real Claude process or touching git.
 */

import {
  GoalRunStore,
  type CreateGoalRunInput,
  type GoalRun,
  type GoalRunSpec,
  type LoopProvider,
} from './goal-run-store.js'
import {
  runVerifier,
  getDiffSummary,
  getChangedFiles,
  type VerifyResult,
} from './verifier-runner.js'
import { matchesAnyGlob } from './glob-match.js'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

interface CreateOpts {
  provider?: LoopProvider
  model?: string
  source?: 'agent'
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

/** The slice of SessionManager the controller depends on. */
export interface SessionHost {
  create(name: string, workingDir: string, options?: CreateOpts): { id: string }
  createWorktree(sessionId: string, workingDir: string, targetBranch?: string, baseBranch?: string): Promise<string | null>
  startClaude(sessionId: string): boolean
  sendInput(sessionId: string, data: string): void
  stopClaude(sessionId: string): void
  get(sessionId: string): SessionView | undefined
  onSessionResult(listener: (sessionId: string, isError: boolean) => void): () => void
}

/** The verifier surface — defaults to the real implementations. */
export interface VerifierApi {
  runVerifier(opts: { cwd: string; commands: string[] }): Promise<VerifyResult>
  getDiffSummary(cwd: string): Promise<string>
  getChangedFiles(cwd: string): Promise<string[]>
}

const defaultVerifier: VerifierApi = { runVerifier, getDiffSummary, getChangedFiles }

/** Max consecutive readonly-glob violations before escalating to a human. */
const MAX_READONLY_STRIKES = 2

// ---------------------------------------------------------------------------
// Per-run runtime context (not persisted — rebuilt from the store on restart)
// ---------------------------------------------------------------------------

interface RunCtx {
  runId: string
  makerSessionId: string
  cwd: string
  turnCount: number
  costUsd: number
  /** Diff stat at the last verify, used to debounce re-running the verifier. */
  lastDiff: string | null
  lastVerifyPassed: boolean
  readonlyStrikes: number
  /** Re-entrancy guard — one result is processed at a time per run. */
  processing: boolean
  dispose: () => void
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class GoalRunController {
  private active = new Map<string, RunCtx>()

  constructor(
    private readonly host: SessionHost,
    private readonly store: GoalRunStore,
    private readonly verifier: VerifierApi = defaultVerifier,
  ) {}

  /** Create and start a goal run. Resolves once the maker has been kicked off. */
  async startRun(input: CreateGoalRunInput): Promise<GoalRun> {
    const run = this.store.createRun(input)
    const session = this.host.create(`goal:${run.kind}:${run.branch}`, run.repo, {
      provider: run.spec.maker.provider,
      model: run.spec.maker.model,
      source: 'agent',
    })
    const worktree = await this.host.createWorktree(session.id, run.repo, run.branch)
    const cwd = worktree ?? run.repo

    this.store.patchRun(run.id, { status: 'running', makerSessionId: session.id })

    const ctx: RunCtx = {
      runId: run.id,
      makerSessionId: session.id,
      cwd,
      turnCount: 0,
      costUsd: 0,
      lastDiff: null,
      lastVerifyPassed: false,
      readonlyStrikes: 0,
      processing: false,
      dispose: () => {},
    }
    ctx.dispose = this.host.onSessionResult((sid, isError) => {
      if (sid !== ctx.makerSessionId) return
      void this.onMakerResult(ctx, isError)
    })
    this.active.set(run.id, ctx)

    this.host.startClaude(session.id)
    this.host.sendInput(session.id, buildMakerPrompt(run))
    return this.store.getRun(run.id) ?? run
  }

  /** Currently-tracked active run ids (test/introspection aid). */
  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  private async onMakerResult(ctx: RunCtx, isError: boolean): Promise<void> {
    if (ctx.processing) return
    ctx.processing = true
    try {
      const run = this.store.getRun(ctx.runId)
      if (!run || !this.active.has(ctx.runId)) return

      ctx.turnCount += 1
      ctx.costUsd = readCumulativeCost(this.host.get(ctx.makerSessionId)?.outputHistory ?? [])
      this.store.patchRun(run.id, { turnCount: ctx.turnCount, costUsd: ctx.costUsd })

      // A process-level error ends the turn with nothing to verify — treat a
      // failed result as a maker error and re-prompt within budget.
      if (isError) {
        if (this.budgetExhausted(ctx, run.spec)) {
          this.finalizeFailed(ctx, 'maker session errored and budget is exhausted')
          return
        }
        this.host.sendInput(ctx.makerSessionId, 'The previous turn ended with an error. Review the goal and continue.')
        this.store.patchRun(run.id, { status: 'running' })
        return
      }

      if (this.budgetExhausted(ctx, run.spec)) {
        this.finalizeFailed(ctx, budgetReason(ctx, run.spec))
        return
      }

      const changedFiles = await this.verifier.getChangedFiles(ctx.cwd)
      const diffSummary = await this.verifier.getDiffSummary(ctx.cwd)

      // Readonly enforcement: a touched protected path re-prompts the maker, and
      // repeated violations escalate rather than spin against the budget.
      const readonlyGlobs = run.spec.readonly ?? []
      const violations = readonlyGlobs.length
        ? changedFiles.filter((f) => matchesAnyGlob(f, readonlyGlobs))
        : []
      if (violations.length) {
        this.store.appendTurn({
          runId: run.id,
          turnIndex: ctx.turnCount,
          role: 'maker',
          diffSummary,
          outputTail: `Readonly violation: ${violations.join(', ')}`,
          costUsd: ctx.costUsd,
        })
        ctx.readonlyStrikes += 1
        if (ctx.readonlyStrikes > MAX_READONLY_STRIKES) {
          this.finalizeEscalated(ctx, `repeatedly modified readonly paths: ${violations.join(', ')}`)
          return
        }
        this.host.sendInput(ctx.makerSessionId, buildReadonlyFeedback(violations, readonlyGlobs))
        this.store.patchRun(run.id, { status: 'running' })
        return
      }
      ctx.readonlyStrikes = 0

      // Nothing changed yet — the maker hasn't produced a fix. Don't let a
      // clean tree masquerade as success; nudge and continue within budget.
      if (changedFiles.length === 0) {
        this.host.sendInput(ctx.makerSessionId, 'No file changes detected yet. Make the changes required to satisfy the goal.')
        this.store.patchRun(run.id, { status: 'running' })
        return
      }

      // Debounce: skip re-running verify when the diff is unchanged since last time.
      let result: VerifyResult
      if (diffSummary === ctx.lastDiff) {
        result = { passed: ctx.lastVerifyPassed, results: [] }
      } else {
        this.store.patchRun(run.id, { status: 'verifying' })
        result = await this.verifier.runVerifier({ cwd: ctx.cwd, commands: run.spec.verify })
        ctx.lastDiff = diffSummary
        ctx.lastVerifyPassed = result.passed
        const failing = result.results.find((r) => r.exitCode !== 0)
        this.store.appendTurn({
          runId: run.id,
          turnIndex: ctx.turnCount,
          role: 'verifier',
          diffSummary,
          verifyCmd: failing?.command ?? result.results[result.results.length - 1].command,
          exitCode: failing ? failing.exitCode : 0,
          outputTail: failing?.outputTail ?? null,
          costUsd: ctx.costUsd,
        })
      }

      if (result.passed) {
        this.onVerifyPassed(ctx, run)
        return
      }

      // Verify failed — feed the first failure back to the maker as the next turn.
      const failing = result.results.find((r) => r.exitCode !== 0)
      this.host.sendInput(ctx.makerSessionId, buildVerifyFeedback(failing?.command, failing?.outputTail))
      this.store.patchRun(run.id, { status: 'running' })
    } finally {
      ctx.processing = false
    }
  }

  /**
   * Seam for Cut 2 (maker–checker). When `spec.checker` is set, this is where a
   * second-provider checker session will be spawned on the maker's branch and
   * its verdict routed (approve → finalize, request_changes → re-prompt maker,
   * escalate → human). For Cut 1 a passing verifier finalizes directly.
   */
  private onVerifyPassed(ctx: RunCtx, run: GoalRun): void {
    this.host.sendInput(ctx.makerSessionId, buildFinalizePrompt(run.spec))
    this.store.appendTurn({
      runId: run.id,
      turnIndex: ctx.turnCount,
      role: 'maker',
      diffSummary: ctx.lastDiff,
      outputTail: 'Verification passed; finalize instruction sent.',
      costUsd: ctx.costUsd,
    })
    this.store.patchRun(run.id, { status: 'succeeded', completedAt: new Date().toISOString() })
    this.teardown(ctx)
  }

  private budgetExhausted(ctx: RunCtx, spec: GoalRunSpec): boolean {
    return ctx.turnCount >= spec.maxTurns || ctx.costUsd >= spec.maxCostUsd
  }

  private finalizeFailed(ctx: RunCtx, reason: string): void {
    this.store.appendTurn({ runId: ctx.runId, turnIndex: ctx.turnCount, role: 'verifier', outputTail: reason, costUsd: ctx.costUsd })
    this.store.patchRun(ctx.runId, { status: 'failed', completedAt: new Date().toISOString() })
    this.host.stopClaude(ctx.makerSessionId)
    this.teardown(ctx)
  }

  private finalizeEscalated(ctx: RunCtx, reason: string): void {
    this.store.appendTurn({ runId: ctx.runId, turnIndex: ctx.turnCount, role: 'verifier', outputTail: `Escalated: ${reason}`, costUsd: ctx.costUsd })
    this.store.patchRun(ctx.runId, { status: 'awaiting_human', completedAt: new Date().toISOString() })
    this.host.stopClaude(ctx.makerSessionId)
    this.teardown(ctx)
  }

  private teardown(ctx: RunCtx): void {
    ctx.dispose()
    this.active.delete(ctx.runId)
  }
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

function budgetReason(ctx: RunCtx, spec: GoalRunSpec): string {
  if (ctx.turnCount >= spec.maxTurns) return `turn budget exhausted (${ctx.turnCount}/${spec.maxTurns})`
  return `cost budget exhausted ($${ctx.costUsd.toFixed(2)}/$${spec.maxCostUsd.toFixed(2)})`
}

export function buildMakerPrompt(run: GoalRun): string {
  const lines = [
    `# Goal Run: ${run.kind}`,
    '',
    `## Goal`,
    run.goal,
    '',
    `## Verification (these commands must pass)`,
    ...run.spec.verify.map((c) => `- \`${c}\``),
  ]
  if (run.spec.readonly && run.spec.readonly.length) {
    lines.push('', `## Do NOT modify these paths`, ...run.spec.readonly.map((g) => `- \`${g}\``))
  }
  lines.push(
    '',
    `## Rules`,
    `- Work on branch \`${run.branch}\` in this worktree.`,
    `- Make the smallest change that satisfies the goal. Do not weaken or delete tests to pass verification.`,
    `- I will run the verification commands after each turn and report failures back to you.`,
  )
  return lines.join('\n')
}

export function buildVerifyFeedback(command: string | undefined, outputTail: string | null | undefined): string {
  return [
    `Verification failed.`,
    command ? `Command: \`${command}\`` : '',
    outputTail ? `\nOutput:\n${outputTail}` : '',
    `\nFix the cause and continue. Do not modify tests to make them pass.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildReadonlyFeedback(violations: string[], readonly: string[]): string {
  return [
    `You modified protected files that must not change: ${violations.join(', ')}.`,
    `Readonly patterns: ${readonly.join(', ')}.`,
    `Revert those changes and achieve the goal without touching them.`,
  ].join('\n')
}

export function buildFinalizePrompt(spec: GoalRunSpec): string {
  if (spec.completionPolicy === 'pr') {
    return 'Verification passed. Commit your changes, push the branch, and open a pull request with a clear summary of what changed and why. Do not merge it.'
  }
  if (spec.completionPolicy === 'merge') {
    return 'Verification passed. Commit your changes and push the branch to the remote. Do not open a pull request.'
  }
  return 'Verification passed. Commit your changes locally. Do not push or open a pull request.'
}
