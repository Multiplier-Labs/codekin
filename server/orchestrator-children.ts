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
  /** Timeout in ms (default 10 minutes). */
  timeoutMs?: number
  /** Optional model override. */
  model?: string
  /** Optional allowedTools override. When omitted, uses AGENT_CHILD_ALLOWED_TOOLS. */
  allowedTools?: string[]
}

export type ChildStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timed_out'

export interface ChildSession {
  id: string
  request: ChildSessionRequest
  status: ChildStatus
  startedAt: string
  completedAt: string | null
  result: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 5
const DEFAULT_TIMEOUT_MS = 600_000  // 10 minutes
const CHILD_RETENTION_MS = 3_600_000  // keep completed/failed children for 1 hour
const MAX_RETAINED_CHILDREN = 100    // hard cap on total entries

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

  constructor(sessions: SessionManager) {
    this.sessions = sessions
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
      if (child.status === 'starting' || child.status === 'running') continue
      if (child.completedAt && now - new Date(child.completedAt).getTime() > CHILD_RETENTION_MS) {
        this.children.delete(id)
      }
    }
    // Hard cap: if still over limit, remove oldest completed entries
    if (this.children.size > MAX_RETAINED_CHILDREN) {
      const completed = Array.from(this.children.entries())
        .filter(([, c]) => c.status !== 'starting' && c.status !== 'running')
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
      .filter(c => c.status === 'starting' || c.status === 'running')
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
        if (!wtPath) {
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
      return child
    }
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

        // Timeout handler
        const timer = setTimeout(() => {
          if (settled) return
          child.status = 'timed_out'
          child.error = `Timed out after ${timeoutMs}ms`
          child.completedAt = new Date().toISOString()

          const session = this.sessions.get(child.id)
          if (session?.claudeProcess?.isAlive()) {
            session.claudeProcess.stop()
          }
          settle()
        }, timeoutMs)

        // Result hook: Claude completed a turn
        const onResult = (sessionId: string, isError: boolean) => {
          if (sessionId !== child.id || settled) return
          const session = this.sessions.get(child.id)
          if (!session) {
            child.status = 'failed'
            child.error = 'Session was deleted'
            child.completedAt = new Date().toISOString()
            clearTimeout(timer)
            settle()
            return
          }

          const text = this.extractText(session.outputHistory)
          // Check if the final step was done; if not, nudge (keep listening)
          if (this.ensureFinalStep(child, session, text, nudgedIds, supersededMsgs)) return

          // Don't mark as completed while the session still has pending
          // tool approvals or control requests — the Claude process may
          // still be alive and blocked on an approval (e.g. git push).
          // Keep monitoring; the next result/exit event will re-evaluate.
          if (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0) return

          child.status = isError ? 'failed' : 'completed'
          child.result = text || null
          child.error = isError ? 'Claude returned an error' : null
          child.completedAt = new Date().toISOString()
          clearTimeout(timer)
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
          clearTimeout(timer)
          settle()
        }

        unsubResult = this.sessions.onSessionResult(onResult)
        unsubExit = this.sessions.onSessionExit(onExit)
      })
    } finally {
      // Unsubscribe listeners to prevent accumulation across spawn() calls
      unsubResult?.()
      unsubExit?.()
      // Safety net: ensure isProcessing is cleared when monitoring ends.
      // handleClaudeResult should have already done this, but edge cases
      // (nudge race, missed result event) can leave the flag stuck.
      this.sessions.clearProcessingFlag(child.id)
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
