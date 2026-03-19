/**
 * Agent Joe child session manager — spawns, monitors, and reports on
 * implementation sessions created by the Agent Joe orchestrator.
 *
 * Follows the same patterns as workflow-loader.ts for session creation
 * and result polling.
 */

import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import type { Session, WsServerMessage } from './types.js'

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

const MAX_CONCURRENT = 3
const DEFAULT_TIMEOUT_MS = 600_000  // 10 minutes

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ShepherdChildManager {
  private children = new Map<string, ChildSession>()
  private sessions: SessionManager

  constructor(sessions: SessionManager) {
    this.sessions = sessions
  }

  /** Get all active/recent child sessions. */
  list(): ChildSession[] {
    return Array.from(this.children.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Get a child session by ID. */
  get(id: string): ChildSession | null {
    return this.children.get(id) ?? null
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
    if (this.activeCount() >= MAX_CONCURRENT) {
      throw new Error(`Cannot spawn child session: ${MAX_CONCURRENT} concurrent sessions already running`)
    }

    const sessionId = randomUUID()
    const sessionName = `joe:${request.branchName}`
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
      })

      // Create a git worktree for isolation if requested (default for Joe children).
      // This must happen BEFORE startClaude so Claude runs in the worktree directory.
      if (request.useWorktree) {
        const wtPath = await this.sessions.createWorktree(sessionId, request.repo)
        if (!wtPath) {
          console.warn(`[shepherd-child] Failed to create worktree for ${sessionId}, falling back to main directory`)
        }
      }

      // Start Claude
      this.sessions.startClaude(sessionId)
      child.status = 'running'

      // Build and send the task prompt
      const prompt = this.buildPrompt(request)
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
  private buildPrompt(request: ChildSessionRequest): string {
    const lines = [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent Joe (the Codekin orchestrator) to implement a specific task in this repository.`,
      '',
      `**Task**: ${request.task}`,
      `**Branch**: Create your changes on branch \`${request.branchName}\``,
      '',
    ]

    if (request.completionPolicy === 'pr') {
      lines.push(
        '## Completion',
        '',
        '1. Create a new branch with the name specified above',
        '2. Make the necessary changes',
        '3. Commit your changes with a clear commit message',
        '4. Push the branch and create a Pull Request',
        '5. Include a clear PR description explaining what was changed and why',
        '',
      )
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

    return lines.join('\n')
  }

  /**
   * Monitor a child session until completion or timeout.
   */
  private async monitorChild(child: ChildSession): Promise<void> {
    const timeoutMs = child.request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const pollMs = 3000

    while (Date.now() < deadline) {
      const session = this.sessions.get(child.id)
      if (!session) {
        child.status = 'failed'
        child.error = 'Session was deleted'
        child.completedAt = new Date().toISOString()
        return
      }

      // Check for result message (Claude finished normally)
      const resultMsg = session.outputHistory.find(m => m.type === 'result')
      if (resultMsg) {
        const text = this.extractText(session.outputHistory)
        // Check if the final step was done; if not, nudge the session
        const nudged = this.ensureFinalStep(child, session, text)
        if (nudged) continue  // Keep monitoring after nudge
        child.status = 'completed'
        child.result = text
        child.completedAt = new Date().toISOString()
        return
      }

      // Check for exit message (Claude process exited)
      const exitMsg = session.outputHistory.find(m => m.type === 'exit')
      if (exitMsg) {
        const text = this.extractText(session.outputHistory)
        child.status = text.length > 100 ? 'completed' : 'failed'
        child.result = text || null
        child.error = text.length <= 100 ? 'Claude exited without sufficient output' : null
        child.completedAt = new Date().toISOString()
        return
      }

      await new Promise(resolve => setTimeout(resolve, pollMs))
    }

    // Timeout
    child.status = 'timed_out'
    child.error = `Timed out after ${timeoutMs}ms`
    child.completedAt = new Date().toISOString()

    // Try to stop the session gracefully
    const session = this.sessions.get(child.id)
    if (session?.claudeProcess?.isAlive()) {
      session.claudeProcess.stop()
    }
  }

  /**
   * Check whether the session completed the expected final step (PR, push, deploy).
   * If not, send a follow-up instruction and return true so monitoring continues.
   * Only nudges once per child to avoid infinite loops.
   */
  private ensureFinalStep(child: ChildSession, session: Session, text: string): boolean {
    // Only nudge once
    if ((child as ChildSession & { _nudged?: boolean })._nudged) return false

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
      (child as ChildSession & { _nudged?: boolean })._nudged = true
      // Clear the result message from history so we can detect the next one
      const resultIdx = session.outputHistory.findIndex(m => m.type === 'result')
      if (resultIdx !== -1) session.outputHistory.splice(resultIdx, 1)
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
