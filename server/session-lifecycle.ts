/**
 * Claude process lifecycle management extracted from SessionManager.
 *
 * Handles:
 * - Starting/stopping Claude CLI processes (startClaude, stopClaude, stopClaudeAndWait)
 * - Waiting for process readiness (waitForReady)
 * - Wiring Claude process event handlers (wireClaudeEvents)
 * - Handling process exit and auto-restart logic (handleClaudeExit)
 */

import { existsSync } from 'fs'
import path from 'path'
import { ClaudeProcess } from './claude-process.js'
import { OpenCodeProcess } from './opencode-process.js'
import type { CodingProcess } from './coding-process.js'
import { ApprovalManager } from './approval-manager.js'
import type { PromptRouter } from './prompt-router.js'
import type { Session, WsServerMessage } from './types.js'
import { PORT } from './config.js'
import { deriveSessionToken } from './crypto-utils.js'
import { evaluateRestart } from './session-restart-scheduler.js'

/** Dependencies injected by SessionManager so SessionLifecycle can interact with session state. */
export interface SessionLifecycleDeps {
  getSession(id: string): Session | undefined
  hasSession(id: string): boolean
  broadcast(session: Session, msg: WsServerMessage): void
  addToHistory(session: Session, msg: WsServerMessage): void
  broadcastAndHistory(session: Session, msg: WsServerMessage): void
  persistToDisk(): void
  globalBroadcast: ((msg: WsServerMessage) => void) | null
  authToken: string
  serverPort: number
  approvalManager: ApprovalManager
  promptRouter: PromptRouter
  exitListeners: Array<(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void>
  // Event handler callbacks that remain in SessionManager
  onSystemInit(cp: CodingProcess, session: Session, model: string): void
  onTextEvent(session: Session, sessionId: string, text: string): void
  onThinkingEvent(session: Session, summary: string): void
  onToolOutputEvent(session: Session, content: string, isError: boolean): void
  onImageEvent(session: Session, base64: string, mediaType: string): void
  onToolActiveEvent(session: Session, toolName: string, toolInput: string | undefined): void
  onToolDoneEvent(session: Session, toolName: string, summary: string | undefined): void
  handleClaudeResult(session: Session, sessionId: string, result: string, isError: boolean): void
  buildSessionContext(session: Session): string | null
}

export class SessionLifecycle {
  private deps: SessionLifecycleDeps

  constructor(deps: SessionLifecycleDeps) {
    this.deps = deps
  }

