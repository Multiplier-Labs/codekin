/**
 * Orchestrator child session manager — spawns, monitors, and reports on
 * implementation sessions created by the orchestrator.
 *
 * Follows the same patterns as workflow-loader.ts for session creation
 * and result polling.
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import type { SessionManager } from './session-manager.js'
import type { WsServerMessage } from './types.js'
import { getAgentDisplayName } from './config.js'
import { AGENT_ALLOWED_TOOLS } from './agent-allowlist.js'
import type { RunStore } from './run-store.js'
import type { RunLifecycleStatus } from './run-status.js'
import {
  sendOrchestratorNotification,
  type OrchestratorNotifyArgs,
} from './orchestrator-notify.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChildSessionRequest {
  /** Target repository path. */
  repo: string
  /** Human-readable task description. */
  task: string
  /** Branch name for the fix. */
  branchName: string
  /** How changes should land. */
  completionPolicy: 'pr' | 'merge' | 'commit-only'
  /** Whether to deploy after merge. */
  deployAfter: boolean
  /** Use a git worktree for isolation. */
  useWorktree: boolean
  /**
   * Working-time timeout in ms (default 30 minutes). Time spent blocked on
   * a pending approval/question does not count against this budget — blocked
   * time has its own separate cap (MAX_BLOCKED_MS).
   */
  timeoutMs?: number
  /** Optional model override. */
  model?: string
  /** Optional allowedTools override. When omitted, uses AGENT_CHILD_ALLOWED_TOOLS. */
  allowedTools?: string[]
  /**
   * Session ID of the orchestrator that spawned this child. When set, the
   * parent receives a push notification on terminal-state transitions.
   * Children created without this field (e.g. internal/test fixtures) do
   * not generate notifications.
   */
  parentSessionId?: string
}

export type ChildStatus = 'starting' | 'running' | 'blocked' | 'completed' | 'failed' | 'timed_out'

/** Statuses considered terminal — once entered, the child is done. */
const TERMINAL_STATUSES: ReadonlySet<ChildStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
])

export interface ChildSession {
  id: string
  request: ChildSessionRequest
  status: ChildStatus
  startedAt: string
  completedAt: string | null
  result: string | null
  error: string | null
  /**
   * Timestamp when a terminal-state notification was delivered to the
   * parent orchestrator. Used to enforce single-fire idempotency.
   */
  terminalNotifiedAt: string | null
  /**
   * Worktree isolation outcome:
   *  - 'active': worktree created, session runs isolated
   *  - 'failed': worktree was requested but creation failed (running in repo)
   *  - 'none':   worktree was not requested
   */
  worktree: 'active' | 'failed' | 'none'
  /** Absolute path of the worktree when active. */
  worktreePath: string | null
}

/**
 * Function signature for delivering a terminal-state notification to the
 * parent orchestrator session. Injectable via the OrchestratorChildManager
 * constructor so unit tests can stub the delivery without touching socket I/O.
 */
export type ChildNotifyFn = (args: OrchestratorNotifyArgs) => boolean

/**
 * Runs an external command and resolves with stdout. Injectable so unit
 * tests can stub ground-truth checks (gh / git) without spawning processes.
 * Rejects when the command fails or times out.
 */
export type ExecFn = (cmd: string, args: string[], cwd: string) => Promise<string>

const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) rejectPromise(err instanceof Error ? err : new Error(`${cmd} failed`))
      else resolvePromise(stdout)
    })
  })

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 5
const DEFAULT_TIMEOUT_MS = 1_800_000  // 30 minutes of working time
/**
 * Separate budget for time spent blocked on a pending approval or question.
 * The working-time clock is paused while blocked; this cap ensures a child
 * waiting on an answer that never comes still terminates eventually.
 */
const MAX_BLOCKED_MS = 1_800_000  // 30 minutes
const CHILD_RETENTION_MS = 3_600_000  // keep completed/failed children for 1 hour
const MAX_RETAINED_CHILDREN = 100    // hard cap on total entries
const MAX_NOTIFIED_PROMPT_IDS = 500  // cap on the blocked-prompt dedup set

/**
 * Default allowed tools for agent child sessions — the shared headless-agent
 * allowlist, re-exported under the historical name for existing importers.
 */
