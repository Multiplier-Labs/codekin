/**
 * Session lifecycle manager for Codekin.
 *
 * Manages creation, deletion, persistence, and auto-restart of Claude sessions.
 * Each session wraps a ClaudeProcess, tracks connected WebSocket clients,
 * maintains an output history buffer for replay, and handles tool permission
 * approval workflows (both control_request and PreToolUse hook paths).
 *
 * Sessions are persisted to ~/.codekin/sessions.json on disk and restored
 * on server startup. Active sessions are automatically restarted after a
 * server restart with staggered delays.
 *
 * Delegates to focused modules:
 * - ApprovalManager: repo-level auto-approval rules for tools/commands
 * - SessionNaming: AI-powered session name generation with retry logic
 * - SessionPersistence: disk I/O for session state
 */

import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import { ClaudeProcess } from './claude-process.js'
import { SessionArchive } from './session-archive.js'
import type { Session, SessionInfo, TaskItem, WsServerMessage } from './types.js'
import { cleanupWorkspace } from './webhook-workspace.js'
import { PORT } from './config.js'
import { ApprovalManager } from './approval-manager.js'
import { SessionNaming } from './session-naming.js'
import { SessionPersistence } from './session-persistence.js'
import { deriveSessionToken } from './crypto-utils.js'

/** Max messages retained in a session's output history buffer. */
const MAX_HISTORY = 2000
/** Max auto-restart attempts before requiring manual intervention. */
const MAX_RESTARTS = 3
/** Window after which the restart counter resets (5 minutes). */
const RESTART_COOLDOWN_MS = 5 * 60 * 1000
/** Delay between crash and auto-restart attempt. */
const RESTART_DELAY_MS = 2000
/** No-output duration before emitting a stall warning (5 minutes). */
const STALL_TIMEOUT_MS = 5 * 60 * 1000
/** Max API error retries per turn before giving up. */
const MAX_API_RETRIES = 3
/** Base delay for API error retry (doubles each attempt: 3s, 6s, 12s). */
const API_RETRY_BASE_DELAY_MS = 3000
/** Patterns in result text that indicate a transient API error worth retrying. */
const API_RETRY_PATTERNS = [
  /api_error/i,
  /internal server error/i,
  /overloaded/i,
  /rate.?limit/i,
  /529/,
  /500/,
  /502/,
  /503/,
]

export interface CreateSessionOptions {
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow'
  id?: string
  groupDir?: string
  model?: string
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  /** SQLite archive for closed sessions. */
  readonly archive: SessionArchive
  /** Exposed so ws-server can pass its port to child Claude processes. */
  _serverPort = PORT
  /** Exposed so ws-server can pass the auth token to child Claude processes. */
  _authToken = ''
  /** Callback to broadcast a message to ALL connected WebSocket clients (set by ws-server). */
  _globalBroadcast: ((msg: WsServerMessage) => void) | null = null
  /** Registered listeners notified when a session's Claude process exits. */
  private _exitListeners: Array<(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void> = []

  /** Delegated approval logic. */
  private approvalManager: ApprovalManager
  /** Delegated naming logic. */
  private sessionNaming: SessionNaming
  /** Delegated persistence logic. */
  private sessionPersistence: SessionPersistence

  constructor() {
    this.archive = new SessionArchive()
    this.approvalManager = new ApprovalManager()
    this.sessionPersistence = new SessionPersistence(this.sessions)
    this.sessionNaming = new SessionNaming({
      getSession: (id) => this.sessions.get(id),
      hasSession: (id) => this.sessions.has(id),
      getSetting: (key, fallback) => this.archive.getSetting(key, fallback),
      rename: (sessionId, newName) => this.rename(sessionId, newName),
    })
    this.sessionPersistence.restoreFromDisk()
  }

  // ---------------------------------------------------------------------------
  // Approval delegation (preserves public API)
  // ---------------------------------------------------------------------------

  /** Check if a tool/command is auto-approved for a repo. */
  checkAutoApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    return this.approvalManager.checkAutoApproval(workingDir, toolName, toolInput)
  }

  /** Derive a glob pattern from a tool invocation for "Approve Pattern". */
  derivePattern(toolName: string, toolInput: Record<string, unknown>): string | null {
    return this.approvalManager.derivePattern(toolName, toolInput)
  }

  /** Return the auto-approved tools, commands, and patterns for a repo (workingDir). */
  getApprovals(workingDir: string): { tools: string[]; commands: string[]; patterns: string[] } {
    return this.approvalManager.getApprovals(workingDir)
  }

  /** Remove an auto-approval rule for a repo (workingDir) and persist to disk. */
  removeApproval(workingDir: string, opts: { tool?: string; command?: string; pattern?: string }, skipPersist = false): 'invalid' | boolean {
    return this.approvalManager.removeApproval(workingDir, opts, skipPersist)
  }

  /** Add an auto-approval rule for a repo and persist (used by tests via `as any`). */
  private addRepoApproval(workingDir: string, opts: { tool?: string; command?: string; pattern?: string }): void {
    this.approvalManager.addRepoApproval(workingDir, opts)
  }

  /** Write repo-level approvals to disk. Exposed for shutdown. */
  persistRepoApprovals(): void {
    this.approvalManager.persistRepoApprovals()
  }

