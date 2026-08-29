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
  type ProviderRole,
  type CheckerVerdict,
} from './goal-run-store.js'
import {
  runVerifier,
  getDiffSummary,
  getDiff,
  getChangedFiles,
  type VerifyResult,
} from './verifier-runner.js'
import { matchesAnyGlob } from './glob-match.js'
import { defaultFinalizer, type FinalizerApi } from './goal-run-finalizer.js'
import { AGENT_ALLOWED_TOOLS, READONLY_AGENT_ALLOWED_TOOLS } from './agent-allowlist.js'

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

interface CreateOpts {
  provider?: LoopProvider
  model?: string
  source?: 'agent'
  /** Tool patterns pre-approved for the session (headless runs must not block on routine dev commands). */
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

/** The slice of SessionManager the controller depends on. */
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

/** The verifier surface — defaults to the real implementations. */
export interface VerifierApi {
  runVerifier(opts: { cwd: string; commands: string[] }): Promise<VerifyResult>
  getDiffSummary(cwd: string): Promise<string>
  getDiff(cwd: string): Promise<string>
  getChangedFiles(cwd: string): Promise<string[]>
}

const defaultVerifier: VerifierApi = { runVerifier, getDiffSummary, getDiff, getChangedFiles }

/** Max consecutive readonly-glob violations before escalating to a human. */
const MAX_READONLY_STRIKES = 2

/** Max chars of the diff embedded in the checker prompt (rest is truncated). */
const MAX_CHECKER_DIFF_CHARS = 60_000

// ---------------------------------------------------------------------------
// Per-run runtime context (not persisted — rebuilt from the store on restart)
// ---------------------------------------------------------------------------

interface RunCtx {
  runId: string
  makerSessionId: string
  cwd: string
  turnCount: number
  /** Maker session cumulative cost. */
  costUsd: number
  /** Checker session cumulative cost (summed into the run's total). */
  checkerCostUsd: number
  /** Diff stat at the last verify, used to debounce re-running the verifier. */
  lastDiff: string | null
  lastVerifyPassed: boolean
  readonlyStrikes: number
  /** Re-entrancy guard — one maker result is processed at a time per run. */
  processing: boolean
  /** Prompt requestIds already recorded in the ledger (one `blocked` row per prompt). */
  notedPromptIds: Set<string>
  dispose: () => void
  /** Unregister the blocked-prompt listener. */
  promptDispose: () => void
  /** Live checker session, set only while a maker–checker review is in flight. */
  checkerSessionId: string | null
  checkerProcessing: boolean
  checkerDispose: () => void
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
    private readonly finalizer: FinalizerApi = defaultFinalizer,
  ) {}