export const AGENT_CHILD_ALLOWED_TOOLS = AGENT_ALLOWED_TOOLS

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class OrchestratorChildManager {
  private children = new Map<string, ChildSession>()
  private sessions: SessionManager
  private notify: ChildNotifyFn
  /** Prompt requestIds already reported to the parent (single-fire per prompt). */
  private notifiedPromptIds = new Set<string>()
  /**
   * Per-child timeout controllers — lets the prompt handler pause the
   * working-time clock the moment a child blocks on an approval/question,
   * instead of waiting for the next monitor event.
   */
  private timeoutControllers = new Map<string, { pause(): void; resume(): void }>()
  private exec: ExecFn
  /** Unified run store — children persist as engine:'agent' runs when set. */
  private runStore: RunStore | null

  constructor(sessions: SessionManager, opts?: { notify?: ChildNotifyFn; exec?: ExecFn; runStore?: RunStore }) {
    this.sessions = sessions
    this.notify = opts?.notify ?? ((args) => sendOrchestratorNotification(sessions, args))
    this.exec = opts?.exec ?? defaultExec
    this.runStore = opts?.runStore ?? null
    // Push a realtime notification to the parent orchestrator whenever one of
    // our children blocks on a tool approval or question. Without this, a
    // blocked child would silently sit until its timeout killed it.
    this.sessions.onSessionPrompt((sessionId, promptType, toolName, requestId) => {
      this.handleChildPrompt(sessionId, promptType, toolName, requestId)
    })
  }

  /**
   * Handle a prompt event from any session: if it belongs to one of our
   * active children, mark the child as blocked and notify the parent
   * orchestrator with everything it needs to unblock the child.
   */
  private handleChildPrompt(
    sessionId: string,
    promptType: 'permission' | 'question',
    toolName: string | undefined,
    requestId: string | undefined,
  ): void {
    const child = this.children.get(sessionId)
    if (!child || TERMINAL_STATUSES.has(child.status)) return

    child.status = 'blocked'
    // Pause the working-time clock while the child waits for an answer.
    this.timeoutControllers.get(sessionId)?.pause()

    // Single-fire per requestId (re-broadcasts on client join would otherwise
    // spam the parent). Prompts without a requestId can't be deduped or
    // responded to by ID — still notify, but only describe them generically.
    const dedupKey = requestId ?? `${sessionId}:${toolName ?? 'unknown'}`
    if (this.notifiedPromptIds.has(dedupKey)) return
    this.notifiedPromptIds.add(dedupKey)
    this.persistRun(child, `Blocked: waiting on ${promptType === 'question' ? 'a question' : `approval for ${toolName ?? 'a tool'}`}.`)
    if (this.notifiedPromptIds.size > MAX_NOTIFIED_PROMPT_IDS) {
      // Drop oldest entries (Set preserves insertion order)
      for (const id of this.notifiedPromptIds) {
        this.notifiedPromptIds.delete(id)
        if (this.notifiedPromptIds.size <= MAX_NOTIFIED_PROMPT_IDS) break
      }
    }

    const parentSessionId = child.request.parentSessionId
    if (!parentSessionId) return

    try {
      this.notify({
        parentSessionId,
        label: 'Child Session Blocked',
        title: `Session: ${getAgentDisplayName().toLowerCase()}:${child.request.branchName} (${child.id})`,
        body: this.buildBlockedNotificationBody(child, promptType, toolName, requestId),
      })
    } catch (err) {
      console.warn(`[orchestrator-child] Failed to notify parent about blocked child ${child.id}:`, err)
    }
  }

  /** Build the body for a blocked-child notification, including the exact
   *  API call the orchestrator can use to respond. */
  private buildBlockedNotificationBody(
    child: ChildSession,
    promptType: 'permission' | 'question',
    toolName: string | undefined,
    requestId: string | undefined,
  ): string {
    const lines: string[] = [
      'Status: blocked — waiting for a response',
      `Branch: ${child.request.branchName}`,
      `Repo: ${child.request.repo}`,
      `Prompt: ${promptType}${toolName ? ` (${toolName})` : ''}`,
    ]

    // Include a one-line summary of what the tool wants to do, if available.
    const detail = this.describePendingPrompt(child.id, requestId)
    if (detail) lines.push(`Detail: ${detail}`)

    if (requestId) {
      lines.push(
        `RequestId: ${requestId}`,
        'Respond with:',
        `curl -s -X POST "http://localhost:$CODEKIN_PORT/api/orchestrator/sessions/${child.id}/respond" \\`,
        '  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN" -H "Content-Type: application/json" \\',
        promptType === 'question'
          ? `  -d '{"requestId": "${requestId}", "value": "YOUR_ANSWER"}'`
          : `  -d '{"requestId": "${requestId}", "value": "allow"}'  # or "deny"`,
      )
    }
    lines.push('Unanswered permission prompts are auto-denied after 5 minutes. If unsure, ask the user.')
    return lines.join('\n')
  }

  /** One-line summary of the pending prompt's tool input (e.g. the Bash command). */
  private describePendingPrompt(sessionId: string, requestId: string | undefined): string | null {
    if (!requestId) return null
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const pending = session.pendingToolApprovals.get(requestId) ?? session.pendingControlRequests.get(requestId)
    if (!pending) return null
    const input = pending.toolInput
    if (typeof input.command === 'string') return `$ ${input.command.split('\n')[0].slice(0, 200)}`
    if (typeof input.file_path === 'string') return input.file_path
    const json = JSON.stringify(input)
    return json.length > 2 ? json.slice(0, 200) : null
  }

  /** Get all active/recent child sessions. */
  list(): ChildSession[] {
    this.purgeStaleChildren()
    return Array.from(this.children.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Get a child session by ID. */
  get(id: string): ChildSession | null {
    return this.children.get(id) ?? null
  }

  /** Purge completed/failed children older than the retention period. */
  private purgeStaleChildren(): void {
    const now = Date.now()
    for (const [id, child] of this.children) {
      if (!TERMINAL_STATUSES.has(child.status)) continue
      if (child.completedAt && now - new Date(child.completedAt).getTime() > CHILD_RETENTION_MS) {
        this.children.delete(id)
      }
    }
    // Hard cap: if still over limit, remove oldest completed entries
    if (this.children.size > MAX_RETAINED_CHILDREN) {
      const completed = Array.from(this.children.entries())
        .filter(([, c]) => TERMINAL_STATUSES.has(c.status))
        .sort((a, b) => (a[1].completedAt ?? '').localeCompare(b[1].completedAt ?? ''))
      while (this.children.size > MAX_RETAINED_CHILDREN && completed.length > 0) {
        const [id] = completed.shift()!
        this.children.delete(id)
      }
    }
  }

  /** Count currently active (non-terminal) child sessions. */
  activeCount(): number {
    return Array.from(this.children.values())
      .filter(c => !TERMINAL_STATUSES.has(c.status))
      .length
  }

  /**
   * Sync a child's current state into the unified run store (no-op without
   * one). The child's session id doubles as the run id; status maps onto the
   * shared vocabulary (starting→queued, completed→succeeded,
   * timed_out→failed with the error preserved). `note` adds a ledger entry.
   */
  private persistRun(child: ChildSession, note?: string): void {
    if (!this.runStore) return
    try {
      const statusMap: Record<ChildStatus, RunLifecycleStatus> = {
        starting: 'queued',
        running: 'running',
        blocked: 'blocked',
        completed: 'succeeded',
        failed: 'failed',
        timed_out: 'failed',
      }
      if (!this.runStore.getRun(child.id)) {
        this.runStore.createRun({
          id: child.id,
          engine: 'agent',
          kind: 'child',
          title: child.request.task.slice(0, 200),
          repo: child.request.repo,
          branch: child.request.branchName,
          spec: { ...child.request },
          sessionIds: [child.id],
        })
      }
      this.runStore.patchRun(child.id, {
        status: statusMap[child.status],
        error: child.status === 'timed_out' ? (child.error ?? 'timed out') : child.error,
        completedAt: child.completedAt,
      })
      if (note) this.runStore.appendLedger(child.id, { summary: note })
    } catch (err) {
      // Persistence must never break child management.
      console.error('[orchestrator-child] Failed to persist run state:', err)
    }
  }

  /**
   * Spawn a child session to implement a task in a target repo.
   * Returns the child session info or throws if at capacity.
   */
  async spawn(request: ChildSessionRequest): Promise<ChildSession> {
    this.purgeStaleChildren()
    if (this.activeCount() >= MAX_CONCURRENT) {
      throw new Error(`Cannot spawn child session: ${MAX_CONCURRENT} concurrent sessions already running`)
    }

    const sessionId = randomUUID()
    const sessionName = `${getAgentDisplayName().toLowerCase()}:${request.branchName}`
    const now = new Date().toISOString()

    const child: ChildSession = {
      id: sessionId,
      request,
      status: 'starting',
      startedAt: now,
      completedAt: null,
      result: null,
      error: null,
      terminalNotifiedAt: null,
      worktree: request.useWorktree ? 'failed' : 'none',  // upgraded to 'active' on success
      worktreePath: null,
    }
    this.children.set(sessionId, child)
    this.persistRun(child, `Spawned in ${request.repo} on branch ${request.branchName}.`)

    try {
      // Create the session
      this.sessions.create(sessionName, request.repo, {
        source: 'agent',
        id: sessionId,
        groupDir: request.repo,
        model: request.model,
        permissionMode: 'acceptEdits',
        allowedTools: request.allowedTools ?? AGENT_CHILD_ALLOWED_TOOLS,
      })

      // Create a git worktree for isolation if requested (default for Joe children).
      // This must happen BEFORE startClaude so Claude runs in the worktree directory.
      // Pass the target branch name so the worktree is created directly on the
      // feature branch — no need for Claude to create a second branch.
      let worktreeFailed = false
      if (request.useWorktree) {
        const wtPath = await this.sessions.createWorktree(sessionId, request.repo, request.branchName)
        if (wtPath) {
          child.worktree = 'active'
          child.worktreePath = wtPath
        } else {
          worktreeFailed = true
          console.warn(`[orchestrator-child] Failed to create worktree for ${sessionId}, falling back to main directory`)
        }
      }

      // Start Claude
      this.sessions.startClaude(sessionId)
      child.status = 'running'
      this.persistRun(child)

      // Build and send the task prompt, including worktree failure context
      const prompt = this.buildPrompt(request, worktreeFailed)
      this.sessions.sendInput(sessionId, prompt)

      // Monitor completion asynchronously
      void this.monitorChild(child)

      return child
    } catch (err) {
      child.status = 'failed'
      child.error = err instanceof Error ? err.message : String(err)
      child.completedAt = new Date().toISOString()
      this.persistRun(child, 'Spawn failed.')
      this.notifyTerminal(child)
      return child
    }
  }

  /**
   * Deliver a single terminal-state notification to the parent orchestrator
   * session. No-op (and idempotent) when the child has no parent, the status
   * is not terminal, or a notification has already been delivered.
   */
  private notifyTerminal(child: ChildSession): void {
    if (child.terminalNotifiedAt) return
    if (!TERMINAL_STATUSES.has(child.status)) return
    const parentSessionId = child.request.parentSessionId
    if (!parentSessionId) return

    const args: OrchestratorNotifyArgs = {
      parentSessionId,
      label: 'Child Session Stopped',
      title: `Session: ${getAgentDisplayName().toLowerCase()}:${child.request.branchName} (${child.id})`,
      body: this.buildTerminalNotificationBody(child),
    }

    // `notify` returns true on immediate delivery AND when the notification
    // was queued in the persistent outbox (the outbox owns replay from that
    // point on) — both count as handled, so we stamp `terminalNotifiedAt`.
    // It returns false only when queueing itself failed; we leave the stamp
    // unset so a later terminal-path call can retry. Idempotency is still
    // enforced by the early-return on terminalNotifiedAt at the top.
    let delivered = false
    try {
      delivered = this.notify(args)
    } catch (err) {
      console.warn(`[orchestrator-child] Failed to notify parent ${parentSessionId} for ${child.id}:`, err)
    }

    if (delivered) {
      child.terminalNotifiedAt = new Date().toISOString()
    }
  }

  /**
   * Build the multi-line body for a terminal-state notification: status,
   * branch, repo, optional error string, and an action hint tailored to
   * the terminal status.
   */
  private buildTerminalNotificationBody(child: ChildSession): string {
    const lines: string[] = [
      `Status: ${child.status}`,
      `Branch: ${child.request.branchName}`,
      `Repo: ${child.request.repo}`,
    ]
    if (child.error) lines.push(`Error: ${child.error}`)
    lines.push(this.buildHintLine(child))
    return lines.join('\n')
  }

  /**
   * Build a single-line hint about how to proceed, tailored to the status:
   *   - timed_out / failed → point at the worktree so partial work can be salvaged
   *   - completed         → remind that the PR may still need to be opened
   */
  private buildHintLine(child: ChildSession): string {
    const session = this.sessions.get(child.id)
    const worktreePath = session?.worktreePath
    if (child.status === 'timed_out' || child.status === 'failed') {
      const where = worktreePath ?? `${child.request.repo} (no worktree)`
      return `Inspect worktree at ${where} for partial work.`
    }
    if (child.status === 'completed') {
      const policy = child.request.completionPolicy
      if (policy === 'pr') return 'Verify the PR was opened — push and create one if not.'
      if (policy === 'merge') return 'Verify the branch was pushed.'
      return 'Verify changes were committed locally as expected.'
    }
    return 'Review the child session output before deciding next steps.'
  }

  /**
   * Build a focused task prompt for a child session.
   */
  private buildPrompt(request: ChildSessionRequest, worktreeFailed = false): string {
    const inWorktree = request.useWorktree && !worktreeFailed

    const lines = [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent ${getAgentDisplayName()} (the Codekin orchestrator) to implement a specific task in this repository.`,
      '',
      `**Task**: ${request.task}`,
      `**Branch**: \`${request.branchName}\``,
      '',
    ]

    if (inWorktree) {
      lines.push(
        '## Worktree Environment',
        '',
        `You are running in an **isolated git worktree** already on branch \`${request.branchName}\`.`,
        'You do NOT need to create or switch branches — just make your changes and commit directly.',
        '',
        '**IMPORTANT**: Do NOT use the `EnterWorktree` or `ExitWorktree` tools. This session is already managed in a worktree by Codekin. Using those tools will corrupt the worktree state and crash the session.',
        '',
      )
    }

    if (request.completionPolicy === 'pr') {
      if (inWorktree) {
        lines.push(
          '## Completion',
          '',
          '1. Make the necessary changes',
          '2. Commit your changes with a clear commit message',
          '3. Push the branch and create a Pull Request',
          '4. Include a clear PR description explaining what was changed and why',
          '',
        )
      } else {
        lines.push(
          '## Completion',
          '',
          `1. Create and switch to branch \`${request.branchName}\``,
          '2. Make the necessary changes',
          '3. Commit your changes with a clear commit message',
          '4. Push the branch and create a Pull Request',
          '5. Include a clear PR description explaining what was changed and why',
          '',
        )
      }
    } else if (request.completionPolicy === 'merge') {
      lines.push(
        '## Completion',
        '',
        '1. Make the necessary changes on the current branch',
        '2. Commit your changes with a clear commit message',
        '3. Push directly to the current branch',
        '',
      )
    } else {
      lines.push(
        '## Completion',
        '',
        '1. Make the necessary changes',
        '2. Commit your changes with a clear commit message',
        '3. Do NOT push — just commit locally',
        '',
      )
    }

    lines.push(
      '## Guidelines',
      '',
      '- Keep changes minimal and focused on the task',
      '- Do not refactor unrelated code',
      '- If you encounter issues that block the task, explain what went wrong',
      '- When done, provide a brief summary of what you changed',
    )

    if (worktreeFailed) {
      lines.push(
        '',
        '## ⚠ Worktree Not Available',
        '',
        'A git worktree could not be created for isolation. You are working **directly in the main repository**.',
        'Be extra careful with git operations — do NOT force-push, reset, or make destructive changes to existing branches.',
        `Create branch \`${request.branchName}\` before making any changes.`,
        '',
        '**IMPORTANT**: Do NOT use the `EnterWorktree` or `ExitWorktree` tools — worktree creation already failed, and retrying will not help.',
      )
    }

    return lines.join('\n')
  }

  /**
   * Monitor a child session until completion or timeout using event hooks.
   * Replaces the old polling loop with SessionManager's onSessionResult and
   * onSessionExit hooks for lower latency and no wasted CPU.
   */
  private async monitorChild(child: ChildSession): Promise<void> {
    const timeoutMs = child.request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let unsubResult: (() => void) | undefined
    let unsubExit: (() => void) | undefined
    const nudgedIds = new Set<string>()

    try {
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = () => { if (!settled) { settled = true; resolve() } }
        // Re-read after awaits — a timeout may settle while a ground-truth
        // check is in flight (also defeats overly-eager type narrowing).
        const isSettled = () => settled

        // ---- Pausable working-time clock -----------------------------------
        // The working budget (timeoutMs) only burns while the child is doing
        // work. When the child blocks on an approval/question, the clock is
        // paused and a separate blocked-time cap (MAX_BLOCKED_MS) takes over
        // so an unanswered prompt still terminates the child eventually.
        let remainingMs = timeoutMs
        let workStartedAt = Date.now()
        let workTimer: ReturnType<typeof setTimeout> | null = null
        let blockedTimer: ReturnType<typeof setTimeout> | null = null

        const clearTimers = () => {
          if (workTimer) { clearTimeout(workTimer); workTimer = null }
          if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null }
        }

        const fireTimeout = (error: string) => {
          if (settled) return
          child.status = 'timed_out'
          child.error = error
          child.completedAt = new Date().toISOString()
          clearTimers()

          const session = this.sessions.get(child.id)
          if (session?.claudeProcess?.isAlive()) {
            session.claudeProcess.stop()
          }
          settle()
        }

        const pause = () => {
          if (settled || !workTimer) return
          clearTimeout(workTimer)
          workTimer = null
          remainingMs = Math.max(0, remainingMs - (Date.now() - workStartedAt))
          blockedTimer ??= setTimeout(() => {
            fireTimeout(`Timed out after waiting ${MAX_BLOCKED_MS}ms for a pending approval/answer`)
          }, MAX_BLOCKED_MS)
        }

        const resume = () => {
          if (settled || workTimer) return
          if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null }
          workStartedAt = Date.now()
          workTimer = setTimeout(() => {
            fireTimeout(`Timed out after ${timeoutMs}ms of working time`)
          }, remainingMs)
        }

        // Expose pause/resume to the prompt handler (handleChildPrompt).
        this.timeoutControllers.set(child.id, { pause, resume })

        // Start the working clock.
        workStartedAt = Date.now()
        workTimer = setTimeout(() => {
          fireTimeout(`Timed out after ${timeoutMs}ms of working time`)
        }, remainingMs)

        // Guard against overlapping async ground-truth checks when result
        // events arrive in quick succession.
        let verifying = false

        // Result hook: Claude completed a turn
        const onResult = (sessionId: string, isError: boolean) => {
          if (sessionId !== child.id || settled || verifying) return
          const session = this.sessions.get(child.id)
          if (!session) {
            child.status = 'failed'
            child.error = 'Session was deleted'
            child.completedAt = new Date().toISOString()
            clearTimers()
            settle()
            return
          }

          // Don't mark as completed (or nudge) while the session still has
          // pending tool approvals or control requests — the Claude process
          // may still be alive and blocked on an approval (e.g. git push).
          // Nudging here would waste the single nudge on a child that cannot
          // act. Keep monitoring; the next result/exit event re-evaluates.
          if (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0) {
            child.status = 'blocked'
            this.persistRun(child)
            pause()
            return
          }

          // The prompt (if any) was answered — restart the working clock so
          // post-approval work draws from the remaining working budget.
          resume()
          if (child.status === 'blocked') {
            child.status = 'running'
            this.persistRun(child)
          }

          verifying = true
          void (async () => {
            try {
              const text = this.extractText(session.outputHistory)
              // Ground-truth check: did the final step (PR / push) really land?
              const missing = await this.isFinalStepMissing(child, text)
              if (isSettled()) return

              // Final step missing — nudge once, then keep monitoring.
              if (missing && !isError && !nudgedIds.has(child.id) && session.claudeProcess?.isAlive()) {
                nudgedIds.add(child.id)
                this.sessions.sendInput(child.id, this.buildNudgeInstruction(child.request.completionPolicy))
                return
              }

              child.status = isError ? 'failed' : 'completed'
              child.result = text || null
              child.error = isError
                ? 'Claude returned an error'
                : missing
                  ? `Completion not verified: expected ${child.request.completionPolicy === 'pr' ? 'a pull request' : 'a pushed branch'} but found none`
                  : null
              child.completedAt = new Date().toISOString()
              clearTimers()
              settle()
            } finally {
              verifying = false
            }
          })()
        }

        // Exit hook: Claude process exited
        const onExit = (sessionId: string, _code: number | null, _signal: string | null, willRestart: boolean) => {
          if (sessionId !== child.id || settled) return
          if (willRestart) return  // Will auto-restart, keep monitoring

          const session = this.sessions.get(child.id)
          const text = session ? this.extractText(session.outputHistory) : ''
          void (async () => {
            // Process is gone — decide the terminal status from ground truth
            // (did the PR / push land?) rather than transcript length.
            let missing = session ? await this.isFinalStepMissing(child, text) : true
            // commit-only has no remote artifact to verify; an exit without
            // any output cannot be considered a success.
            if (child.request.completionPolicy === 'commit-only' && !text) missing = true
            if (isSettled()) return
            child.status = missing ? 'failed' : 'completed'
            child.result = text || null
            child.error = missing ? 'Claude exited before the final step could be verified' : null
            child.completedAt = new Date().toISOString()
            clearTimers()
            settle()
          })()
        }

        unsubResult = this.sessions.onSessionResult(onResult)
        unsubExit = this.sessions.onSessionExit(onExit)
      })
    } finally {
      // Unsubscribe listeners to prevent accumulation across spawn() calls
      unsubResult?.()
      unsubExit?.()
      this.timeoutControllers.delete(child.id)
      // Safety net: ensure isProcessing is cleared when monitoring ends.
      // handleClaudeResult should have already done this, but edge cases
      // (nudge race, missed result event) can leave the flag stuck.
      this.sessions.clearProcessingFlag(child.id)
      // Every terminal path (completed, failed, timed_out) funnels through
      // here — one persist captures the final status, error, and outcome.
      this.persistRun(child, `Finished: ${child.status}${child.error ? ` — ${child.error}` : ''}`)
      // Push-notify the parent orchestrator so it learns about the terminal
      // state immediately, instead of waiting for the 30-minute polling cron.
      this.notifyTerminal(child)
    }
  }

  /**
   * Ground-truth check for the child's expected final step. Instead of
   * sniffing the transcript for keywords (which both false-positives on
   * mentions and false-negatives on terse output), ask the real systems:
   *   - 'pr':    does an open/merged PR exist for the branch? (gh pr list)
   *   - 'merge': does the branch exist on the remote? (git ls-remote)
   *   - 'commit-only': nothing remote to verify — never missing.
   * Falls back to transcript keyword sniffing when the command fails
   * (e.g. gh not installed, no remote configured).
   */
  private async isFinalStepMissing(child: ChildSession, text: string): Promise<boolean> {
    const policy = child.request.completionPolicy
    if (policy === 'commit-only') return false

    const cwd = child.worktreePath ?? child.request.repo
    const branch = child.request.branchName

    if (policy === 'pr') {
      try {
        const out = await this.exec(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1'],
          cwd,
        )
        const parsed: unknown = JSON.parse(out)
        return !(Array.isArray(parsed) && parsed.length > 0)
      } catch {
        const lower = text.toLowerCase()
        return !(lower.includes('pull request') || lower.includes('created a pr') || lower.includes('gh pr create'))
      }
    }

    // policy === 'merge' — verify the branch was pushed to the remote
    try {
      const out = await this.exec('git', ['ls-remote', '--heads', 'origin', branch], cwd)
      return out.trim().length === 0
    } catch {
      const lower = text.toLowerCase()
      return !(lower.includes('git push') || lower.includes('pushed'))
    }
  }

  /** Follow-up instruction sent (once) when the final step is missing. */
  private buildNudgeInstruction(policy: ChildSessionRequest['completionPolicy']): string {
    if (policy === 'pr') {
      return 'You completed the code changes but no Pull Request exists for your branch yet. Please push your branch and create a PR now with a clear description of what was changed and why.'
    }
    return 'You completed the code changes but your branch has not been pushed to the remote. Please push your changes now.'
  }

  /**
   * Extract assistant text from session output history.
   */
  private extractText(history: WsServerMessage[]): string {
    return history
      .filter((m): m is Extract<WsServerMessage, { type: 'output' }> => m.type === 'output')
      .map(m => m.data)
      .join('')
  }
}