  // ---------------------------------------------------------------------------
  // Claude process lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawn (or re-spawn) a Claude CLI process for a session.
   * Wires up all event handlers for streaming text, tools, prompts, and auto-restart.
   */
  startClaude(sessionId: string): boolean {
    const session = this.deps.getSession(sessionId)
    if (!session) return false

    // Clear stopped flag and any pending restart timer on explicit start
    session._stoppedByUser = false
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
    // Bump generation so any in-flight restart timers from a previous process
    // become stale and no-op when they fire.
    session._processGeneration = (session._processGeneration ?? 0) + 1

    // Validate that the working directory still exists.  Worktree directories
    // can be removed externally (cleanup, manual deletion, failed creation that
    // left a stale placeholder).  Fall back to groupDir (the original repo) so
    // the session can still function instead of entering an infinite restart loop.
    if (!existsSync(session.workingDir) || (session.worktreePath && !existsSync(path.join(session.workingDir, '.git')))) {
      const fallback = session.groupDir ?? session.workingDir
      if (fallback !== session.workingDir && existsSync(fallback)) {
        const deadPath = session.workingDir
        console.warn(`[startClaude] Working directory ${deadPath} missing or not a valid worktree — falling back to ${fallback}`)
        session.workingDir = fallback
        session.worktreePath = undefined
        this.deps.persistToDisk()
        this.deps.globalBroadcast?.({ type: 'sessions_updated' })
        const fallbackMsg: WsServerMessage = {
          type: 'system_message',
          subtype: 'notification',
          text: `Worktree directory ${deadPath} no longer exists. Falling back to original repository: ${fallback}`,
        }
        this.deps.addToHistory(session, fallbackMsg)
        this.deps.broadcast(session, fallbackMsg)
      } else if (!existsSync(session.workingDir)) {
        console.error(`[startClaude] Working directory ${session.workingDir} does not exist and no fallback available — cannot start`)
        session._stoppedByUser = true  // prevent restart loop
        const errMsg: WsServerMessage = {
          type: 'system_message',
          subtype: 'error',
          text: `Working directory ${session.workingDir} no longer exists and no fallback is available. Session cannot start.`,
        }
        this.deps.addToHistory(session, errMsg)
        this.deps.broadcast(session, errMsg)
        return false
      }
    }

    // Kill existing process if any — remove listeners first to prevent the
    // old process's exit handler from clobbering the new process reference
    // and triggering an unwanted auto-restart cycle.
    if (session.claudeProcess) {
      session.claudeProcess.removeAllListeners()
      session.claudeProcess.stop()
    }

    // Derive a session-scoped token instead of forwarding the master auth token.
    // This limits child process privileges to approve/deny for their own session only.
    const sessionToken = this.deps.authToken
      ? deriveSessionToken(this.deps.authToken, sessionId)
      : ''
    // Both CODEKIN_TOKEN (legacy name, used by older hooks) and CODEKIN_AUTH_TOKEN
    // (current canonical name) are set to the same derived value for backward compatibility.
    const extraEnv: Record<string, string> = {
      CODEKIN_SESSION_ID: sessionId,
      CODEKIN_PORT: String(this.deps.serverPort || PORT),
      CODEKIN_TOKEN: sessionToken,
      CODEKIN_AUTH_TOKEN: sessionToken,
      CODEKIN_SESSION_TYPE: session.source || 'manual',
      ...(session.permissionMode === 'dangerouslySkipPermissions' ? { CODEKIN_SKIP_PERMISSIONS: '1' } : {}),
    }
    // Pass CLAUDE_PROJECT_DIR so hooks and CLAUDE.md resolve correctly
    // even when the session's working directory differs from the project root
    // (e.g. worktrees, webhook workspaces).  Note: this does NOT control
    // session storage path — Claude CLI uses the CWD for that.
    if (session.groupDir) {
      extraEnv.CLAUDE_PROJECT_DIR = session.groupDir
    } else if (process.env.CLAUDE_PROJECT_DIR) {
      extraEnv.CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR
    }
    // When claudeSessionId exists, the session has run before and a JSONL file
    // exists on disk.  Use --resume (not --session-id) to continue it — --session-id
    // creates a *new* session and fails with "already in use" if the JSONL exists.
    const resume = !!session.claudeSessionId

    // Build comprehensive allowedTools from session-level overrides + registry approvals
    const repoDir = session.groupDir ?? session.workingDir
    const registryPatterns = this.deps.approvalManager.getAllowedToolsForRepo(repoDir)
    const mergedAllowedTools = [...new Set([...(session.allowedTools || []), ...registryPatterns])]
    let cp: CodingProcess
    if (session.provider === 'opencode') {
      cp = new OpenCodeProcess(session.workingDir, {
        sessionId: sessionId,
        opencodeSessionId: session.claudeSessionId || undefined,
        model: session.model,
        extraEnv,
        permissionMode: session.permissionMode,
      })
    } else {
      cp = new ClaudeProcess(session.workingDir, {
        sessionId: session.claudeSessionId || undefined,
        extraEnv,
        model: session.model,
        permissionMode: session.permissionMode,
        resume,
        allowedTools: mergedAllowedTools,
        addDirs: session.addDirs,
      })
    }

    this.wireClaudeEvents(cp, session, sessionId)

    cp.start()
    session.claudeProcess = cp
    this.deps.globalBroadcast?.({ type: 'sessions_updated' })

    const startMsg: WsServerMessage = { type: 'claude_started', sessionId }
    this.deps.addToHistory(session, startMsg)
    this.deps.broadcast(session, startMsg)
    return true
  }

