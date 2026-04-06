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
 * - DiffManager: stateless git-diff operations
 * - evaluateRestart: pure restart-decision logic
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { promisify } from 'util'
import type { WebSocket } from 'ws'
import { ClaudeProcess } from './claude-process.js'
import { OpenCodeProcess } from './opencode-process.js'
import type { CodingProcess, CodingProvider } from './coding-process.js'
import { PlanManager } from './plan-manager.js'
import { SessionArchive } from './session-archive.js'
import type { DiffFileStatus, DiffScope, PromptQuestion, Session, SessionInfo, TaskItem, WsServerMessage } from './types.js'
import { cleanupWorkspace } from './webhook-workspace.js'
import { PORT } from './config.js'
import { ApprovalManager } from './approval-manager.js'
import { SessionNaming } from './session-naming.js'
import { SessionPersistence } from './session-persistence.js'
import { deriveSessionToken } from './crypto-utils.js'
import { cleanGitEnv, DiffManager } from './diff-manager.js'
import { evaluateRestart } from './session-restart-scheduler.js'

const execFileAsync = promisify(execFile)

/** Max messages retained in a session's output history buffer. */
const MAX_HISTORY = 2000
/** Max API error retries per turn before giving up. */
const MAX_API_RETRIES = 3
/** Base delay for API error retry (doubles each attempt: 3s, 6s, 12s). */
const API_RETRY_BASE_DELAY_MS = 3000
/** How long a session can be idle (no clients, no activity) before its process is stopped. */
const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
/** How often to check for idle sessions. */
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
/** How old a dead session must be before automatic pruning (7 days). */
const STALE_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Number of Claude turns before showing a context compression warning. */
const CONTEXT_WARNING_TURN_THRESHOLD = 15
/** Second warning at this threshold. */
const CONTEXT_CRITICAL_TURN_THRESHOLD = 25
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
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  id?: string
  groupDir?: string
  model?: string
  /** When true, create a git worktree as a sibling of workingDir and run Claude there. */
  useWorktree?: boolean
  /** Permission mode for the Claude CLI process. */
  permissionMode?: import('./types.js').PermissionMode
  /** Additional tools to pre-approve via --allowedTools (e.g. 'Bash(curl:*)', 'WebFetch'). */
  allowedTools?: string[]
  /** Extra directories to grant Claude access to via --add-dir. */
  addDirs?: string[]
  /** AI provider to use for this session. Defaults to 'claude'. */
  provider?: import('./coding-process.js').CodingProvider
}