  // ---------------------------------------------------------------------------
  // Naming delegation (preserves public API)
  // ---------------------------------------------------------------------------

  /** Schedule session naming via AI provider. */
  scheduleSessionNaming(sessionId: string): void {
    this.sessionNaming.scheduleSessionNaming(sessionId)
  }

  /** Re-trigger session naming on user interaction. */
  retrySessionNamingOnInteraction(sessionId: string): void {
    this.sessionNaming.retrySessionNamingOnInteraction(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Persistence delegation (preserves public API)
  // ---------------------------------------------------------------------------

  /** Write all sessions to disk as JSON (atomic rename to prevent corruption). */
  persistToDisk(): void {
    this.sessionPersistence.persistToDisk()
  }

  private persistToDiskDebounced(): void {
    this.sessionPersistence.persistToDiskDebounced()
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  /** Create a new session and persist to disk. */
  create(name: string, workingDir: string, options?: CreateSessionOptions): Session {
    const id = options?.id ?? randomUUID()
    const session: Session = {
      id,
      name,
      workingDir,
      groupDir: options?.groupDir,
      created: new Date().toISOString(),
      source: options?.source ?? 'manual',
      model: options?.model,
      claudeProcess: null,
      clients: new Set(),
      outputHistory: [],
      claudeSessionId: null,
      restartCount: 0,
      lastRestartAt: null,
      _stoppedByUser: false,
      _stallTimer: null,
      _wasActiveBeforeRestart: false,
      _apiRetryCount: 0,
      _turnCount: 0,
      _namingAttempts: 0,
      isProcessing: false,
      pendingControlRequests: new Map(),
      pendingToolApprovals: new Map(),
    }
    this.sessions.set(id, session)
    this.persistToDisk()
    this._globalBroadcast?.({ type: 'sessions_updated' })
    return session
  }

  /** Register a listener called when any session's Claude process exits.
   *  The `willRestart` flag indicates whether the session will be auto-restarted. */
  onSessionExit(listener: (sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void): void {
    this._exitListeners.push(listener)
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      created: s.created,
      active: s.claudeProcess?.isAlive() ?? false,
      isProcessing: s.isProcessing,
      workingDir: s.workingDir,
      groupDir: s.groupDir,
      connectedClients: s.clients.size,
      lastActivity: s.created,
      source: s.source,
    }))
  }

  rename(sessionId: string, newName: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.name = newName
    this.persistToDiskDebounced()
    // Broadcast to all clients in this session
    this.broadcast(session, { type: 'session_name_update', sessionId, name: newName })
    return true
  }

  /** Add a WebSocket client to a session. Returns the session or undefined if not found.
   *  Re-broadcasts any pending approval/control prompts so the joining client sees them. */
  join(sessionId: string, ws: WebSocket): Session | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined

    session.clients.add(ws)

    // Re-broadcast pending tool approval prompts (PreToolUse hook path)
    for (const pending of session.pendingToolApprovals.values()) {
      if (pending.promptMsg) {
        console.log(`[session] re-broadcasting pending tool approval on join: ${pending.toolName}`)
        this.broadcast(session, pending.promptMsg)
      }
    }

    // Re-broadcast pending control request prompts (AskUserQuestion, Bash fallback)
    for (const pending of session.pendingControlRequests.values()) {
      if (pending.promptMsg) {
        console.log(`[session] re-broadcasting pending control request on join: ${pending.toolName}`)
        this.broadcast(session, pending.promptMsg)
      }
    }

    return session
  }