  /**
   * Wait for a session's Claude process to emit its system_init event,
   * indicating it is ready to accept input. Resolves immediately if the
   * session already has a claudeSessionId (process previously initialized).
   * Times out after `timeoutMs` (default 30s) to avoid hanging indefinitely.
   */
  waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session?.claudeProcess) return Promise.resolve()
    // If the process is already fully initialized, resolve immediately.
    // Uses isReady() which accounts for provider differences: Claude is ready
    // as soon as alive (stdin buffered), OpenCode needs alive + opencodeSessionId.
    if (session.claudeProcess.isReady()) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        console.warn(`[waitForReady] Timed out waiting for system_init on ${sessionId} after ${timeoutMs}ms`)
        session.claudeProcess?.removeListener('exit', done)
        resolve()
      }, timeoutMs)
      session.claudeProcess!.once('system_init', done)
      session.claudeProcess!.once('exit', done) // fail-fast if process dies during init
    })
  }

  /**
   * Attach all ClaudeProcess event listeners for a session.
   * Called by startClaude() to keep that method focused on process setup.
   */
  wireClaudeEvents(cp: CodingProcess, session: Session, sessionId: string): void {
    cp.on('system_init', (model) => this.deps.onSystemInit(cp, session, model))
    cp.on('text', (text) => this.deps.onTextEvent(session, sessionId, text))
    cp.on('thinking', (summary) => this.deps.onThinkingEvent(session, summary))
    cp.on('tool_output', (content, isError) => this.deps.onToolOutputEvent(session, content, isError))
    cp.on('image', (base64Data, mediaType) => this.deps.onImageEvent(session, base64Data, mediaType))
    cp.on('tool_active', (toolName, toolInput) => this.deps.onToolActiveEvent(session, toolName, toolInput))
    cp.on('tool_done', (toolName, summary) => this.deps.onToolDoneEvent(session, toolName, summary))
    cp.on('planning_mode', (active) => {
      // Route EnterPlanMode through PlanManager for UI state tracking.
      // ExitPlanMode (active=false) is ignored here — the PreToolUse hook
      // is the enforcement gate, and it calls handleExitPlanModeApproval()
      // which transitions PlanManager to 'reviewing'.
      if (active) {
        session.planManager.onEnterPlanMode()
      }
      // ExitPlanMode stream event intentionally ignored — hook handles it.
    })
    cp.on('todo_update', (tasks) => { this.deps.broadcastAndHistory(session, { type: 'todo_update', tasks }) })
    cp.on('prompt', (...args) => this.deps.promptRouter.onPromptEvent(session, ...args))
    cp.on('control_request', (requestId, toolName, toolInput) => this.deps.promptRouter.onControlRequestEvent(cp, session, sessionId, requestId, toolName, toolInput))
    cp.on('result', (result, isError) => {
      session.planManager.onTurnEnd()
      this.deps.handleClaudeResult(session, sessionId, result, isError)
    })
    cp.on('error', (message) => this.deps.broadcast(session, { type: 'error', message }))
    cp.on('exit', (code, signal) => { cp.removeAllListeners(); this.handleClaudeExit(cp, session, sessionId, code, signal) })
  }

  /**
   * Handle a Claude process 'exit' event: clean up state, notify exit listeners,
   * and either auto-restart (within limits) or broadcast the final exit message.
   *
   * Uses evaluateRestart() for the restart decision, keeping this method focused
   * on state updates, listener notification, and message broadcasting.
   */
  handleClaudeExit(exitedProcess: CodingProcess, session: Session, sessionId: string, code: number | null, signal: string | null): void {
    // Guard: ignore exit events from stale processes that were replaced by a
    // new startClaude() call.  Without this, the old process's exit handler
    // would null out session.claudeProcess (which now points to the NEW
    // process), orphaning it and triggering an unwanted auto-restart cycle.
    if (session.claudeProcess && session.claudeProcess !== exitedProcess) {
      console.log(`[restart] Ignoring exit from stale process for session ${sessionId}`)
      return
    }
    session.claudeProcess = null
    session.isProcessing = false
    session.planManager.reset()
    this.deps.globalBroadcast?.({ type: 'sessions_updated' })

    // "Session ID is already in use" means another process holds the lock.
    // Retrying with the same session ID will fail every time, so treat this
    // as a non-restartable exit (same as stopped-by-user).
    // ClaudeProcess has diagnostic methods (hasSessionConflict, hadOutput, hasSpawnFailed)
    // that OpenCodeProcess does not. Duck-type check via property existence.
    const proc = exitedProcess as CodingProcess & Partial<Pick<ClaudeProcess, 'hasSessionConflict' | 'hadOutput' | 'hasSpawnFailed'>>
    const sessionConflict = proc.hasSessionConflict ? proc.hasSessionConflict() : false
    const producedOutput = proc.hadOutput ? proc.hadOutput() : true
    const spawnFailed = proc.hasSpawnFailed ? proc.hasSpawnFailed() : false

    // If the process exited without ever producing stdout output, --resume
    // likely hung on a broken/stale session.  But one failure could be transient
    // (slow startup, brief network blip), so we track consecutive no-output exits
    // and only clear claudeSessionId after 2 consecutive failures.  This avoids
    // silent context loss from a single unlucky exit.
    // Exception: if spawn() itself failed (ENOENT/EACCES), the process never
    // started — the session data on disk is fine, so preserve the ID and don't
    // count it.
    if (spawnFailed) {
      console.warn(`[restart] Session ${sessionId} spawn failed (binary not found) — preserving claudeSessionId for retry`)
    } else if (!producedOutput && session.claudeSessionId) {
      session._noOutputExitCount = (session._noOutputExitCount ?? 0) + 1
      const NO_OUTPUT_THRESHOLD = 2
      if (session._noOutputExitCount >= NO_OUTPUT_THRESHOLD) {
        console.warn(`[restart] Session ${sessionId} produced no output ${session._noOutputExitCount} consecutive times — clearing claudeSessionId to force fresh session`)
        session.claudeSessionId = null
        session._noOutputExitCount = 0
      } else {
        console.warn(`[restart] Session ${sessionId} produced no output before exit (${session._noOutputExitCount}/${NO_OUTPUT_THRESHOLD}) — will retry with same session ID`)
      }
    } else if (producedOutput) {
      // Successful output resets the consecutive no-output counter
      session._noOutputExitCount = 0
    }

    // Before evaluating restart, check if the working directory still exists.
    // If a worktree was deleted mid-session, fall back to the original repo
    // instead of entering a guaranteed restart death loop where every attempt
    // fails with the same missing CWD.
    if (!existsSync(session.workingDir)) {
      const fallback = session.groupDir
      if (fallback && existsSync(fallback)) {
        const deadPath = session.workingDir
        console.warn(`[restart] Working directory ${deadPath} no longer exists — falling back to ${fallback}`)
        session.workingDir = fallback
        session.worktreePath = undefined
        this.deps.persistToDisk()
        this.deps.globalBroadcast?.({ type: 'sessions_updated' })
        const fallbackMsg: WsServerMessage = {
          type: 'system_message',
          subtype: 'notification',
          text: `Worktree directory ${deadPath} was removed. Restarting in original repository: ${fallback}`,
        }
        this.deps.addToHistory(session, fallbackMsg)
        this.deps.broadcast(session, fallbackMsg)
      } else {
        // No fallback available — don't waste restart attempts
        console.error(`[restart] Working directory ${session.workingDir} does not exist and no fallback — stopping session`)
        session._stoppedByUser = true
        for (const listener of this.deps.exitListeners) {
          try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
        }
        const msg: WsServerMessage = {
          type: 'system_message',
          subtype: 'error',
          text: `Working directory ${session.workingDir} no longer exists and no fallback is available. Please delete this session and create a new one.`,
        }
        this.deps.addToHistory(session, msg)
        this.deps.broadcast(session, msg)
        this.deps.broadcast(session, { type: 'exit', code: code ?? -1, signal })
        return
      }
    }

    const action = evaluateRestart({
      restartCount: session.restartCount,
      lastRestartAt: session.lastRestartAt,
      stoppedByUser: session._stoppedByUser || sessionConflict,
      exitCode: code,
      exitSignal: signal,
    })

    if (action.kind === 'non_retryable') {
      for (const listener of this.deps.exitListeners) {
        try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
      }
      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'error',
        text: `Claude process exited with non-retryable error (code=${action.exitCode}). This usually indicates a configuration or argument problem. Please check your session settings and restart manually.`,
      }
      this.deps.addToHistory(session, msg)
      this.deps.broadcast(session, msg)
      this.deps.broadcast(session, { type: 'exit', code: code ?? -1, signal })
      return
    }

    if (action.kind === 'stopped_by_user') {
      for (const listener of this.deps.exitListeners) {
        try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
      }
      const text = sessionConflict
        ? 'Claude process exited: session ID is already in use by another process. Please restart manually.'
        : `Claude process exited: code=${code}, signal=${signal}`
      const msg: WsServerMessage = { type: 'system_message', subtype: 'exit', text }
      this.deps.addToHistory(session, msg)
      this.deps.broadcast(session, msg)
      this.deps.broadcast(session, { type: 'exit', code: code ?? -1, signal })
      return
    }

    if (action.kind === 'restart') {
      session.restartCount = action.updatedCount
      session.lastRestartAt = action.updatedLastRestartAt

      for (const listener of this.deps.exitListeners) {
        try { listener(sessionId, code, signal, true) } catch { /* listener error */ }
      }

      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'restart',
        text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Restarting (attempt ${action.attempt}/${action.maxAttempts})...`,
      }
      this.deps.addToHistory(session, msg)
      this.deps.broadcast(session, msg)

      // Clear any previously scheduled restart to prevent duplicate spawns
      if (session._restartTimer) clearTimeout(session._restartTimer)
      const generationAtSchedule = session._processGeneration ?? 0
      session._restartTimer = setTimeout(() => {
        session._restartTimer = undefined
        // Verify session still exists, hasn't been stopped, and no newer
        // process was started (by sendInput, manual restart, etc.) while
        // this timer was pending.
        if (!this.deps.hasSession(sessionId) || session._stoppedByUser) return
        if (session._processGeneration !== generationAtSchedule) {
          console.log(`[restart] Skipping stale restart timer for session ${sessionId} (generation ${generationAtSchedule} → ${session._processGeneration})`)
          return
        }
        // startClaude uses --resume when claudeSessionId exists, so the CLI
        // picks up the full conversation history from the JSONL automatically.
        this.startClaude(sessionId)

        // Fallback: if claudeSessionId was already null (fresh session that
        // crashed before system_init), inject a context summary so the new
        // session has some awareness of prior conversation.
        if (!session.claudeSessionId && session.claudeProcess && session.outputHistory.length > 0) {
          session.claudeProcess.once('system_init', () => {
            const context = this.deps.buildSessionContext(session)
            if (context) {
              session.claudeProcess?.sendMessage(
                context + '\n\n[Session resumed after process restart. Continue where you left off. If you were in the middle of a task, resume it.]',
              )
            }
          })
        }
      }, action.delayMs)
      return
    }

    // action.kind === 'exhausted'
    for (const listener of this.deps.exitListeners) {
      try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
    }
    const msg: WsServerMessage = {
      type: 'system_message',
      subtype: 'error',
      text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Auto-restart disabled after ${action.maxAttempts} attempts. Please restart manually.`,
    }
    this.deps.addToHistory(session, msg)
    this.deps.broadcast(session, msg)
    this.deps.broadcast(session, { type: 'exit', code: code ?? -1, signal })
  }

  stopClaude(sessionId: string): void {
    const session = this.deps.getSession(sessionId)
    if (session?.claudeProcess) {
      session._stoppedByUser = true
      if (session._apiRetry?.timer) clearTimeout(session._apiRetry.timer)
      if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
      session.claudeProcess.removeAllListeners()
      session.claudeProcess.stop()
      session.claudeProcess = null
      this.deps.broadcast(session, { type: 'claude_stopped' })
    }
  }

  /**
   * Stop the Claude process and wait for it to fully exit before resolving.
   * This prevents race conditions when restarting with the same session ID
   * (e.g. during mid-session worktree migration).
   */
  async stopClaudeAndWait(sessionId: string): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session?.claudeProcess) return

    const cp = session.claudeProcess
    session._stoppedByUser = true
    if (session._apiRetry?.timer) clearTimeout(session._apiRetry.timer)
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
    cp.removeAllListeners()
    cp.stop()
    this.deps.broadcast(session, { type: 'claude_stopped' })

    // Wait for the underlying OS process to fully exit BEFORE nulling the
    // reference.  Previously this was set to null before the await, which
    // allowed another caller (e.g. move_to_worktree) to call startClaude()
    // while the old process was still alive — causing concurrent git access
    // and index corruption.
    await cp.waitForExit()
    session.claudeProcess = null
  }
}