export class SessionManager {
  /** All active (non-archived) sessions, keyed by session UUID. */
  private sessions = new Map<string, Session>()
  /** Reverse lookup: WebSocket → session ID for O(1) client-to-session resolution. */
  private clientSessionMap = new Map<WebSocket, string>()
  /** SQLite archive for closed sessions (persists conversation summaries across restarts). */
  readonly archive: SessionArchive
  /** Exposed so ws-server can pass its port to child Claude processes. */
  _serverPort = PORT
  /** Exposed so ws-server can pass the auth token to child Claude processes. */
  _authToken = ''
  /** Callback to broadcast a message to ALL connected WebSocket clients (set by ws-server on startup). */
  _globalBroadcast: ((msg: WsServerMessage) => void) | null = null
  /** Registered listeners notified when a session's Claude process exits (used by webhook-handler for chained workflows). */
  private _exitListeners: Array<(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void> = []
  /** Registered listeners notified when a session emits a prompt (permission or question). */
  private _promptListeners: Array<(sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void> = []
  /** Registered listeners notified when a session completes a turn (result event). */
  private _resultListeners: Array<(sessionId: string, isError: boolean) => void> = []
  /** Delegated approval logic (auto-approve patterns, deny-lists, pattern management). */
  private _approvalManager: ApprovalManager
  /** Delegated auto-naming logic (generates session names from first user message via Claude API). */
  private sessionNaming: SessionNaming
  /** Delegated persistence logic (saves/restores session metadata to disk across server restarts). */
  private sessionPersistence: SessionPersistence
  /** Delegated diff operations (git diff, discard changes). */
  private diffManager: DiffManager
  /** Interval handle for the idle session reaper. */
  private _idleReaperInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.archive = new SessionArchive()
    this._approvalManager = new ApprovalManager()
    this.diffManager = new DiffManager()
    this.sessionPersistence = new SessionPersistence(this.sessions)
    this.sessionNaming = new SessionNaming({
      getSession: (id) => this.sessions.get(id),
      hasSession: (id) => this.sessions.has(id),
      rename: (sessionId, newName) => this.rename(sessionId, newName),
    })
    this.sessionPersistence.restoreFromDisk()
    // Wire PlanManager events for restored sessions
    for (const session of this.sessions.values()) {
      this.wirePlanManager(session)
    }
    // Start idle session reaper
    this._idleReaperInterval = setInterval(() => this.reapIdleSessions(), IDLE_CHECK_INTERVAL_MS)
  }

  /**
   * Stop Claude processes for sessions that have been idle too long.
   * A session is idle when it has no connected clients and no activity
   * for IDLE_SESSION_TIMEOUT_MS. Only stops the process — does not delete
   * the session, so it can be resumed later via --resume.
   * Headless sessions (webhook, workflow, stepflow) are exempt.
   */
  private reapIdleSessions(): void {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      // Skip headless sessions — they are managed by their own lifecycles
      if (session.source === 'webhook' || session.source === 'workflow' || session.source === 'stepflow' || session.source === 'agent' || session.source === 'orchestrator') continue
      // Skip sessions with connected clients or no running process
      if (session.clients.size > 0 || !session.claudeProcess?.isAlive()) continue
      // Skip sessions that are actively processing
      if (session.isProcessing) continue

      const idleMs = now - session._lastActivityAt
      if (idleMs > IDLE_SESSION_TIMEOUT_MS) {
        console.log(`[idle-reaper] stopping idle session=${session.id} name="${session.name}" idle=${Math.round(idleMs / 60_000)}min`)
        session._stoppedByUser = true // prevent auto-restart
        session.claudeProcess.removeAllListeners()
        session.claudeProcess.stop()
        session.claudeProcess = null
        session.isProcessing = false
        const msg: WsServerMessage = { type: 'system_message', subtype: 'exit', text: 'Claude process stopped due to inactivity. It will resume when you send a new message.' }
        this.addToHistory(session, msg)
        this.persistToDiskDebounced()
        this._globalBroadcast?.({ type: 'sessions_updated' })
      }
    }

    // Prune stale sessions: no process, no clients, older than STALE_SESSION_AGE_MS
    // Agent and orchestrator sessions are exempt — they are long-lived by design.
    const staleIds: string[] = []
    for (const session of this.sessions.values()) {
      if (session.source === 'agent' || session.source === 'orchestrator') continue
      if (session.claudeProcess?.isAlive()) continue
      if (session.clients.size > 0) continue
      const ageMs = now - new Date(session.created).getTime()
      if (ageMs > STALE_SESSION_AGE_MS) {
        staleIds.push(session.id)
      }
    }
    for (const id of staleIds) {
      console.log(`[idle-reaper] pruning stale session=${id} (age > ${STALE_SESSION_AGE_MS / 86_400_000}d)`)
      this.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Approval — direct accessor (callers use sessions.approvalManager.xxx)
  // ---------------------------------------------------------------------------

  /** Direct access to the approval manager for callers that need repo-level approval operations. */
  get approvalManager(): ApprovalManager {
    return this._approvalManager
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
      provider: options?.provider ?? 'claude',
      model: options?.model,
      permissionMode: options?.permissionMode,
      allowedTools: options?.allowedTools,
      addDirs: options?.addDirs,
      claudeProcess: null,
      clients: new Set(),
      outputHistory: [],
      claudeSessionId: null,
      restartCount: 0,
      lastRestartAt: null,
      _stoppedByUser: false,
      _wasActiveBeforeRestart: false,
      _apiRetryCount: 0,
      _turnCount: 0,
      _claudeTurnCount: 0,
      _namingAttempts: 0,
      isProcessing: false,
      pendingControlRequests: new Map(),
      pendingToolApprovals: new Map(),
      _leaveGraceTimer: null,
      _lastActivityAt: Date.now(),
      planManager: new PlanManager(),
    }
    this.wirePlanManager(session)
    this.sessions.set(id, session)
    this.persistToDisk()
    this._globalBroadcast?.({ type: 'sessions_updated' })
    return session
  }

  /**
   * Create a git worktree for a session. Creates a new branch and worktree
   * as a sibling directory of the project root.
   * Returns the worktree path on success, or null on failure.
   */
  async createWorktree(sessionId: string, workingDir: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    try {
      // Resolve the actual git repo root — workingDir may be a subdirectory
      const env = cleanGitEnv()
      const { stdout: repoRootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workingDir,
        env,
        timeout: 5000,
      })
      const repoRoot = repoRootRaw.trim()
      if (!repoRoot || !path.isAbsolute(repoRoot)) {
        console.error(`[worktree] Invalid repo root resolved: "${repoRoot}"`)
        return null
      }

      const prefix = this.getWorktreeBranchPrefix()
      const shortId = sessionId.slice(0, 8)
      const branchName = `${prefix}${shortId}`
      const projectName = path.basename(repoRoot)
      const worktreePath = path.resolve(repoRoot, '..', `${projectName}-wt-${shortId}`)

      // Clean up stale state from previous failed attempts:
      // 1. Prune orphaned worktree entries (directory gone but git still tracks it)
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot, env, timeout: 5000 })
        .catch((e: unknown) => console.warn(`[worktree] prune failed:`, e instanceof Error ? e.message : e))
      // 2. Remove existing worktree directory if leftover from a partial failure
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, env, timeout: 5000 })
        .catch((e: unknown) => console.debug(`[worktree] remove prior worktree (expected if fresh):`, e instanceof Error ? e.message : e))
      // 3. Delete the branch if it exists (leftover from a failed worktree add)
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot, env, timeout: 5000 })
        .catch((e: unknown) => console.debug(`[worktree] branch cleanup (expected if fresh):`, e instanceof Error ? e.message : e))

      // Create the worktree with a new branch
      await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
        cwd: repoRoot,
        env,
        timeout: 15000,
      })

      // Update session to use the worktree as its working directory
      session.groupDir = repoRoot  // Group under original repo in sidebar
      session.workingDir = worktreePath
      session.worktreePath = worktreePath

      // Copy Claude CLI session data to the worktree's project storage dir.
      // startClaude() will use --resume (not --session-id) to continue the
      // session, which should find the JSONL globally. The copy here ensures
      // it's also available in the worktree's project dir as a safety net.
      if (session.claudeSessionId) {
        try {
          this.migrateClaudeSession(session.claudeSessionId, session.claudeSessionId, workingDir, worktreePath, session)
          console.log(`[worktree] Copied Claude session ${session.claudeSessionId} to worktree project dir`)
        } catch (err) {
          console.warn(`[worktree] Failed to migrate session data:`, err instanceof Error ? err.message : err)
        }
      }

      this.persistToDisk()
      this._globalBroadcast?.({ type: 'sessions_updated' })

      console.log(`[worktree] Created worktree for session ${sessionId}: ${worktreePath} (branch: ${branchName})`)
      return worktreePath
    } catch (err) {
      console.error(`[worktree] Failed to create worktree for session ${sessionId}:`, err)
      return null
    }
  }

  /**
   * Resolve the Claude CLI project storage directory for a given working dir.
   * Claude encodes the absolute path by replacing `/` with `-`.
   */
  private claudeProjectPath(cwd: string): string {
    const encoded = cwd.replace(/\//g, '-')
    return path.join(homedir(), '.claude', 'projects', encoded)
  }

  /**
   * Copy Claude CLI session data from the original project storage to
   * the target directory's project storage.  When oldId === newId the
   * file is copied without renaming, preserving internal sessionId fields.
   * Claude CLI determines session storage from the CWD, so for worktree
   * migrations the JSONL must be placed in the worktree's project dir.
   */
  private migrateClaudeSession(oldId: string, newId: string, originalDir: string, targetDir: string, session?: Session): void {
    const srcProjectDir = this.claudeProjectPath(originalDir)
    const dstProjectDir = this.claudeProjectPath(targetDir)
    const srcJsonl = path.join(srcProjectDir, `${oldId}.jsonl`)

    if (!existsSync(srcJsonl)) {
      console.warn(`[worktree] No session JSONL at ${srcJsonl}, conversation history will not be preserved`)
      if (session) {
        const warningMsg: WsServerMessage = {
          type: 'system_message',
          subtype: 'notification',
          text: 'Conversation history could not be preserved during worktree migration. The session will continue without prior context.',
        }
        this.addToHistory(session, warningMsg)
        this.broadcast(session, warningMsg)
      }
      return
    }

    // Claude CLI determines session storage from the CWD, not CLAUDE_PROJECT_DIR.
    // The worktree has a different CWD, so we must copy the JSONL into the
    // worktree's project storage directory for --session-id to find it.
    mkdirSync(dstProjectDir, { recursive: true })
    copyFileSync(srcJsonl, path.join(dstProjectDir, `${newId}.jsonl`))
    console.log(`[worktree] Copied session JSONL ${oldId} → ${newId} (${srcProjectDir} → ${dstProjectDir})`)

    // Copy session subdirectory (subagents/, tool-results/) if it exists
    const srcSessionDir = path.join(srcProjectDir, oldId)
    if (existsSync(srcSessionDir) && statSync(srcSessionDir).isDirectory()) {
      this.copyDirRecursive(srcSessionDir, path.join(dstProjectDir, newId))
      console.log(`[worktree] Copied session subdirectory ${oldId} → ${newId}`)
    }
  }

  /** Recursively copy a directory. */
  private copyDirRecursive(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name)
      const dstPath = path.join(dst, entry.name)
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, dstPath)
      } else {
        copyFileSync(srcPath, dstPath)
      }
    }
  }

  /**
   * Clean up a git worktree and its branch. Runs asynchronously and logs errors
   * but never throws — session deletion must not be blocked by cleanup failures.
   */
  private cleanupWorktree(worktreePath: string, repoDir: string): void {
    void (async () => {
      try {
        // Resolve the actual repo root (repoDir may itself be a worktree)
        const { stdout: repoRootRaw } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
          cwd: repoDir,
          timeout: 5000,
        }).catch(() => ({ stdout: repoDir }))
        const repoRoot = repoRootRaw.trim() || repoDir

        // Remove the worktree
        await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repoRoot,
          timeout: 10000,
        })
        console.log(`[worktree] Cleaned up worktree: ${worktreePath}`)

        // Prune any stale worktree references
        await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot, timeout: 5000 })
          .catch((e: unknown) => console.warn(`[worktree] prune after cleanup failed:`, e instanceof Error ? e.message : e))
      } catch (err) {
        console.warn(`[worktree] Failed to clean up worktree ${worktreePath}:`, err instanceof Error ? err.message : err)
      }
    })()
  }

  /** Get the configured worktree branch prefix (defaults to 'wt/'). */
  getWorktreeBranchPrefix(): string {
    return this.archive.getSetting('worktree_branch_prefix', 'wt/')
  }

  /** Set the worktree branch prefix. */
  setWorktreeBranchPrefix(prefix: string): void {
    this.archive.setSetting('worktree_branch_prefix', prefix)
  }

  /** Register a listener called when any session's Claude process exits.
   *  The `willRestart` flag indicates whether the session will be auto-restarted. */
  onSessionExit(listener: (sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void): () => void {
    this._exitListeners.push(listener)
    return () => {
      const idx = this._exitListeners.indexOf(listener)
      if (idx >= 0) this._exitListeners.splice(idx, 1)
    }
  }

  /** Register a listener called when any session emits a prompt (permission request or question). */
  onSessionPrompt(listener: (sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void): void {
    this._promptListeners.push(listener)
  }

  /** Register a listener called when any session completes a turn (result event). */
  onSessionResult(listener: (sessionId: string, isError: boolean) => void): () => void {
    this._resultListeners.push(listener)
    return () => {
      const idx = this._resultListeners.indexOf(listener)
      if (idx >= 0) this._resultListeners.splice(idx, 1)
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** Get all sessions that have pending prompts (waiting for approval or answer). */
  getPendingPrompts(): Array<{
    sessionId: string
    sessionName: string
    source: string
    prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }>
  }> {
    const results: Array<{
      sessionId: string
      sessionName: string
      source: string
      prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }>
    }> = []

    for (const session of this.sessions.values()) {
      const prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }> = []

      for (const [reqId, pending] of session.pendingToolApprovals) {
        prompts.push({
          requestId: reqId,
          promptType: pending.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          toolName: pending.toolName,
          toolInput: pending.toolInput,
        })
      }
      for (const [reqId, pending] of session.pendingControlRequests) {
        prompts.push({
          requestId: reqId,
          promptType: pending.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          toolName: pending.toolName,
          toolInput: pending.toolInput,
        })
      }

      if (prompts.length > 0) {
        results.push({ sessionId: session.id, sessionName: session.name, source: session.source, prompts })
      }
    }
    return results
  }

  /** Clear the isProcessing flag for a session and broadcast the update. */
  clearProcessingFlag(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.isProcessing) {
      session.isProcessing = false
      this._globalBroadcast?.({ type: 'sessions_updated' })
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map((s) => ({
        id: s.id,
        name: s.name,
        created: s.created,
        active: s.claudeProcess?.isAlive() ?? false,
        isProcessing: s.isProcessing,
        workingDir: s.workingDir,
        groupDir: s.groupDir,
        worktreePath: s.worktreePath,
        connectedClients: s.clients.size,
        lastActivity: new Date(s._lastActivityAt).toISOString(),
        source: s.source,
        provider: s.provider,
      }))
  }

  /** List ALL sessions including orchestrator — used by orchestrator cleanup endpoints. */
  listAll(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map((s) => ({
        id: s.id,
        name: s.name,
        created: s.created,
        active: s.claudeProcess?.isAlive() ?? false,
        isProcessing: s.isProcessing,
        workingDir: s.workingDir,
        groupDir: s.groupDir,
        worktreePath: s.worktreePath,
        connectedClients: s.clients.size,
        lastActivity: new Date(s._lastActivityAt).toISOString(),
        source: s.source,
        provider: s.provider,
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

    // Cancel pending auto-deny from leave grace period
    if (session._leaveGraceTimer) {
      clearTimeout(session._leaveGraceTimer)
      session._leaveGraceTimer = null
    }

    session.clients.add(ws)
    this.clientSessionMap.set(ws, sessionId)
    session._lastActivityAt = Date.now()

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

  /** Remove a WebSocket client from a session. Auto-denies pending prompts if last client leaves (after grace period). */
  leave(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.clients.delete(ws)
      this.clientSessionMap.delete(ws)

      // If no clients remain, wait a grace period before auto-denying.
      // This prevents false denials when the user is just refreshing the page.
      if (session.clients.size === 0) {
        if (session._leaveGraceTimer) clearTimeout(session._leaveGraceTimer)

        session._leaveGraceTimer = setTimeout(() => {
          session._leaveGraceTimer = null
          // Re-check: if still no clients after grace period, auto-deny
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
        }, 3000)
      }
    }
  }

  /** Delete a session: kill its process, notify clients, remove from memory and disk. */
  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Prevent auto-restart when deleting
    session._stoppedByUser = true
    if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
    if (session._namingTimer) clearTimeout(session._namingTimer)
    if (session._leaveGraceTimer) clearTimeout(session._leaveGraceTimer)

    // Kill claude process if running
    if (session.claudeProcess) {
      session.claudeProcess.stop()
      session.claudeProcess = null
    }

    this.archiveSessionIfWorthSaving(session)

    // Clean up git worktree if this session used one
    if (session.worktreePath) {
      this.cleanupWorktree(session.worktreePath, session.groupDir ?? session.workingDir)
    }

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

    // Kill existing process if any — remove listeners first to prevent the
    // old process's exit handler from clobbering the new process reference
    // and triggering an unwanted auto-restart cycle.
    if (session.claudeProcess) {
      session.claudeProcess.removeAllListeners()
      session.claudeProcess.stop()
    }

    // Derive a session-scoped token instead of forwarding the master auth token.
    // This limits child process privileges to approve/deny for their own session only.
    const sessionToken = this._authToken
      ? deriveSessionToken(this._authToken, sessionId)
      : ''
    // Both CODEKIN_TOKEN (legacy name, used by older hooks) and CODEKIN_AUTH_TOKEN
    // (current canonical name) are set to the same derived value for backward compatibility.
    const extraEnv: Record<string, string> = {
      CODEKIN_SESSION_ID: sessionId,
      CODEKIN_PORT: String(this._serverPort || PORT),
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
    const registryPatterns = this._approvalManager.getAllowedToolsForRepo(repoDir)
    const mergedAllowedTools = [...new Set([...(session.allowedTools || []), ...registryPatterns])]

    let cp: CodingProcess
    if (session.provider === 'opencode') {
      // Note: addDirs and allowedTools are not passed to OpenCode — it uses
      // its own permission config in .opencode/config.jsonc. The x-opencode-directory
      // header handles per-session working directory routing on the shared server.
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
    this._globalBroadcast?.({ type: 'sessions_updated' })

    const startMsg: WsServerMessage = { type: 'claude_started', sessionId }
    this.addToHistory(session, startMsg)
    this.broadcast(session, startMsg)
    return true
  }

  /**
   * Wait for a session's Claude process to emit its system_init event,
   * indicating it is ready to accept input. Resolves immediately if the
   * session already has a claudeSessionId (process previously initialized).
   * Times out after `timeoutMs` (default 30s) to avoid hanging indefinitely.
   */
  waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
    const session = this.sessions.get(sessionId)
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
   * Extracted from startClaude() to keep that method focused on process setup.
   */
  private wireClaudeEvents(cp: CodingProcess, session: Session, sessionId: string): void {
    cp.on('system_init', (model) => this.onSystemInit(cp, session, model))
    cp.on('text', (text) => this.onTextEvent(session, sessionId, text))
    cp.on('thinking', (summary) => this.onThinkingEvent(session, summary))
    cp.on('tool_output', (content, isError) => this.onToolOutputEvent(session, content, isError))
    cp.on('image', (base64Data, mediaType) => this.onImageEvent(session, base64Data, mediaType))
    cp.on('tool_active', (toolName, toolInput) => this.onToolActiveEvent(session, toolName, toolInput))
    cp.on('tool_done', (toolName, summary) => this.onToolDoneEvent(session, toolName, summary))
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
    cp.on('todo_update', (tasks) => { this.broadcastAndHistory(session, { type: 'todo_update', tasks }) })
    cp.on('prompt', (...args) => this.onPromptEvent(session, ...args))
    cp.on('control_request', (requestId, toolName, toolInput) => this.onControlRequestEvent(cp, session, sessionId, requestId, toolName, toolInput))
    cp.on('result', (result, isError) => {
      session.planManager.onTurnEnd()
      this.handleClaudeResult(session, sessionId, result, isError)
    })
    cp.on('error', (message) => this.broadcast(session, { type: 'error', message }))
    cp.on('exit', (code, signal) => {
      // Capture process diagnostics before removing listeners — these are
      // ClaudeProcess-specific; OpenCodeProcess always returns false/true.
      const sessionConflict = 'hasSessionConflict' in cp && typeof (cp as any).hasSessionConflict === 'function'
        ? (cp as any).hasSessionConflict() as boolean
        : false
      const producedOutput = 'hadOutput' in cp && typeof (cp as any).hadOutput === 'function'
        ? (cp as any).hadOutput() as boolean
        : true
      cp.removeAllListeners()
      this.handleClaudeExit(session, sessionId, code, signal, sessionConflict, producedOutput)
    })
  }

  /** Broadcast a message and add it to the session's output history. */
  private broadcastAndHistory(session: Session, msg: WsServerMessage): void {
    this.addToHistory(session, msg)
    this.broadcast(session, msg)
  }

  /**
   * Wire PlanManager events for a session.
   * Called once at session creation (not per-process, since PlanManager outlives restarts).
   * Idempotent — guards against double-wiring on restore + restart.
   */
  private wirePlanManager(session: Session): void {
    if (session._planManagerWired) return
    session._planManagerWired = true

    const pm = session.planManager

    pm.on('planning_mode', (active) => {
      this.broadcastAndHistory(session, { type: 'planning_mode', active })
    })
  }

  private onSystemInit(cp: CodingProcess, session: Session, model: string): void {
    session.claudeSessionId = cp.getSessionId()
    // Only show model message on first init or when model actually changes
    if (!session._lastReportedModel || session._lastReportedModel !== model) {
      session._lastReportedModel = model
      this.broadcastAndHistory(session, { type: 'system_message', subtype: 'init', text: `Model: ${model}`, model })
    }
  }

  private onTextEvent(session: Session, sessionId: string, text: string): void {
    this.broadcastAndHistory(session, { type: 'output', data: text })
    if (session.name.startsWith('hub:') && !session._namingTimer) {
      this.scheduleSessionNaming(sessionId)
    }
  }

  private onThinkingEvent(session: Session, summary: string): void {
    this.broadcast(session, { type: 'thinking', summary })
  }

  private onToolOutputEvent(session: Session, content: string, isError: boolean): void {
    this.broadcastAndHistory(session, { type: 'tool_output', content, isError })
  }

  private onImageEvent(session: Session, base64: string, mediaType: string): void {
    this.broadcastAndHistory(session, { type: 'image', base64, mediaType })
  }

  private onToolActiveEvent(session: Session, toolName: string, toolInput: string | undefined): void {
    this.broadcastAndHistory(session, { type: 'tool_active', toolName, toolInput })
  }

  private onToolDoneEvent(session: Session, toolName: string, summary: string | undefined): void {
    this.broadcastAndHistory(session, { type: 'tool_done', toolName, summary })
  }

  private onPromptEvent(
    session: Session,
    promptType: 'permission' | 'question',
    question: string,
    options: Array<{ label: string; value: string; description?: string }>,
    multiSelect: boolean | undefined,
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    requestId: string | undefined,
    questions: PromptQuestion[] | undefined,
  ): void {
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

    // Notify prompt listeners (orchestrator, child monitor, etc.)
    for (const listener of this._promptListeners) {
      try { listener(session.id, promptType, toolName, requestId) } catch { /* listener error */ }
    }
  }

  private onControlRequestEvent(
    cp: CodingProcess,
    session: Session,
    sessionId: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    if (typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId)) {
      console.warn(`[control_request] Rejected invalid requestId: ${JSON.stringify(requestId)}`)
      return
    }
    console.log(`[control_request] session=${sessionId} tool=${toolName} requestId=${requestId}`)

    if (this.resolveAutoApproval(session, toolName, toolInput) !== 'prompt') {
      console.log(`[control_request] auto-approved: ${toolName}`)
      cp.sendControlResponse(requestId, 'allow')
      return
    }

    // Prevent double-gating: if a PreToolUse hook is already handling approval
    // for this tool, auto-approve the control_request to avoid duplicate entries.
    // Without this, both pendingToolApprovals and pendingControlRequests contain
    // entries for the same tool invocation, causing stale-entry races when the
    // orchestrator tries to respond via the REST API.
    for (const pending of session.pendingToolApprovals.values()) {
      if (pending.toolName === toolName) {
        console.log(`[control_request] auto-approving ${toolName} (PreToolUse hook already handling approval)`)
        cp.sendControlResponse(requestId, 'allow')
        return
      }
    }

    const question = this.summarizeToolPermission(toolName, toolInput)
    const neverAutoApprove = ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)
    const options = [
      { label: 'Allow', value: 'allow' },
      ...(!neverAutoApprove ? [{ label: 'Always Allow', value: 'always_allow' }] : []),
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
      console.log(`[control_request] no clients connected, waiting for client to join: ${toolName}`)
      this._globalBroadcast?.({
        ...promptMsg,
        sessionId,
        sessionName: session.name,
      })
    }

    // Notify prompt listeners (orchestrator, child monitor, etc.)
    for (const listener of this._promptListeners) {
      try { listener(sessionId, 'permission', toolName, requestId) } catch { /* listener error */ }
    }
  }

  /**
   * Handle a Claude process 'result' event: update session state, apply API
   * retry logic for transient errors, broadcast result to clients, and trigger
   * session naming on first completed turn.
   */
  private handleClaudeResult(session: Session, sessionId: string, result: string, isError: boolean): void {
    session.isProcessing = false
    session._claudeTurnCount++
    this._globalBroadcast?.({ type: 'sessions_updated' })

    // Attempt API retry for transient errors — returns true if a retry was scheduled
    if (isError && this.handleApiRetry(session, sessionId, result)) {
      return
    }

    // Warn about context window pressure at turn thresholds
    this.checkContextWarning(session)

    this.finalizeResult(session, sessionId, result, isError)
  }

  /**
   * Emit a notification when the session has had enough turns that Claude's
   * context window may start compressing older messages. Uses simple turn-count
   * heuristic — imprecise but zero-risk and protocol-independent.
   */
  private checkContextWarning(session: Session): void {
    const turns = session._claudeTurnCount

    if (turns === CONTEXT_WARNING_TURN_THRESHOLD) {
      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'notification',
        text: `This session has ${turns} turns. Claude may begin compressing older messages from its context window. Earlier parts of the conversation may no longer be fully available to Claude.`,
      }
      this.broadcastAndHistory(session, msg)
      session._contextWarningShown = true
    } else if (turns === CONTEXT_CRITICAL_TURN_THRESHOLD) {
      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'notification',
        text: `This session has ${turns} turns. Claude's context window is likely under pressure — older messages may have been compressed or dropped. Consider starting a new session for best results.`,
      }
      this.broadcastAndHistory(session, msg)
    }
  }

  /**
   * Detect transient API errors and schedule an automatic retry.
   * Returns true if a retry was scheduled (caller should skip result broadcast).
   */
  private handleApiRetry(session: Session, sessionId: string, result: string): boolean {
    if (!session._lastUserInput || !this.isRetryableApiError(result)) {
      session._apiRetryCount = 0
      return false
    }

    // Skip retry if the original input is older than 60 seconds — context has likely moved on
    if (session._lastUserInputAt && Date.now() - session._lastUserInputAt > 60_000) {
      console.log(`[api-retry] skipping stale retry for session=${sessionId} (input age=${Math.round((Date.now() - session._lastUserInputAt) / 1000)}s)`)
      session._apiRetryCount = 0
      return false
    }

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

      if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
      session._apiRetryTimer = setTimeout(() => {
        session._apiRetryTimer = undefined
        if (!session.claudeProcess?.isAlive() || session._stoppedByUser) return
        console.log(`[api-retry] resending message for session=${sessionId} attempt=${attempt}`)
        session.claudeProcess.sendMessage(session._lastUserInput!)
      }, delay)
      return true
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
    return false
  }

  /**
   * Broadcast the turn result, suppress orchestrator noise, notify listeners,
   * and trigger session naming if needed.
   */
  private finalizeResult(session: Session, sessionId: string, result: string, isError: boolean): void {
    session._apiRetryCount = 0
    session._lastUserInput = undefined
    session._lastUserInputAt = undefined

    if (isError) {
      const msg: WsServerMessage = { type: 'system_message', subtype: 'error', text: result }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
    }

    // Suppress noise from orchestrator/agent sessions
    if ((session.source === 'orchestrator' || session.source === 'agent') && !isError) {
      const turnText = this.extractCurrentTurnText(session)
      if (turnText && turnText.length < 80 && /^(no response requested|please approve|nothing to do|no action needed|acknowledged)[.!]?$/i.test(turnText.trim())) {
        this.stripCurrentTurnOutput(session)
        console.log(`[noise-filter] suppressed orchestrator noise: "${turnText.trim().slice(0, 60)}"`)
      }
    }

    const resultMsg: WsServerMessage = { type: 'result' }
    this.addToHistory(session, resultMsg)
    this.broadcast(session, resultMsg)

    for (const listener of this._resultListeners) {
      try { listener(sessionId, isError) } catch { /* listener error */ }
    }

    // If session is still unnamed after first response, name it now
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
   *
   * Uses evaluateRestart() for the restart decision, keeping this method focused
   * on state updates, listener notification, and message broadcasting.
   */
  private handleClaudeExit(session: Session, sessionId: string, code: number | null, signal: string | null, sessionConflict: boolean, producedOutput: boolean): void {
    session.claudeProcess = null
    session.isProcessing = false
    session.planManager.reset()
    this._globalBroadcast?.({ type: 'sessions_updated' })

    // If the process exited without ever producing stdout output, --resume
    // hung on a broken/stale session. Clear claudeSessionId so the next
    // restart attempt uses a fresh session instead of retrying the same
    // broken resume — which would just hang again.
    if (!producedOutput && session.claudeSessionId) {
      console.warn(`[restart] Session ${sessionId} produced no output before exit — clearing claudeSessionId to force fresh session`)
      session.claudeSessionId = null
    }

    const action = evaluateRestart({
      restartCount: session.restartCount,
      lastRestartAt: session.lastRestartAt,
      stoppedByUser: session._stoppedByUser || sessionConflict,
    })

    if (action.kind === 'stopped_by_user') {
      for (const listener of this._exitListeners) {
        try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
      }
      const text = sessionConflict
        ? 'Claude process exited: session ID is already in use by another process. Please restart manually.'
        : `Claude process exited: code=${code}, signal=${signal}`
      const msg: WsServerMessage = { type: 'system_message', subtype: 'exit', text }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)
      this.broadcast(session, { type: 'exit', code: code ?? -1, signal })
      return
    }

    if (action.kind === 'restart') {
      session.restartCount = action.updatedCount
      session.lastRestartAt = action.updatedLastRestartAt

      for (const listener of this._exitListeners) {
        try { listener(sessionId, code, signal, true) } catch { /* listener error */ }
      }

      const msg: WsServerMessage = {
        type: 'system_message',
        subtype: 'restart',
        text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Restarting (attempt ${action.attempt}/${action.maxAttempts})...`,
      }
      this.addToHistory(session, msg)
      this.broadcast(session, msg)

      setTimeout(() => {
        // Verify session still exists and hasn't been stopped
        if (!this.sessions.has(sessionId) || session._stoppedByUser) return
        // startClaude uses --resume when claudeSessionId exists, so the CLI
        // picks up the full conversation history from the JSONL automatically.
        this.startClaude(sessionId)

        // Fallback: if claudeSessionId was already null (fresh session that
        // crashed before system_init), inject a context summary so the new
        // session has some awareness of prior conversation.
        if (!session.claudeSessionId && session.claudeProcess && session.outputHistory.length > 0) {
          session.claudeProcess.once('system_init', () => {
            const context = this.buildSessionContext(session)
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
    for (const listener of this._exitListeners) {
      try { listener(sessionId, code, signal, false) } catch { /* listener error */ }
    }
    const msg: WsServerMessage = {
      type: 'system_message',
      subtype: 'error',
      text: `Claude process exited unexpectedly (code=${code}, signal=${signal}). Auto-restart disabled after ${action.maxAttempts} attempts. Please restart manually.`,
    }
    this.addToHistory(session, msg)
    this.broadcast(session, msg)
    this.broadcast(session, { type: 'exit', code: code ?? -1, signal })
  }

  /**
   * Send user input to a session's Claude process.
   * Auto-starts Claude if not running, with session context for continuity.
   */
  sendInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session._lastActivityAt = Date.now()
    // Reset stopped-by-user flag so idle-reaped sessions can auto-start
    session._stoppedByUser = false

    if (!session.claudeProcess?.isAlive()) {
      // Claude not running (e.g. after server restart or idle reap) — auto-start first.
      // Claude CLI in -p mode waits for first input before emitting init,
      // so we write directly to the stdin pipe buffer (no waiting for init).
      // OpenCode requires waiting for system_init before sending because it uses
      // HTTP (no pipe buffer), so we await waitForReady() for OpenCode sessions.
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
          session._lastUserInputAt = Date.now()
          session._apiRetryCount = 0
          if (!session.isProcessing) {
            session.isProcessing = true
            this._globalBroadcast?.({ type: 'sessions_updated' })
          }
          if (session.claudeProcess && !session.claudeProcess.isReady()) {
            void this.waitForReady(sessionId).then(() => session.claudeProcess?.sendMessage(combined))
          } else {
            session.claudeProcess?.sendMessage(combined)
          }
          return
        }
      }

      // Process just started — if not ready yet (OpenCode needs server init),
      // queue the message via waitForReady.
      if (session.claudeProcess && !session.claudeProcess.isReady()) {
        session._lastUserInput = data
        session._lastUserInputAt = Date.now()
        session._apiRetryCount = 0
        if (!session.isProcessing) {
          session.isProcessing = true
          this._globalBroadcast?.({ type: 'sessions_updated' })
        }
        void this.waitForReady(sessionId).then(() => session.claudeProcess?.sendMessage(data))
        return
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
    session._lastUserInputAt = Date.now()
    session._apiRetryCount = 0
    if (!session.isProcessing) {
      session.isProcessing = true
      this._globalBroadcast?.({ type: 'sessions_updated' })
    }
    // If the process is alive but still initializing (OpenCode after restart),
    // route through waitForReady to avoid sending before the server is up.
    if (session.claudeProcess && !session.claudeProcess.isReady()) {
      void this.waitForReady(sessionId).then(() => session.claudeProcess?.sendMessage(data))
    } else {
      session.claudeProcess?.sendMessage(data)
    }
  }

  /**
   * Route a user's prompt response to the correct handler: pending tool approval
   * (from PermissionRequest hook), pending control request (from control_request
   * fallback path), or plain message fallback.
   */
  sendPromptResponse(sessionId: string, value: string | string[], requestId?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session._lastActivityAt = Date.now()

    // ExitPlanMode approvals are handled through the normal pendingToolApprovals
    // path (routed via the PreToolUse hook). No special plan_review_ prefix needed.

    // Check for pending tool approval from PreToolUse hook
    if (!requestId) {
      const totalPending = session.pendingToolApprovals.size + session.pendingControlRequests.size
      if (totalPending === 1) {
        // Exactly one pending prompt — safe to infer the target
        const soleApproval = session.pendingToolApprovals.size === 1
          ? session.pendingToolApprovals.values().next().value
          : undefined
        if (soleApproval) {
          console.warn(`[prompt_response] no requestId, routing to sole pending tool approval: ${soleApproval.toolName}`)
          this.resolveToolApproval(session, soleApproval, value)
          return
        }
        const soleControl = session.pendingControlRequests.size === 1
          ? session.pendingControlRequests.values().next().value
          : undefined
        if (soleControl) {
          console.warn(`[prompt_response] no requestId, routing to sole pending control request: ${soleControl.toolName}`)
          requestId = soleControl.requestId
        }
      } else if (totalPending > 1) {
        console.warn(`[prompt_response] no requestId with ${totalPending} pending prompts — rejecting to prevent misrouted response`)
        this.broadcast(session, {
          type: 'system_message',
          subtype: 'error',
          text: 'Prompt response could not be routed: multiple prompts pending. Please refresh and try again.',
        })
        return
      } else {
        console.warn(`[prompt_response] no requestId, no pending prompts — forwarding as user message`)
      }
    }
    const approval = requestId ? session.pendingToolApprovals.get(requestId) : undefined
    if (approval) {
      this.resolveToolApproval(session, approval, value)
      return
    }

    if (!session.claudeProcess?.isAlive()) return

    // Find matching pending control request
    const pending = requestId ? session.pendingControlRequests.get(requestId) : undefined

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
    approval: { resolve: (r: { allow: boolean; always: boolean; answer?: string }) => void; toolName: string; toolInput: Record<string, unknown>; requestId: string },
    value: string | string[],
  ): void {
    // AskUserQuestion: the value IS the user's answer, not a permission decision
    if (approval.toolName === 'AskUserQuestion') {
      const answer = Array.isArray(value) ? value.join(', ') : value
      console.log(`[tool-approval] resolving AskUserQuestion: answer=${answer.slice(0, 100)}`)
      approval.resolve({ allow: true, always: false, answer })
      session.pendingToolApprovals.delete(approval.requestId)
      this.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
      return
    }

    // ExitPlanMode: route through PlanManager for state tracking.
    // The hook will convert allow→deny-with-approval-message (CLI workaround).
    if (approval.toolName === 'ExitPlanMode') {
      const first = Array.isArray(value) ? value[0] : value
      const isDeny = first === 'deny'
      if (isDeny) {
        // Extract feedback text if present (value may be ['deny', 'feedback text'])
        const feedback = Array.isArray(value) && value.length > 1 ? value[1] : undefined
        const reason = session.planManager.deny(approval.requestId, feedback)
        console.log(`[plan-approval] denied: ${reason}`)
        approval.resolve({ allow: false, always: false, answer: reason || undefined })
      } else {
        session.planManager.approve(approval.requestId)
        console.log(`[plan-approval] approved`)
        approval.resolve({ allow: true, always: false })
      }
      session.pendingToolApprovals.delete(approval.requestId)
      this.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
      return
    }

    const { isDeny, isAlwaysAllow, isApprovePattern } = this.decodeApprovalValue(value)

    if (isAlwaysAllow && !isDeny) {
      this._approvalManager.saveAlwaysAllow(session.groupDir ?? session.workingDir, approval.toolName, approval.toolInput)
    }
    if (isApprovePattern && !isDeny) {
      this._approvalManager.savePatternApproval(session.groupDir ?? session.workingDir, approval.toolName, approval.toolInput)
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
      this._approvalManager.saveAlwaysAllow(session.groupDir ?? session.workingDir, pending.toolName, pending.toolInput)
    }
    if (isApprovePattern) {
      this._approvalManager.savePatternApproval(session.groupDir ?? session.workingDir, pending.toolName, pending.toolInput)
    }

    const behavior = isDeny ? 'deny' : 'allow'
    session.claudeProcess!.sendControlResponse(pending.requestId, behavior)
  }

  /**
   * Called by the PermissionRequest hook HTTP endpoint. Sends a prompt to clients
   * and returns a Promise that resolves when the user approves/denies.
   */
  requestToolApproval(sessionId: string, toolName: string, toolInput: Record<string, unknown>): Promise<{ allow: boolean; always: boolean; answer?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[tool-approval] session not found: ${sessionId}`)
      return Promise.resolve({ allow: false, always: false })
    }

    const autoResult = this.resolveAutoApproval(session, toolName, toolInput)
    if (autoResult === 'registry') {
      console.log(`[tool-approval] auto-approved (registry): ${toolName}`)
      return Promise.resolve({ allow: true, always: true })
    }
    if (autoResult === 'session') {
      console.log(`[tool-approval] auto-approved (session allowedTools): ${toolName}`)
      return Promise.resolve({ allow: true, always: false })
    }
    if (autoResult === 'headless') {
      console.log(`[tool-approval] auto-approved (headless ${session.source}): ${toolName}`)
      return Promise.resolve({ allow: true, always: false })
    }

    console.log(`[tool-approval] requesting approval: session=${sessionId} tool=${toolName} clients=${session.clients.size}`)

    // ExitPlanMode: route through PlanManager state machine for plan-specific
    // approval UI. The hook blocks until we resolve the promise.
    if (toolName === 'ExitPlanMode') {
      return this.handleExitPlanModeApproval(session, sessionId)
    }

    // Prevent double-gating: if a control_request already created a pending
    // entry for this tool, auto-approve the control_request and let the hook
    // take over as the sole approval gate.  This is the reverse of the check
    // in onControlRequestEvent (which handles hook-first ordering).
    for (const [reqId, pending] of session.pendingControlRequests) {
      if (pending.toolName === toolName) {
        console.log(`[tool-approval] auto-approving control_request for ${toolName} (PreToolUse hook taking over)`)
        session.claudeProcess?.sendControlResponse(reqId, 'allow')
        session.pendingControlRequests.delete(reqId)
        this.broadcast(session, { type: 'prompt_dismiss', requestId: reqId })
        break
      }
    }

    // AskUserQuestion: show a question prompt and collect the answer text,
    // rather than a permission prompt with Allow/Deny buttons.
    const isQuestion = toolName === 'AskUserQuestion'

    return new Promise<{ allow: boolean; always: boolean; answer?: string }>((resolve) => {
      // Holder lets wrappedResolve reference the timeout before it's assigned
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }

      const wrappedResolve = (result: { allow: boolean; always: boolean; answer?: string }) => {
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
      }, 300_000) // 5 min for all approval types — prevents premature auto-deny when user is reading or tabbed away

      let promptMsg: WsServerMessage
      if (isQuestion) {
        // AskUserQuestion: extract structured questions from toolInput.questions
        // and pass them through so PromptButtons can render the multi-question flow.
        const rawQuestions = toolInput.questions as Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean; header?: string }> | undefined
        const structuredQuestions = Array.isArray(rawQuestions)
          ? rawQuestions.map(q => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect ?? false,
            options: (q.options || []).map((opt: { label: string; value?: string; description?: string }) => ({
              label: opt.label,
              value: opt.value ?? opt.label,
              description: opt.description,
            })),
          }))
          : undefined
        const firstQ = structuredQuestions?.[0]
        promptMsg = {
          type: 'prompt',
          promptType: 'question',
          question: firstQ?.question || 'Answer the question',
          options: firstQ?.options || [],
          multiSelect: firstQ?.multiSelect,
          toolName,
          toolInput,
          requestId: approvalRequestId,
          ...(structuredQuestions ? { questions: structuredQuestions } : {}),
        }
      } else {
        const question = this.summarizeToolPermission(toolName, toolInput)
        const approvePattern = this._approvalManager.derivePattern(toolName, toolInput)
        const neverAutoApprove = ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)
        const options = [
          { label: 'Allow', value: 'allow' },
          ...(!neverAutoApprove ? [{ label: 'Always Allow', value: 'always_allow' }] : []),
          { label: 'Deny', value: 'deny' },
        ]
        promptMsg = {
          type: 'prompt',
          promptType: 'permission',
          question,
          options,
          toolName,
          toolInput,
          requestId: approvalRequestId,
          ...(approvePattern ? { approvePattern } : {}),
        }
      }

      session.pendingToolApprovals.set(approvalRequestId, { resolve: wrappedResolve, toolName, toolInput, requestId: approvalRequestId, promptMsg })

      if (session.clients.size > 0) {
        this.broadcast(session, promptMsg)
      } else {
        // No clients connected — DON'T auto-deny. Instead, wait for a client
        // to join this session (the prompt will be re-broadcast in join()).
        // Send a global notification so the user sees a waiting indicator.
        console.log(`[tool-approval] no clients connected, waiting for client to join (timeout 300s): ${toolName}`)
        this._globalBroadcast?.({
          ...promptMsg,
          sessionId,
          sessionName: session.name,
        })
      }

      // Notify prompt listeners (orchestrator, child monitor, etc.)
      for (const listener of this._promptListeners) {
        try { listener(sessionId, isQuestion ? 'question' : 'permission', toolName, approvalRequestId) } catch { /* listener error */ }
      }
    })
  }

  /**
   * Handle ExitPlanMode approval through PlanManager.
   * Shows a plan-specific approval prompt (Approve/Reject) and blocks the hook
   * until the user responds. On approve, returns allow:true (the hook will use
   * the deny-with-approval-message workaround). On deny, returns allow:false.
   */
  private handleExitPlanModeApproval(session: Session, sessionId: string): Promise<{ allow: boolean; always: boolean; answer?: string }> {
    const reviewId = session.planManager.onExitPlanModeRequested()
    if (!reviewId) {
      // Not in planning state — fall through to allow (CLI handles natively)
      console.log(`[plan-approval] ExitPlanMode but PlanManager not in planning state, allowing`)
      return Promise.resolve({ allow: true, always: false })
    }

    return new Promise<{ allow: boolean; always: boolean; answer?: string }>((resolve) => {
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }

      const wrappedResolve = (result: { allow: boolean; always: boolean; answer?: string }) => {
        if (timer.id) clearTimeout(timer.id)
        resolve(result)
      }

      // Timeout: auto-deny after 5 minutes to prevent leaked promises
      timer.id = setTimeout(() => {
        if (session.pendingToolApprovals.has(reviewId)) {
          console.log(`[plan-approval] timed out, auto-denying`)
          session.pendingToolApprovals.delete(reviewId)
          session.planManager.deny(reviewId)
          this.broadcast(session, { type: 'prompt_dismiss', requestId: reviewId })
          resolve({ allow: false, always: false })
        }
      }, 300_000)

      const promptMsg: WsServerMessage = {
        type: 'prompt',
        promptType: 'permission',
        question: 'Approve plan and start implementation?',
        options: [
          { label: 'Approve', value: 'allow' },
          { label: 'Reject', value: 'deny' },
        ],
        toolName: 'ExitPlanMode',
        requestId: reviewId,
      }

      session.pendingToolApprovals.set(reviewId, {
        resolve: wrappedResolve,
        toolName: 'ExitPlanMode',
        toolInput: {},
        requestId: reviewId,
        promptMsg,
      })

      this.broadcast(session, promptMsg)

      if (session.clients.size === 0) {
        this._globalBroadcast?.({ ...promptMsg, sessionId, sessionName: session.name })
      }

      for (const listener of this._promptListeners) {
        try { listener(sessionId, 'permission', 'ExitPlanMode', reviewId) } catch { /* listener error */ }
      }
    })
  }

  /**
   * Check if a tool invocation can be auto-approved without prompting the user.
   * Returns 'registry' if matched by auto-approval rules, 'session' if matched
   * by the session's allowedTools list, 'headless' if the session has no clients
   * and is a non-interactive source, or 'prompt' if the user needs to decide.
   */
  private resolveAutoApproval(session: Session, toolName: string, toolInput: Record<string, unknown>): 'registry' | 'session' | 'headless' | 'prompt' {
    if (this._approvalManager.checkAutoApproval(session.groupDir ?? session.workingDir, toolName, toolInput)) {
      return 'registry'
    }
    if (session.allowedTools && this.matchesAllowedTools(session.allowedTools, toolName, toolInput)) {
      return 'session'
    }
    if (session.clients.size === 0 && (session.source === 'webhook' || session.source === 'workflow' || session.source === 'stepflow' || session.source === 'orchestrator')) {
      return 'headless'
    }
    return 'prompt'
  }

  /**
   * Check if a tool invocation matches any of the session's allowedTools patterns.
   * Patterns follow Claude CLI format: 'ToolName' or 'ToolName(prefix:*)'.
   * Examples: 'WebFetch', 'Bash(curl:*)', 'Bash(git:*)'.
   */
  private matchesAllowedTools(allowedTools: string[], toolName: string, toolInput: Record<string, unknown>): boolean {
    for (const pattern of allowedTools) {
      // Simple tool name match: 'WebFetch', 'Read', etc.
      if (pattern === toolName) return true

      // Parameterized match: 'Bash(curl:*)' → toolName=Bash, command starts with 'curl'
      const match = pattern.match(/^(\w+)\(([^:]+):\*\)$/)
      if (match) {
        const [, patternTool, prefix] = match
        if (patternTool !== toolName) continue
        // For Bash, check command prefix
        if (toolName === 'Bash') {
          const cmd = String(toolInput.command || '').trimStart()
          if (cmd === prefix || cmd.startsWith(prefix + ' ')) return true
        }
      }
    }
    return false
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
      default:
        return `Allow ${toolName}?`
    }
  }

  /** Update the model for a session and restart Claude with the new model. */
  getSessionProvider(sessionId: string): string {
    return this.sessions.get(sessionId)?.provider ?? 'claude'
  }

  /** Update the provider for a session and restart with the new provider process. */
  setProvider(sessionId: string, provider: CodingProvider): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.provider === provider) return true
    session.provider = provider
    // Clear the provider-specific session ID since it won't be valid across providers
    session.claudeSessionId = null
    this.persistToDiskDebounced()
    // Restart with new provider if running
    if (session.claudeProcess?.isAlive()) {
      this.stopClaude(sessionId)
      session._stoppedByUser = false
      setTimeout(() => {
        if (this.sessions.has(sessionId) && !session._stoppedByUser) {
          this.startClaude(sessionId)
        }
      }, 500)
    }
    return true
  }

  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.model = model || undefined
    this.persistToDiskDebounced()
    // Restart Claude with the new model if it's running
    if (session.claudeProcess?.isAlive()) {
      this.stopClaude(sessionId)
      session._stoppedByUser = false
      setTimeout(() => {
        if (this.sessions.has(sessionId) && !session._stoppedByUser) {
          this.startClaude(sessionId)
        }
      }, 500)
    }
    return true
  }

  /** Update the permission mode for a session and restart Claude with the new mode. */
  setPermissionMode(sessionId: string, permissionMode: import('./types.js').PermissionMode): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const previousMode = session.permissionMode
    session.permissionMode = permissionMode
    this.persistToDiskDebounced()

    // Audit log for dangerous mode changes
    if (permissionMode === 'bypassPermissions') {
      console.warn(`[security] Session ${sessionId} ("${session.name}") activated bypassPermissions mode (was: ${previousMode ?? 'default'})`)
    }

    // Emit a visible system message so all clients see the mode change
    const modeLabel = permissionMode === 'bypassPermissions' ? 'Bypass permissions (all tools auto-accepted)' : permissionMode
    const sysMsg: WsServerMessage = { type: 'system_message', subtype: 'notification', text: `Permission mode changed to: ${modeLabel}` }
    this.addToHistory(session, sysMsg)
    this.broadcast(session, sysMsg)

    // Restart Claude with the new permission mode if it's running
    if (session.claudeProcess?.isAlive()) {
      this.stopClaude(sessionId)
      session._stoppedByUser = false
      setTimeout(() => {
        if (this.sessions.has(sessionId) && !session._stoppedByUser) {
          this.startClaude(sessionId)
        }
      }, 500)
    }
    return true
  }

  stopClaude(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.claudeProcess) {
      session._stoppedByUser = true
      if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
      session.claudeProcess.removeAllListeners()
      session.claudeProcess.stop()
      session.claudeProcess = null
      this.broadcast(session, { type: 'claude_stopped' })
    }
  }

  /**
   * Stop the Claude process and wait for it to fully exit before resolving.
   * This prevents race conditions when restarting with the same session ID
   * (e.g. during mid-session worktree migration).
   */
  async stopClaudeAndWait(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.claudeProcess) return

    const cp = session.claudeProcess
    session._stoppedByUser = true
    if (session._apiRetryTimer) clearTimeout(session._apiRetryTimer)
    cp.removeAllListeners()
    cp.stop()
    session.claudeProcess = null
    this.broadcast(session, { type: 'claude_stopped' })

    // Wait for the underlying OS process to fully exit
    await cp.waitForExit()
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check if an error result text matches a transient API error worth retrying. */
  private isRetryableApiError(text: string): boolean {
    return API_RETRY_PATTERNS.some((pattern) => pattern.test(text))
  }

  /** Extract the concatenated text output from the current turn (after the last 'result' in history). */
  private extractCurrentTurnText(session: Session): string {
    let text = ''
    for (let i = session.outputHistory.length - 1; i >= 0; i--) {
      const msg = session.outputHistory[i]
      if (msg.type === 'result') break
      if (msg.type === 'output') text = msg.data + text
    }
    return text
  }

  /** Remove output messages from the current turn in history (after the last 'result'). */
  private stripCurrentTurnOutput(session: Session): void {
    let cutIndex = session.outputHistory.length
    for (let i = session.outputHistory.length - 1; i >= 0; i--) {
      const msg = session.outputHistory[i]
      if (msg.type === 'result') break
      if (msg.type === 'output') {
        cutIndex = i
      }
    }
    // Remove output entries from cutIndex onwards (keep non-output entries like tool events)
    session.outputHistory = session.outputHistory.filter((msg, idx) => idx < cutIndex || msg.type !== 'output')
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

  /** Max size of a single output chunk in the history buffer. */
  private static readonly MAX_OUTPUT_CHUNK = 50_000 // 50KB

  /**
   * Append a message to a session's output history for replay.
   * Merges consecutive 'output' chunks up to MAX_OUTPUT_CHUNK to save space,
   * and splits oversized outputs into multiple entries to bound replay cost.
   */
  addToHistory(session: Session, msg: WsServerMessage): void {
    if (msg.type === 'output') {
      const last = session.outputHistory[session.outputHistory.length - 1]
      if (last?.type === 'output' && (last as { type: 'output'; data: string }).data.length < SessionManager.MAX_OUTPUT_CHUNK) {
        (last as { type: 'output'; data: string }).data += msg.data
        this.persistToDiskDebounced()
        return
      }
      // Split oversized output into bounded chunks
      if (msg.data.length > SessionManager.MAX_OUTPUT_CHUNK) {
        for (let i = 0; i < msg.data.length; i += SessionManager.MAX_OUTPUT_CHUNK) {
          session.outputHistory.push({ type: 'output', data: msg.data.slice(i, i + SessionManager.MAX_OUTPUT_CHUNK) })
        }
        if (session.outputHistory.length > MAX_HISTORY) {
          session.outputHistory.splice(0, session.outputHistory.length - MAX_HISTORY)
        }
        this.persistToDiskDebounced()
        return
      }
    }
    session.outputHistory.push(msg)
    if (session.outputHistory.length > MAX_HISTORY) {
      session.outputHistory.splice(0, session.outputHistory.length - MAX_HISTORY)
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

  /** Find which session a WebSocket is connected to (O(1) via reverse map). */
  findSessionForClient(ws: WebSocket): Session | undefined {
    const sessionId = this.clientSessionMap.get(ws)
    if (sessionId) return this.sessions.get(sessionId)
    return undefined
  }

  /**
   * Remove a client from all sessions (iterates for safety since a ws
   * could theoretically appear in multiple session client sets).
   */
  removeClient(ws: WebSocket): void {
    for (const session of this.sessions.values()) {
      session.clients.delete(ws)
    }
    this.clientSessionMap.delete(ws)
  }

  // ---------------------------------------------------------------------------
  // Diff viewer — delegates to DiffManager
  // ---------------------------------------------------------------------------

  /** Run git diff in a session's workingDir and return structured results. */
  async getDiff(sessionId: string, scope: DiffScope = 'all'): Promise<WsServerMessage> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: 'diff_error', message: 'Session not found' }
    return this.diffManager.getDiff(session.workingDir, scope)
  }

  /** Discard changes in a session's workingDir per the given scope and paths. */
  async discardChanges(
    sessionId: string,
    scope: DiffScope,
    paths?: string[],
    statuses?: Record<string, DiffFileStatus>,
  ): Promise<WsServerMessage> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: 'diff_error', message: 'Session not found' }
    return this.diffManager.discardChanges(session.workingDir, scope, paths, statuses)
  }

  /** Graceful shutdown: complete in-progress tasks, persist state, kill all processes.
   *  Returns a promise that resolves once all Claude processes have exited. */
  shutdown(): Promise<void> {
    if (this._idleReaperInterval) {
      clearInterval(this._idleReaperInterval)
      this._idleReaperInterval = null
    }
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
    this._approvalManager.persistRepoApprovals()

    // Kill all Claude child processes and wait for them to exit so their
    // session locks are released before the next server start.
    const exitPromises: Promise<void>[] = []
    for (const session of this.sessions.values()) {
      if (session.claudeProcess?.isAlive()) {
        exitPromises.push(new Promise<void>((resolve) => {
          session.claudeProcess!.once('exit', () => resolve())
          session.claudeProcess!.stop()
        }))
      }
    }

    this.archive.shutdown()

    if (exitPromises.length === 0) return Promise.resolve()

    // Wait for all processes to exit, but cap at 6s (stop() SIGKILL is at 5s)
    return Promise.race([
      Promise.all(exitPromises).then(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 6000)),
    ])
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
      if (session._wasActiveBeforeRestart && session.claudeSessionId && session.source !== 'webhook') {
        toRestore.push(session)
      }
    }

    if (toRestore.length === 0) return
    console.log(`Auto-restoring ${toRestore.length} previously active session(s)...`)

    toRestore.forEach((session, i) => {
      // Stagger starts by 1 second each to avoid overwhelming the system
      setTimeout(() => {
        if (session.claudeProcess?.isAlive()) return // already running

        // startClaude uses --resume when claudeSessionId exists (which it always
        // does here — the restore loop filters on it), so Claude CLI picks up
        // the full conversation history from its JSONL automatically.
        console.log(`[restore] Starting Claude for session ${session.id} (${session.name}) (claudeSessionId=${session.claudeSessionId})`)
        this.startClaude(session.id)

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