  /** Remove a WebSocket client from a session. Auto-denies pending prompts if last client leaves. */
  leave(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.clients.delete(ws)

      // If no clients remain, auto-deny all pending prompts to prevent hangs
      if (session.clients.size === 0) {
        if (session.pendingControlRequests.size > 0) {
          console.log(`[session] last client left, auto-denying ${session.pendingControlRequests.size} pending control requests`)
          for (const [requestId] of session.pendingControlRequests) {
            session.claudeProcess?.sendControlResponse(requestId, 'deny')
          }
          session.pendingControlRequests.clear()
        }
        if (session.pendingToolApprovals.size > 0) {
          console.log(`[session] last client left, auto-denying ${session.pendingToolApprovals.size} pending tool approval(s)`)
          for (const [reqId, pending] of session.pendingToolApprovals) {
            pending.resolve({ allow: false, always: false })
            this.broadcast(session, { type: 'prompt_dismiss', requestId: reqId })
          }
          session.pendingToolApprovals.clear()
        }
      }
    }
  }

  /** Delete a session: kill its process, notify clients, remove from memory and disk. */
  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Prevent auto-restart when deleting
    session._stoppedByUser = true
    this.clearStallTimer(session)
    if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
    if (session._namingTimer) clearTimeout(session._namingTimer)

    // Kill claude process if running
    if (session.claudeProcess) {
      session.claudeProcess.stop()
      session.claudeProcess = null
    }

    this.archiveSessionIfWorthSaving(session)

    // Clean up webhook workspace directory if applicable
    if (session.source === 'webhook' || session.source === 'stepflow') {
      cleanupWorkspace(sessionId)
    }

    // Notify connected clients
    this.broadcast(session, { type: 'session_deleted', message: 'Session was deleted' })

    // Disconnect all clients from this session
    session.clients.clear()

    this.sessions.delete(sessionId)
    this.persistToDisk()
    this._globalBroadcast?.({ type: 'sessions_updated' })
    return true
  }

  /**
   * Archive a session if it has enough output to be worth saving (>= 150 chars).
   * Skips sessions with trivially short or empty output to avoid cluttering the archive.
   */
  private archiveSessionIfWorthSaving(session: Session): void {
    const totalOutputLength = session.outputHistory
      .filter((m): m is { type: 'output'; data: string } => m.type === 'output')
      .reduce((sum, m) => sum + m.data.length, 0)
    if (totalOutputLength < 150) return

    // If session was never named (still has hub: prefix), derive a name from the
    // first user message or fall back to a short ID-based placeholder.
    let archiveName = session.name
    if (archiveName.startsWith('hub:')) {
      const firstUserMsg = session._lastUserInput?.slice(0, 60)?.trim()
      archiveName = firstUserMsg || `session-${session.id.slice(0, 8)}`
    }
    try {
      this.archive.archive({
        id: session.id,
        name: archiveName,
        workingDir: session.workingDir,
        groupDir: session.groupDir,
        source: session.source,
        created: session.created,
        outputHistory: session.outputHistory,
      })
    } catch (err) {
      console.error('[session-manager] Failed to archive session:', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Claude process lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawn (or re-spawn) a Claude CLI process for a session.
   * Wires up all event handlers for streaming text, tools, prompts, and auto-restart.
   */
  startClaude(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Clear stopped flag on explicit start
    session._stoppedByUser = false

    // Kill existing process if any
    if (session.claudeProcess) {
      session.claudeProcess.stop()
    }

    // Derive a session-scoped token instead of forwarding the master auth token.
    // This limits child process privileges to approve/deny for their own session only.
    const sessionToken = this._authToken
      ? deriveSessionToken(this._authToken, sessionId)
      : ''
    const extraEnv: Record<string, string> = {
      CODEKIN_SESSION_ID: sessionId,
      CODEKIN_PORT: String(this._serverPort || PORT),
      CODEKIN_TOKEN: sessionToken,
      CODEKIN_AUTH_TOKEN: sessionToken,
      CODEKIN_SESSION_TYPE: session.source || 'manual',
    }
    // Pass CLAUDE_PROJECT_DIR so hooks resolve correctly even when the session's
    // working directory differs from the project root (e.g. webhook workspaces).
    if (process.env.CLAUDE_PROJECT_DIR) {
      extraEnv.CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR
    }
    const cp = new ClaudeProcess(session.workingDir, session.claudeSessionId || undefined, extraEnv, session.model)

    this.wireClaudeEvents(cp, session, sessionId)

    cp.start()
    session.claudeProcess = cp
    this.resetStallTimer(session)
    this._globalBroadcast?.({ type: 'sessions_updated' })

    const startMsg: WsServerMessage = { type: 'claude_started', sessionId }
    this.addToHistory(session, startMsg)
    this.broadcast(session, startMsg)
    return true
  }

  /**
   * Attach all ClaudeProcess event listeners for a session.
   * Extracted from startClaude() to keep that method focused on process setup.
   */
  private wireClaudeEvents(cp: ClaudeProcess, session: Session, sessionId: string): void {
    cp.on('system_init', (model) => {
      // Capture the actual Claude session ID for future restarts
      session.claudeSessionId = cp.getSessionId()
      const initMsg: WsServerMessage = { type: 'system_message', subtype: 'init', text: `Model: ${model}`, model }
      this.addToHistory(session, initMsg)
      this.broadcast(session, initMsg)
    })

    cp.on('text', (text) => {
      this.resetStallTimer(session)
      const msg: WsServerMessage = { type: 'output', data: text }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
      // Start the naming timer on first text — we now have user msg + early response context
      if (session.name.startsWith('hub:') && !session._namingTimer) {
        this.scheduleSessionNaming(sessionId)
      }
    })

    cp.on('thinking', (summary) => {
      this.resetStallTimer(session)
      const msg: WsServerMessage = { type: 'thinking', summary }
      // Don't persist thinking to history — it's ephemeral status
      this.broadcast(session, msg)
    })

    cp.on('tool_output', (content, isError) => {
      this.resetStallTimer(session)
      const msg: WsServerMessage = { type: 'tool_output', content, isError }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    })

    cp.on('tool_active', (toolName, toolInput) => {
      this.resetStallTimer(session)
      const msg: WsServerMessage = { type: 'tool_active', toolName, toolInput }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    })

    cp.on('tool_done', (toolName, summary) => {
      this.resetStallTimer(session)
      const msg: WsServerMessage = { type: 'tool_done', toolName, summary }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    })

    cp.on('planning_mode', (active) => {
      const msg: WsServerMessage = { type: 'planning_mode', active }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    })

    cp.on('todo_update', (tasks) => {
      const msg: WsServerMessage = { type: 'todo_update', tasks }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    })

    cp.on('prompt', (promptType, question, options, multiSelect, toolName, toolInput, requestId, questions) => {
      const promptMsg: WsServerMessage = {
        type: 'prompt',
        promptType,
        question,
        options,
        multiSelect,
        toolName,
        toolInput,
        requestId,
        ...(questions ? { questions } : {}),
      }
      if (requestId) {
        session.pendingControlRequests.set(requestId, { requestId, toolName: 'AskUserQuestion', toolInput: toolInput || {}, promptMsg })
      }
      this.broadcast(session, promptMsg)
    })

    cp.on('control_request', (requestId, toolName, toolInput) => {
      console.log(`[control_request] session=${sessionId} tool=${toolName} requestId=${requestId}`)

      // Check repo-level auto-approval registry before prompting UI
      if (this.checkAutoApproval(session.workingDir, toolName, toolInput)) {
        console.log(`[control_request] auto-approved: ${toolName}`)
        cp.sendControlResponse(requestId, 'allow')
        return
      }

      // Webhook/workflow sessions with no clients: auto-approve (headless, no human to prompt)
      if (session.clients.size === 0 && (session.source === 'webhook' || session.source === 'workflow' || session.source === 'stepflow')) {
        console.log(`[control_request] no clients connected (${session.source} session), auto-approving: ${toolName}`)
        cp.sendControlResponse(requestId, 'allow')
        return
      }

      // Store in pending map (supports concurrent requests)
      const question = this.summarizeToolPermission(toolName, toolInput)
      const options = [
        { label: 'Allow', value: 'allow' },
        { label: 'Always Allow', value: 'always_allow' },
        { label: 'Deny', value: 'deny' },
      ]
      const promptMsg: WsServerMessage = {
        type: 'prompt',
        promptType: 'permission',
        question,
        options,
        toolName,
        toolInput,
        requestId,
      }
      session.pendingControlRequests.set(requestId, { requestId, toolName, toolInput, promptMsg })

      if (session.clients.size > 0) {
        this.broadcast(session, promptMsg)
      } else {
        // No clients connected for manual session — broadcast globally so the
        // user sees a waiting indicator. The prompt will be re-sent when they join.
        console.log(`[control_request] no clients connected, waiting for client to join: ${toolName}`)
        this._globalBroadcast?.({
          ...promptMsg,
          sessionId,
          sessionName: session.name,
        })
      }
    })

    cp.on('result', (result, isError) => {
      this.resetStallTimer(session)
      this.handleClaudeResult(session, sessionId, result, isError)
    })

    cp.on('error', (message) => {
      this.broadcast(session, { type: 'error', message })
    })

    cp.on('exit', (code, signal) => {
      this.handleClaudeExit(session, sessionId, code, signal)
    })
  }

  /**
   * Handle a Claude process 'result' event: update session state, apply API
   * retry logic for transient errors, broadcast result to clients, and trigger
   * session naming on first completed turn.
   */
  private handleClaudeResult(session: Session, sessionId: string, result: string, isError: boolean): void {
    session.isProcessing = false
    this._globalBroadcast?.({ type: 'sessions_updated' })

    // Detect transient API errors and auto-retry the last user message
    if (isError && session._lastUserInput && this.isRetryableApiError(result)) {
      if (session._apiRetryCount < MAX_API_RETRIES) {
        session._apiRetryCount++
        const attempt = session._apiRetryCount
        const delay = API_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)

        const retryMsg: WsServerMessage = {
          type: 'system_message',
          subtype: 'restart',
          text: `API error (transient). Retrying automatically in ${delay / 1000}s (attempt ${attempt}/${MAX_API_RETRIES})...`,
        }
        this.addToHistory(session, retryMsg)
        this.broadcast(session, retryMsg)

        console.log(`[api-retry] session=${sessionId} attempt=${attempt}/${MAX_API_RETRIES} delay=${delay}ms error=${result.slice(0, 200)}`)

        // Clear any previous retry timer
        if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
        session._apiRetryTimer = setTimeout(() => {
          session._apiRetryTimer = undefined
          if (!session.claudeProcess?.isAlive() || session._stoppedByUser) return
          console.log(`[api-retry] resending message for session=${sessionId} attempt=${attempt}`)
          session.claudeProcess.sendMessage(session._lastUserInput!)
        }, delay)
        return // Don't broadcast result — we're retrying
      }

      // All retries exhausted
      const exhaustedMsg: WsServerMessage = {
        type: 'system_message',
        subtype: 'error',
        text: `API error persisted after ${MAX_API_RETRIES} retries. ${result}`,
      }
      this.addToHistory(session, exhaustedMsg)
      this.broadcast(session, exhaustedMsg)
      session._apiRetryCount = 0
    } else {
      // Non-retryable error or successful result — reset retry counter
      session._apiRetryCount = 0
      if (isError) {
        const msg: WsServerMessage = { type: 'system_message', subtype: 'error', text: result }
        this.addToHistory(session, msg)
        this.broadcast(session, msg)
      }
    }

    const resultMsg: WsServerMessage = { type: 'result' }
    this.addToHistory(session, resultMsg)
    this.broadcast(session, resultMsg)

    // If session is still unnamed after first response, name it now — we have full context
    if (session.name.startsWith('hub:') && session._namingAttempts === 0) {
      if (session._namingTimer) {
        clearTimeout(session._namingTimer)
        delete session._namingTimer
      }
      void this.sessionNaming.executeSessionNaming(sessionId)
    }
  }

  /**
   * Handle a Claude process 'exit' event: clean up state, notify exit listeners,
   * and either auto-restart (within limits) or broadcast the final exit message.
   */
  private handleClaudeExit(session: Session, sessionId: string, code: number | null, signal: string | null): void {
    session.claudeProcess = null
    session.isProcessing = false
    this.clearStallTimer(session)
    this._globalBroadcast?.({ type: 'sessions_updated' })

    // If stopped by user (stop button or session deleted), don't auto-restart
    if (session._stoppedByUser) {
      // Notify exit listeners — no restart will occur
      for (const listener of this._exitListeners) {
        try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
      }
      const msg: WsServerMessage = { type: 'system_message', subtype: 'exit', text: `Claude process exited: code=${code}, signal=${signal}` }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
      this.broadcast(session, { type: 'exit', code: code ?? -1, signal })
      return
    }

    // Auto-restart logic
    const now = Date.now()
    if (session.lastRestartAt && (now - session.lastRestartAt) > RESTART_COOLDOWN_MS) {
      session.restartCount = 0
    }

    if (session.restartCount < MAX_RESTARTS) {
      session.restartCount++
      session.lastRestartAt = now
      const attempt = session.restartCount

      // Notify exit listeners with willRestart=true so they don't treat
      // this as a final exit (e.g. webhook handler won't mark event as error)
      for (const listener of this._exitListeners) {
        try { listener(sessionId, code, signal, true) } catch { /* listener error */ }
      }

      // If Claude exited with code=1 on first attempt and we had a saved
      // session ID, it may be stale/invalid. Clear it so the next retry
      // starts a fresh session instead of repeating the same failure.
      if (code === 1 && attempt === 1 && session.claudeSessionId) {
        console.log(`[restart] Clearing potentially stale claudeSessionId for session ${sessionId}`)
        session.claudeSessionId = null
      }

      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'restart',
        text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Restarting (attempt ${attempt}/${MAX_RESTARTS})...`,
      }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)

      setTimeout(() => {
        // Verify session still exists and hasn't been stopped
        if (!this.sessions.has(sessionId) || session._stoppedByUser) return
        this.startClaude(sessionId)
      }, RESTART_DELAY_MS)
    } else {
      // Final exit — all restart attempts exhausted
      for (const listener of this._exitListeners) {
        try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
      }
      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'error',
        text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Auto-restart disabled after ${MAX_RESTARTS} attempts. Please restart manually.`,
      }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
      this.broadcast(session, { type: 'exit', code: code ?? -1, signal })
    }
  }

  /**
   * Send user input to a session's Claude process.
   * Auto-starts Claude if not running, with session context for continuity.
   */
  sendInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (!session.claudeProcess?.isAlive()) {
      // Claude not running (e.g. after server restart) — auto-start first.
      // Claude CLI in -p mode waits for first input before emitting init,
      // so we write directly to the stdin pipe buffer (no waiting for init).
      this.startClaude(sessionId)

      // If we have a saved claudeSessionId, Claude CLI resumes with full
      // conversation history from its own session storage — no need for our
      // lossy 4000-char context summary. Only fall back to buildSessionContext
      // for sessions without a saved Claude session ID.
      if (!session.claudeSessionId) {
        const context = this.buildSessionContext(session)
        if (context) {
          const combined = context + '\n\n' + data
          session._lastUserInput = combined
          session._apiRetryCount = 0
          if (!session.isProcessing) {
            session.isProcessing = true
            this._globalBroadcast?.({ type: 'sessions_updated' })
          }
          session.claudeProcess?.sendMessage(combined)
          return
        }
      }
    }

    // Track turn count; retry naming on subsequent interactions if still unnamed
    if (session._turnCount === 0 && session.name.startsWith('hub:')) {
      session._turnCount = 1
    } else if (session.name.startsWith('hub:')) {
      // Session still unnamed after initial attempt — retry on user interaction
      this.retrySessionNamingOnInteraction(sessionId)
    }

    session._lastUserInput = data
    session._apiRetryCount = 0
    if (!session.isProcessing) {
      session.isProcessing = true
      this._globalBroadcast?.({ type: 'sessions_updated' })
    }
    session.claudeProcess?.sendMessage(data)
  }

  /**
   * Route a user's prompt response to the correct handler: pending tool approval
   * (from PermissionRequest hook), pending control request (from control_request
   * fallback path), or plain message fallback.
   */
  sendPromptResponse(sessionId: string, value: string | string[], requestId?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Check for pending tool approval from PreToolUse hook
    // Match by requestId if provided, otherwise fall back to oldest pending approval
    const approval = requestId
      ? session.pendingToolApprovals.get(requestId)
      : session.pendingToolApprovals.values().next().value  // fallback: oldest
    if (approval) {
      this.resolveToolApproval(session, approval, value)
      return
    }

    if (!session.claudeProcess?.isAlive()) return

    // Find matching pending control request
    const pending = requestId
      ? session.pendingControlRequests.get(requestId)
      : session.pendingControlRequests.values().next().value  // fallback: oldest

    if (pending) {
      session.pendingControlRequests.delete(pending.requestId)
      // Dismiss prompt on all other clients viewing this session
      this.broadcast(session, { type: 'prompt_dismiss', requestId: pending.requestId })

      if (pending.toolName === 'AskUserQuestion') {
        this.handleAskUserQuestion(session, pending, value)
      } else {
        this.sendControlResponseForRequest(session, pending, value)
      }
    } else {
      // Fallback: no pending control request, send as plain user message
      const answer = Array.isArray(value) ? value.join(', ') : value
      session.claudeProcess.sendMessage(answer)
    }
  }

  /** Decode the allow/deny/always/pattern intent from a prompt response value. */
  private decodeApprovalValue(value: string | string[]): { isDeny: boolean; isAlwaysAllow: boolean; isApprovePattern: boolean } {
    const first = Array.isArray(value) ? value[0] : value
    return {
      isDeny: first === 'deny',
      isAlwaysAllow: first === 'always_allow',
      isApprovePattern: first === 'approve_pattern',
    }
  }

  /** Resolve a pending PreToolUse hook approval and update auto-approval registries. */
  private resolveToolApproval(
    session: Session,
    approval: { resolve: (r: { allow: boolean; always: boolean }) => void; toolName: string; toolInput: Record<string, unknown>; requestId: string },
    value: string | string[],
  ): void {
    const { isDeny, isAlwaysAllow, isApprovePattern } = this.decodeApprovalValue(value)

    if (isAlwaysAllow && !isDeny) {
      this.approvalManager.saveAlwaysAllow(session.workingDir, approval.toolName, approval.toolInput)
    }
    if (isApprovePattern && !isDeny) {
      this.approvalManager.savePatternApproval(session.workingDir, approval.toolName, approval.toolInput)
    }

    console.log(`[tool-approval] resolving: allow=${!isDeny} always=${isAlwaysAllow} pattern=${isApprovePattern} tool=${approval.toolName}`)
    approval.resolve({ allow: !isDeny, always: isAlwaysAllow || isApprovePattern })
    session.pendingToolApprovals.delete(approval.requestId)
    this.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
  }

  /**
   * Send an AskUserQuestion control response, mapping the user's answer(s) into
   * the structured answers map the tool expects.
   */
  private handleAskUserQuestion(
    session: Session,
    pending: { requestId: string; toolInput: Record<string, unknown> },
    value: string | string[],
  ): void {
    const questions = pending.toolInput?.questions as Array<{ question: string }> | undefined
    const updatedInput: Record<string, unknown> = { ...pending.toolInput }

    let answers: Record<string, string> = {}
    if (typeof value === 'string') {
      // Try parsing as JSON answers map (multi-question flow)
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          answers = parsed as Record<string, string>
        } else if (Array.isArray(questions) && questions.length > 0) {
          answers[questions[0].question] = value
        }
      } catch {
        // Plain string answer — map to first question
        if (Array.isArray(questions) && questions.length > 0) {
          answers[questions[0].question] = value
        }
      }
    } else if (Array.isArray(value) && Array.isArray(questions) && questions.length > 0) {
      // Array of answers — map to first question (multi-select single question)
      answers[questions[0].question] = value.join(', ')
    }

    updatedInput.answers = answers
    session.claudeProcess!.sendControlResponse(pending.requestId, 'allow', updatedInput)
  }

  /** Send a permission control response (allow/always_allow/approve_pattern/deny). */
  private sendControlResponseForRequest(
    session: Session,
    pending: { requestId: string; toolName: string; toolInput: Record<string, unknown> },
    value: string | string[],
  ): void {
    const { isDeny, isAlwaysAllow, isApprovePattern } = this.decodeApprovalValue(value)

    if (isAlwaysAllow) {
      this.approvalManager.saveAlwaysAllow(session.workingDir, pending.toolName, pending.toolInput)
    }
    if (isApprovePattern) {
      this.approvalManager.savePatternApproval(session.workingDir, pending.toolName, pending.toolInput)
    }

    const behavior = isDeny ? 'deny' : 'allow'
    session.claudeProcess!.sendControlResponse(pending.requestId, behavior)
  }

  /**
   * Called by the PermissionRequest hook HTTP endpoint. Sends a prompt to clients
   * and returns a Promise that resolves when the user approves/denies.
   */
  requestToolApproval(sessionId: string, toolName: string, toolInput: Record<string, unknown>): Promise<{ allow: boolean; always: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[tool-approval] session not found: ${sessionId}`)
      return Promise.resolve({ allow: false, always: false })
    }

    // Check repo-level auto-approval registry before prompting UI
    if (this.checkAutoApproval(session.workingDir, toolName, toolInput)) {
      console.log(`[tool-approval] auto-approved: ${toolName}`)
      return Promise.resolve({ allow: true, always: true })
    }

    // Webhook/workflow sessions with no clients: auto-approve (headless)
    if (session.clients.size === 0 && (session.source === 'webhook' || session.source === 'workflow' || session.source === 'stepflow')) {
      console.log(`[tool-approval] no clients (${session.source} session), auto-approving: ${toolName}`)
      return Promise.resolve({ allow: true, always: false })
    }

    console.log(`[tool-approval] requesting approval: session=${sessionId} tool=${toolName} clients=${session.clients.size}`)

    return new Promise<{ allow: boolean; always: boolean }>((resolve) => {
      // Holder lets wrappedResolve reference the timeout before it's assigned
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }

      const wrappedResolve = (result: { allow: boolean; always: boolean }) => {
        if (timer.id) clearTimeout(timer.id)
        resolve(result)
      }

      const approvalRequestId = randomUUID()

      // Timeout to prevent leaked promises if client disconnects after prompt is sent
      timer.id = setTimeout(() => {
        if (session.pendingToolApprovals.has(approvalRequestId)) {
          console.log(`[tool-approval] timed out for ${toolName}`)
          session.pendingToolApprovals.delete(approvalRequestId)
          // Dismiss the stale prompt in all clients so they don't inject
          // "allow"/"deny" as plain text after the timeout
          this.broadcast(session, { type: 'prompt_dismiss', requestId: approvalRequestId })
          resolve({ allow: false, always: false })
        }
      }, 60_000)

      const question = this.summarizeToolPermission(toolName, toolInput)
      const approvePattern = this.derivePattern(toolName, toolInput)
      const options = [
        { label: 'Allow', value: 'allow' },
        { label: 'Always Allow', value: 'always_allow' },
        { label: 'Deny', value: 'deny' },
      ]
      const promptMsg: WsServerMessage = {
        type: 'prompt',
        promptType: 'permission',
        question,
        options,
        toolName,
        toolInput,
        requestId: approvalRequestId,
        ...(approvePattern ? { approvePattern } : {}),
      }

      session.pendingToolApprovals.set(approvalRequestId, { resolve: wrappedResolve, toolName, toolInput, requestId: approvalRequestId, promptMsg })

      if (session.clients.size > 0) {
        this.broadcast(session, promptMsg)
      } else {
        // No clients connected — DON'T auto-deny. Instead, wait for a client
        // to join this session (the prompt will be re-broadcast in join()).
        // Send a global notification so the user sees a waiting indicator.
        console.log(`[tool-approval] no clients connected, waiting for client to join (timeout 60s): ${toolName}`)
        this._globalBroadcast?.({
          ...promptMsg,
          sessionId,
          sessionName: session.name,
        })
      }
    })
  }

  /** Build a human-readable prompt string for a tool permission dialog. */
  private summarizeToolPermission(toolName: string, toolInput: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        const cmd = String(toolInput.command || '')
        const firstLine = cmd.split('\n')[0]
        const display = firstLine.length < cmd.length ? `${firstLine}...` : cmd
        return `Allow Bash? \`$ ${display}\``
      }
      case 'Task':
        return `Allow Task? ${String(toolInput.description || toolName)}`
      case 'Read': {
        const filePath = String(toolInput.file_path || '')
        return `Allow Read? \`${filePath}\``
      }
      case 'ExitPlanMode':
        return 'Approve plan and start implementation?'
      default:
        return `Allow ${toolName}?`
    }
  }

  /** Update the model for a session and restart Claude with the new model. */
  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.model = model || undefined
    this.persistToDiskDebounced()
    // Restart Claude with the new model if it's running
    if (session.claudeProcess?.isAlive()) {
      this.stopClaude(sessionId)
      setTimeout(() => this.startClaude(sessionId), 500)
    }
    return true
  }

  stopClaude(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.claudeProcess) {
      session._stoppedByUser = true
      this.clearStallTimer(session)
      if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
      session.claudeProcess.stop()
      session.claudeProcess = null
      this.broadcast(session, { type: 'claude_stopped' })
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check if an error result text matches a transient API error worth retrying. */
  private isRetryableApiError(text: string): boolean {
    return API_RETRY_PATTERNS.some((pattern) => pattern.test(text))
  }

  /**
   * Build a condensed text summary of a session's conversation history.
   * Used as context when auto-starting Claude for sessions without a saved
   * Claude session ID (so the CLI can't resume from its own storage).
   * Caps output at ~4000 chars, keeping the most recent exchanges.
   */
  private buildSessionContext(session: Session): string | null {
    const history = session.outputHistory
    if (history.length === 0) return null

    const lines: string[] = []
    let assistantText = ''

    for (const msg of history) {
      switch (msg.type) {
        case 'user_echo':
          // Flush any accumulated assistant text
          if (assistantText) {
            const trimmed = assistantText.trim()
            if (trimmed) lines.push(`Assistant: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? '...' : ''}`)
            assistantText = ''
          }
          lines.push(`User: ${msg.text}`)
          break

        case 'output':
          assistantText += msg.data
          break

        case 'tool_active':
          lines.push(`[Tool: ${msg.toolName}]`)
          break

        case 'tool_done':
          if (msg.summary) lines.push(`[Tool result: ${msg.summary.slice(0, 200)}]`)
          break

        case 'result':
          if (assistantText) {
            const trimmed = assistantText.trim()
            if (trimmed) lines.push(`Assistant: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? '...' : ''}`)
            assistantText = ''
          }
          break
      }
    }

    // Flush remaining
    if (assistantText) {
      const trimmed = assistantText.trim()
      if (trimmed) lines.push(`Assistant: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? '...' : ''}`)
    }

    if (lines.length === 0) return null

    // Cap total context size
    let context = lines.join('\n')
    if (context.length > 4000) {
      // Keep the most recent exchanges
      while (context.length > 4000 && lines.length > 2) {
        lines.shift()
        context = lines.join('\n')
      }
    }

    return `[This session was interrupted by a server restart. Here is the previous conversation for context:]\n${context}\n[End of previous context. The user's new message follows.]`
  }

  private resetStallTimer(session: Session): void {
    this.clearStallTimer(session)
    session._stallTimer = setTimeout(() => {
      session._stallTimer = null
      if (!session.claudeProcess?.isAlive()) return
      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'stall',
        text: 'No output for 5 minutes. The process may be stalled.',
      }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    }, STALL_TIMEOUT_MS)
  }

  private clearStallTimer(session: Session): void {
    if (session._stallTimer) {
      clearTimeout(session._stallTimer)
      session._stallTimer = null
    }
  }

  /**
   * Append a message to a session's output history for replay.
   * Merges consecutive 'output' chunks into a single entry to save space.
   */
  addToHistory(session: Session, msg: WsServerMessage): void {
    if (msg.type === 'output') {
      const last = session.outputHistory[session.outputHistory.length - 1]
      if (last?.type === 'output' && (last as { type: 'output'; data: string }).data.length < 100_000) {
        (last as { type: 'output'; data: string }).data += msg.data
        this.persistToDiskDebounced()
        return
      }
    }
    session.outputHistory.push(msg)
    if (session.outputHistory.length > MAX_HISTORY) {
      session.outputHistory = session.outputHistory.slice(-MAX_HISTORY)
    }
    this.persistToDiskDebounced()
  }

  /** Send a message to all connected clients of a session, with back-pressure protection. */
  broadcast(session: Session, msg: WsServerMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of session.clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        if (ws.bufferedAmount > 1_048_576) { // 1MB high-water mark
          console.warn('[broadcast] dropping message, client buffer full')
          continue
        }
        ws.send(data)
      }
    }
  }

  // Find which session a WebSocket is connected to
  findSessionForClient(ws: WebSocket): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.clients.has(ws)) return session
    }
    return undefined
  }

  // Remove a client from all sessions
  removeClient(ws: WebSocket): void {
    for (const session of this.sessions.values()) {
      session.clients.delete(ws)
    }
  }

  /** Graceful shutdown: complete in-progress tasks, persist state, kill all processes. */
  shutdown(): void {
    // Complete in-progress tasks for active sessions before persisting.
    // This handles self-deploy: the commit/push task was the last step, and
    // the server restart means it succeeded. Without this, restored sessions
    // show a stale todo panel with the last task stuck as in_progress.
    for (const session of this.sessions.values()) {
      if (session.claudeProcess?.isAlive()) {
        this.completeInProgressTasks(session)
      }
    }

    // Persist BEFORE killing processes so wasActive flag captures which were running
    this.persistToDisk()
    this.persistRepoApprovals()

    // Kill all Claude child processes on server shutdown
    for (const session of this.sessions.values()) {
      if (session.claudeProcess?.isAlive()) {
        session.claudeProcess.stop()
      }
      this.clearStallTimer(session)
    }

    this.archive.shutdown()
  }

  /**
   * Mark all in_progress tasks as completed in a session's outputHistory.
   * Called during graceful shutdown so the todo panel doesn't show stale
   * in-progress state after session restore.
   */
  private completeInProgressTasks(session: Session): void {
    // Walk backwards to find the last todo_update
    for (let i = session.outputHistory.length - 1; i >= 0; i--) {
      const msg = session.outputHistory[i]
      if (msg.type === 'todo_update') {
        const tasks = (msg as { type: 'todo_update'; tasks: TaskItem[] }).tasks
        const hasInProgress = tasks.some(t => t.status === 'in_progress')
        if (hasInProgress) {
          const completedTasks: TaskItem[] = tasks.map(t =>
            t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t
          )
          // Append a new todo_update so history is preserved
          session.outputHistory.push({ type: 'todo_update', tasks: completedTasks })
        }
        break
      }
    }
  }

  /**
   * Auto-restart Claude processes for sessions that were active before a server
   * restart. Each session is started with a staggered delay to avoid flooding.
   * Claude CLI resumes with full conversation history via --session-id.
   */
  restoreActiveSessions(): void {
    const toRestore: Session[] = []
    for (const session of this.sessions.values()) {
      if (session._wasActiveBeforeRestart && session.claudeSessionId) {
        toRestore.push(session)
      }
    }

    if (toRestore.length === 0) return
    console.log(`Auto-restoring ${toRestore.length} previously active session(s)...`)

    toRestore.forEach((session, i) => {
      // Stagger starts by 1 second each to avoid overwhelming the system
      setTimeout(() => {
        if (session.claudeProcess?.isAlive()) return // already running

        console.log(`[restore] Starting Claude for session ${session.id} (${session.name}) with claudeSessionId=${session.claudeSessionId}`)
        this.startClaude(session.id)

        // Wait for Claude CLI to finish initializing before sending the
        // continuation message. Writing to stdin before system_init causes
        // the CLI to exit immediately with code=1.
        if (session.claudeProcess) {
          session.claudeProcess.once('system_init', () => {
            const continueMsg = '[Session restored after server restart. Continue where you left off. If you were in the middle of a task, resume it.]'
            session.claudeProcess?.sendMessage(continueMsg)
          })
        }

        const msg: WsServerMessage = {
          type: 'system_message',
          subtype: 'restart',
          text: 'Session auto-restored after server restart.',
        }
        this.addToHistory(session, msg)
        this.broadcast(session, msg)

        // Clear the flag
        session._wasActiveBeforeRestart = false
      }, i * 1000)
    })
  }
}