  /** Create and start a goal run. Resolves once the maker has been kicked off. */
  async startRun(input: CreateGoalRunInput): Promise<GoalRun> {
    const run = this.store.createRun(input)
    const session = this.host.create(`goal:${run.kind}:${run.branch}`, run.repo, {
      provider: run.spec.maker.provider,
      model: run.spec.maker.model,
      source: 'agent',
      allowedTools: AGENT_ALLOWED_TOOLS,
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
      checkerCostUsd: 0,
      lastDiff: null,
      lastVerifyPassed: false,
      readonlyStrikes: 0,
      processing: false,
      notedPromptIds: new Set(),
      dispose: () => {},
      promptDispose: () => {},
      checkerSessionId: null,
      checkerProcessing: false,
      checkerDispose: () => {},
    }
    ctx.dispose = this.host.onSessionResult((sid, isError) => {
      if (sid !== ctx.makerSessionId) return
      void this.onMakerResult(ctx, isError)
    })
    ctx.promptDispose = this.host.onSessionPrompt((sid, promptType, toolName, requestId) => {
      this.onSessionBlocked(ctx, sid, promptType, toolName, requestId)
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

  /**
   * Abort a run on user request. An active run has its maker (and any in-flight
   * checker) stopped and is torn down; a run that is only persisted (e.g. after a
   * server restart) is marked aborted in the store. Already-terminal runs are
   * left untouched. Returns true if the run transitioned to `aborted`.
   */
  abortRun(runId: string): boolean {
    const run = this.store.getRun(runId)
    if (!run) return false
    const ctx = this.active.get(runId)
    if (ctx) {
      this.store.appendTurn({
        runId,
        turnIndex: ctx.turnCount,
        role: 'verifier',
        outputTail: 'Run aborted by user.',
        costUsd: totalCost(ctx),
      })
      this.host.stopClaude(ctx.makerSessionId)
      this.store.patchRun(runId, { status: 'aborted', completedAt: new Date().toISOString() })
      this.teardown(ctx)
      return true
    }
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'aborted') return false
    this.store.patchRun(runId, { status: 'aborted', completedAt: new Date().toISOString() })
    return true
  }

  /**
   * A maker/checker tool call fell through the allowlist and is waiting on a
   * human. Goal-run sessions are exempt from last-client-leave auto-deny (like
   * orchestrator children), so without this the run would sit in `running` with
   * nobody the wiser. Mark it `blocked` and record the prompt in the ledger —
   * the status resolves back into the loop when the prompt is answered (the
   * next session result patches the status), or the PromptRouter timeout denies
   * it and the loop continues on the denial.
   */
  private onSessionBlocked(
    ctx: RunCtx,
    sessionId: string,
    promptType: 'permission' | 'question',
    toolName: string | undefined,
    requestId: string | undefined,
  ): void {
    const role: 'maker' | 'checker' | null =
      sessionId === ctx.makerSessionId ? 'maker' : sessionId === ctx.checkerSessionId ? 'checker' : null
    if (!role) return
    const run = this.store.getRun(ctx.runId)
    if (!run || !this.active.has(ctx.runId)) return

    // One ledger row per prompt — prompts re-broadcast on client join.
    const dedupKey = requestId ?? `${sessionId}:${toolName ?? promptType}`
    if (!ctx.notedPromptIds.has(dedupKey)) {
      ctx.notedPromptIds.add(dedupKey)
      const what = promptType === 'question' ? 'a question' : `approval for ${toolName ?? 'a tool'}`
      this.store.appendTurn({
        runId: ctx.runId,
        turnIndex: ctx.turnCount,
        role,
        outputTail: `Blocked: the ${role} session is waiting on ${what}. Open the session to respond.`,
        costUsd: totalCost(ctx),
      })
    }
    this.store.patchRun(ctx.runId, { status: 'blocked' })
  }

  private async onMakerResult(ctx: RunCtx, isError: boolean): Promise<void> {
    if (ctx.processing) return
    ctx.processing = true
    try {
      const run = this.store.getRun(ctx.runId)
      if (!run || !this.active.has(ctx.runId)) return

      ctx.turnCount += 1
      ctx.costUsd = readCumulativeCost(this.host.get(ctx.makerSessionId)?.outputHistory ?? [])
      this.store.patchRun(run.id, { turnCount: ctx.turnCount, costUsd: totalCost(ctx) })

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
        await this.onVerifyPassed(ctx, run)
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
   * The deterministic verifier passed. With no checker configured this finalizes
   * directly (Cut 1). With a `spec.checker`, it hands off to a second-provider
   * review pass — the verifier is the cheap objective gate; the checker is the
   * subjective one (does the change actually achieve the goal without gaming the
   * tests?). Using a *different* provider avoids a model grading its own work.
   */
  private async onVerifyPassed(ctx: RunCtx, run: GoalRun): Promise<void> {
    if (!run.spec.checker) {
      await this.finalizeSucceeded(ctx, run)
      return
    }
    await this.startChecker(ctx, run, run.spec.checker)
  }

  /**
   * Spawn the checker on its own review branch off the maker's branch. Git forbids
   * two worktrees on the same branch, and the maker's edits are uncommitted (so a
   * sibling worktree can't see them) — the diff therefore travels in the prompt,
   * and the checker reviews read-only.
   */
  private async startChecker(ctx: RunCtx, run: GoalRun, checker: ProviderRole): Promise<void> {
    const diff = await this.verifier.getDiff(ctx.cwd)
    const session = this.host.create(`goal:${run.kind}:check:${run.branch}`, run.repo, {
      provider: checker.provider,
      model: checker.model,
      source: 'agent',
      allowedTools: READONLY_AGENT_ALLOWED_TOOLS,
    })
    await this.host.createWorktree(session.id, run.repo, `${run.branch}-review`, run.branch)
    ctx.checkerSessionId = session.id
    ctx.checkerProcessing = false
    this.store.patchRun(run.id, { status: 'checking', checkerSessionId: session.id })
    ctx.checkerDispose = this.host.onSessionResult((sid, isError) => {
      if (sid !== ctx.checkerSessionId) return
      void this.onCheckerResult(ctx, isError)
    })
    this.host.startClaude(session.id)
    this.host.sendInput(session.id, buildCheckerPrompt(run, diff))
  }

  /**
   * Route the checker's verdict (parsed from its last message — there is no
   * structured verdict event). approve → finalize; request_changes → feed the
   * notes back to the maker and resume the loop; escalate or an unparseable
   * verdict → human checkpoint.
   */
  private async onCheckerResult(ctx: RunCtx, isError: boolean): Promise<void> {
    if (ctx.checkerProcessing) return
    ctx.checkerProcessing = true
    try {
      const run = this.store.getRun(ctx.runId)
      if (!run || !this.active.has(ctx.runId) || !ctx.checkerSessionId) return

      const history = this.host.get(ctx.checkerSessionId)?.outputHistory ?? []
      ctx.checkerCostUsd = readCumulativeCost(history)
      const parsed = isError ? null : parseCheckerVerdict(extractAssistantText(history))
      const reason = parsed?.reason ?? (isError ? 'checker session errored' : 'unparseable checker verdict')

      this.store.appendTurn({
        runId: run.id,
        turnIndex: ctx.turnCount,
        role: 'checker',
        diffSummary: ctx.lastDiff,
        verdict: parsed?.verdict ?? null,
        outputTail: reason,
        costUsd: totalCost(ctx),
      })
      this.store.patchRun(run.id, {
        costUsd: totalCost(ctx),
        verdict: JSON.stringify(parsed ?? { verdict: 'escalate', reason }),
      })
      this.disposeChecker(ctx)

      if (!parsed) {
        this.finalizeEscalated(ctx, reason)
        return
      }
      if (parsed.verdict === 'approve') {
        await this.finalizeSucceeded(ctx, run)
        return
      }
      if (parsed.verdict === 'escalate') {
        this.finalizeEscalated(ctx, parsed.reason ?? 'checker requested human review')
        return
      }
      // request_changes — feed the reviewer's notes back to the maker and resume.
      this.host.sendInput(ctx.makerSessionId, buildCheckerFeedback(parsed.reason))
      this.store.patchRun(run.id, { status: 'running' })
    } finally {
      ctx.checkerProcessing = false
    }
  }

  /**
   * Verification passed: land the verified tree deterministically rather than
   * trusting the maker to commit/push/PR. The maker is stopped (its work is done),
   * Codekin commits the verified tree and — per completion policy — pushes and
   * opens a PR. A push/PR failure does not fail the run (verification passed); the
   * outcome is recorded in the ledger and `prUrl` left null.
   */
  private async finalizeSucceeded(ctx: RunCtx, run: GoalRun): Promise<void> {
    this.host.stopClaude(ctx.makerSessionId)
    const { prUrl, note } = await this.finalizer.finalize({
      cwd: ctx.cwd,
      branch: run.branch,
      policy: run.spec.completionPolicy,
      title: buildPrTitle(run),
      body: buildPrBody(run),
    })
    this.store.appendTurn({
      runId: run.id,
      turnIndex: ctx.turnCount,
      role: 'maker',
      diffSummary: ctx.lastDiff,
      outputTail: note,
      costUsd: totalCost(ctx),
    })
    this.store.patchRun(run.id, { status: 'succeeded', prUrl, completedAt: new Date().toISOString() })
    this.teardown(ctx)
  }

  /** Stop the checker session and unregister its listener (idempotent). */
  private disposeChecker(ctx: RunCtx): void {
    if (!ctx.checkerSessionId) return
    this.host.stopClaude(ctx.checkerSessionId)
    ctx.checkerDispose()
    ctx.checkerDispose = () => {}
    ctx.checkerSessionId = null
    this.store.patchRun(ctx.runId, { checkerSessionId: null })
  }

  private budgetExhausted(ctx: RunCtx, spec: GoalRunSpec): boolean {
    return ctx.turnCount >= spec.maxTurns || totalCost(ctx) >= spec.maxCostUsd
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
    this.disposeChecker(ctx)
    ctx.dispose()
    ctx.promptDispose()
    this.active.delete(ctx.runId)
  }

  /**
   * Boot-time recovery: any run persisted in a non-terminal status has lost its
   * listeners and sessions to the restart and can never progress. Mark each one
   * `failed` with a ledger row saying why, so the UI shows an honest outcome
   * instead of a run stuck in `running` forever. (True resume — reattaching to
   * a restarted maker session — is future work; this guarantees the ledger
   * never lies.) Returns the ids of the runs that were failed.
   */
  failInterrupted(): string[] {
    const interrupted: string[] = []
    for (const status of ['queued', 'running', 'verifying', 'checking', 'blocked'] as const) {
      for (const run of this.store.listRuns({ status })) {
        if (this.active.has(run.id)) continue
        this.store.appendTurn({
          runId: run.id,
          turnIndex: run.turnCount,
          role: 'verifier',
          outputTail: 'Run interrupted by a server restart before completing.',
          costUsd: run.costUsd,
        })
        this.store.patchRun(run.id, { status: 'failed', completedAt: new Date().toISOString() })
        interrupted.push(run.id)
      }
    }
    return interrupted
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

/** Run total cost = maker + checker session cumulative cost. */
function totalCost(ctx: RunCtx): number {
  return ctx.costUsd + ctx.checkerCostUsd
}

function budgetReason(ctx: RunCtx, spec: GoalRunSpec): string {
  if (ctx.turnCount >= spec.maxTurns) return `turn budget exhausted (${ctx.turnCount}/${spec.maxTurns})`
  return `cost budget exhausted ($${totalCost(ctx).toFixed(2)}/$${spec.maxCostUsd.toFixed(2)})`
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

export function buildPrTitle(run: GoalRun): string {
  const firstLine = run.goal.split('\n')[0].trim()
  return firstLine ? `${run.kind}: ${firstLine}` : `${run.kind} (GoalRun)`
}

export function buildPrBody(run: GoalRun): string {
  const lines = [
    run.goal.trim(),
    '',
    '## Verification',
    ...run.spec.verify.map((c) => `- \`${c}\``),
    '',
    `Opened automatically by a Codekin GoalRun (\`${run.kind}\`). Do not merge without review.`,
  ]
  return lines.join('\n')
}

/** Concatenate the assistant's text output from a session's history. */
function extractAssistantText(history: HistoryMsg[]): string {
  let out = ''
  for (const m of history) {
    if (m.type === 'output' && typeof m.data === 'string') out += m.data
  }
  return out
}

export interface ParsedVerdict {
  verdict: CheckerVerdict
  reason?: string
}

/**
 * Parse a checker's free-text reply into a structured verdict. The checker has
 * no structured verdict event, so it is contracted (via the prompt) to end with
 * a `VERDICT: <approve|request_changes|escalate>` line. The LAST occurrence wins
 * so a model that restates the instructions before deciding still resolves to
 * its final choice. Returns null when no verdict marker is present — the caller
 * treats that as an escalation rather than a silent pass.
 */
export function parseCheckerVerdict(text: string): ParsedVerdict | null {
  const matches = [...text.matchAll(/VERDICT:\s*(approve|request_changes|escalate)/gi)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const verdict = last[1].toLowerCase() as CheckerVerdict
  const after = text.slice(last.index + last[0].length)
  const reasonMatch = after.match(/REASON:\s*(.+)/i)
  return reasonMatch ? { verdict, reason: reasonMatch[1].trim() } : { verdict }
}

export function buildCheckerPrompt(run: GoalRun, diff: string): string {
  const body = diff.length > MAX_CHECKER_DIFF_CHARS ? `${diff.slice(0, MAX_CHECKER_DIFF_CHARS)}\n... [diff truncated]` : diff
  return [
    `# Goal Run Review: ${run.kind}`,
    '',
    `## Goal`,
    run.goal,
    '',
    `## Deterministic verification`,
    'These commands already PASSED on this change:',
    ...run.spec.verify.map((c) => `- \`${c}\``),
    '',
    `## Your job`,
    'Review the diff below as an independent checker. Confirm it genuinely achieves the goal and does NOT:',
    '- weaken, skip, or delete tests to make verification pass',
    '- introduce unsafe, incorrect, or out-of-scope changes',
    'You are reviewing only — do not modify any files.',
    '',
    `## Diff`,
    '```diff',
    body,
    '```',
    '',
    `## Required response`,
    'End your reply with exactly one verdict line:',
    '- `VERDICT: approve` — correct and ready to land',
    '- `VERDICT: request_changes` then a `REASON:` line stating what must change',
    '- `VERDICT: escalate` then a `REASON:` line when a human must decide',
  ].join('\n')
}

export function buildCheckerFeedback(reason: string | undefined): string {
  return [
    'A reviewer assessed your change and requested changes before it can land.',
    reason ? `Reviewer feedback: ${reason}` : 'The reviewer did not approve the change.',
    'Address the feedback and continue. Do not weaken tests to satisfy verification.',
  ].join('\n')
}
