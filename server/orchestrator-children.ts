/**
 * Orchestrator child session manager — spawns, monitors, and reports on
 * implementation sessions created by the orchestrator.
 *
 * Follows the same patterns as workflow-loader.ts for session creation
 * and result polling.
 */

import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import type { Session, WsServerMessage } from './types.js'
import { getAgentDisplayName } from './config.js'
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
 * Default allowed tools for agent child sessions. Covers standard dev
 * operations without granting arbitrary shell access. Destructive commands
 * (rm, sudo, docker, git reset/clean, git push --force) are intentionally
 * excluded — they fall through to manual approval.
 */
export const AGENT_CHILD_ALLOWED_TOOLS = [
  // File operations (scoped to working dir by acceptEdits mode)
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  // Git operations (branch, commit, push, PR workflow)
  'Bash(git:*)',
  // GitHub CLI (create PRs, check runs, etc.)
  'Bash(gh:*)',
  // API calls (status reporting back to orchestrator)
  'Bash(curl:*)',
  // Package managers
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(pnpm:*)', 'Bash(bun:*)',
  // Build / lint / test tools
  'Bash(node:*)', 'Bash(tsc:*)', 'Bash(eslint:*)', 'Bash(prettier:*)',
  'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)', 'Bash(pip:*)',
  // Python toolchain (linting/tests in Python repos)
  'Bash(python3:*)', 'Bash(pytest:*)',
  // Text/data processing (read-only or scoped to working dir)
  'Bash(sed:*)', 'Bash(rg:*)', 'Bash(jq:*)',
  // Non-destructive file management (no rm — deletion still needs approval)
  'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(touch:*)',
  // Safe filesystem inspection (read-only)
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(wc:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(sort:*)', 'Bash(diff:*)',
  'Bash(basename:*)', 'Bash(dirname:*)',
  'Bash(realpath:*)', 'Bash(tree:*)', 'Bash(pwd:*)',
  'Bash(which:*)', 'Bash(file:*)',
]

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

  constructor(sessions: SessionManager, opts?: { notify?: ChildNotifyFn }) {
    this.sessions = sessions
    this.notify = opts?.notify ?? ((args) => sendOrchestratorNotification(sessions, args))
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
    const supersededMsgs = new Set<WsServerMessage>()

    try {
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = () => { if (!settled) { settled = true; resolve() } }

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

        // Result hook: Claude completed a turn
        const onResult = (sessionId: string, isError: boolean) => {
          if (sessionId !== child.id || settled) return
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
            pause()
            return
          }

          // The prompt (if any) was answered — restart the working clock so
          // post-approval work draws from the remaining working budget.
          resume()
          if (child.status === 'blocked') child.status = 'running'

          const text = this.extractText(session.outputHistory)
          // Check if the final step was done; if not, nudge (keep listening)
          if (this.ensureFinalStep(child, session, text, nudgedIds, supersededMsgs)) return

          child.status = isError ? 'failed' : 'completed'
          child.result = text || null
          child.error = isError ? 'Claude returned an error' : null
          child.completedAt = new Date().toISOString()
          clearTimers()
          settle()
        }

        // Exit hook: Claude process exited
        const onExit = (sessionId: string, _code: number | null, _signal: string | null, willRestart: boolean) => {
          if (sessionId !== child.id || settled) return
          if (willRestart) return  // Will auto-restart, keep monitoring

          const session = this.sessions.get(child.id)
          const text = session ? this.extractText(session.outputHistory) : ''
          child.status = text.length > 100 ? 'completed' : 'failed'
          child.result = text || null
          child.error = text.length <= 100 ? 'Claude exited without sufficient output' : null
          child.completedAt = new Date().toISOString()
          clearTimers()
          settle()
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
      // Push-notify the parent orchestrator so it learns about the terminal
      // state immediately, instead of waiting for the 30-minute polling cron.
      this.notifyTerminal(child)
    }
  }

  /**
   * Check whether the session completed the expected final step (PR, push, deploy).
   * If not, send a follow-up instruction and return true so monitoring continues.
   * Only nudges once per child to avoid infinite loops.
   */
  private ensureFinalStep(
    child: ChildSession,
    session: Session,
    text: string,
    nudgedIds: Set<string>,
    supersededMsgs: Set<WsServerMessage>,
  ): boolean {
    // Only nudge once per child
    if (nudgedIds.has(child.id)) return false

    const policy = child.request.completionPolicy
    const lowerText = text.toLowerCase()

    let missing = false
    let instruction = ''

    if (policy === 'pr') {
      // Check if a PR was created
      const prCreated = lowerText.includes('pull request') || lowerText.includes('created a pr') || lowerText.includes('gh pr create')
      if (!prCreated) {
        missing = true
        instruction = 'You completed the code changes but did not create a Pull Request. Please push your branch and create a PR now with a clear description of what was changed and why.'
      }
    } else if (policy === 'merge') {
      // Check if changes were pushed
      const pushed = lowerText.includes('git push') || lowerText.includes('pushed')
      if (!pushed) {
        missing = true
        instruction = 'You completed the code changes but did not push them. Please push your changes to the remote now.'
      }
    }

    if (missing && instruction && session.claudeProcess?.isAlive()) {
      nudgedIds.add(child.id)
      // Track the result message as superseded locally rather than mutating history entries
      const resultMsg = session.outputHistory.find(m => m.type === 'result')
      if (resultMsg) supersededMsgs.add(resultMsg)
      this.sessions.sendInput(child.id, instruction)
      return true
    }

    return false
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
