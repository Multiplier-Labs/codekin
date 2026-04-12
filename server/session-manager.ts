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
 * - SessionLifecycle: Claude process start/stop/restart and event wiring
 * - evaluateRestart: pure restart-decision logic (used by SessionLifecycle)
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { promisify } from 'util'
import type { WebSocket } from 'ws'
import type { CodingProcess, CodingProvider } from './coding-process.js'
import { PlanManager } from './plan-manager.js'
import { SessionArchive } from './session-archive.js'
import type { DiffFileStatus, DiffScope, Session, SessionInfo, TaskItem, WsServerMessage } from './types.js'
import { cleanupWorkspace } from './webhook-workspace.js'
import { PORT } from './config.js'
import { ApprovalManager } from './approval-manager.js'
import { PromptRouter } from './prompt-router.js'
import { SessionLifecycle } from './session-lifecycle.js'
import { SessionNaming } from './session-naming.js'
import { SessionPersistence } from './session-persistence.js'
import { cleanGitEnv, DiffManager } from './diff-manager.js'

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
  /\b529\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
]

/** Sources that represent headless (non-interactive) sessions managed by their own lifecycles. */
const HEADLESS_SOURCES = new Set(['webhook', 'workflow', 'stepflow', 'agent', 'orchestrator'])

/** Check whether a session is headless (webhook, workflow, stepflow, agent, orchestrator). */
function isHeadlessSession(session: { source?: string }): boolean {
  return HEADLESS_SOURCES.has(session.source ?? '')
}

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
  /** Delegated prompt routing and tool approval logic. */
  private promptRouter: PromptRouter
  /** Delegated Claude process lifecycle (start, stop, restart, event wiring). */
  private sessionLifecycle: SessionLifecycle
  /** Interval handle for the idle session reaper. */
  private _idleReaperInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.archive = new SessionArchive()
    this._approvalManager = new ApprovalManager()
    this.diffManager = new DiffManager()
    this.promptRouter = new PromptRouter({
      getSession: (id) => this.sessions.get(id),
      allSessions: () => this.sessions.values(),
      broadcast: (session, msg) => this.broadcast(session, msg),
      addToHistory: (session, msg) => this.addToHistory(session, msg),
      globalBroadcast: (msg) => this._globalBroadcast?.(msg),
      approvalManager: this._approvalManager,
      promptListeners: this._promptListeners,
    })
    // Use a local ref so the getter closures capture `this` (the SessionManager instance)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    this.sessionLifecycle = new SessionLifecycle({
      getSession: (id) => this.sessions.get(id),
      hasSession: (id) => this.sessions.has(id),
      broadcast: (session, msg) => this.broadcast(session, msg),
      addToHistory: (session, msg) => this.addToHistory(session, msg),
      broadcastAndHistory: (session, msg) => this.broadcastAndHistory(session, msg),
      persistToDisk: () => this.persistToDisk(),
      get globalBroadcast() { return self._globalBroadcast },
      get authToken() { return self._authToken },
      get serverPort() { return self._serverPort },
      approvalManager: this._approvalManager,
      promptRouter: this.promptRouter,
      exitListeners: this._exitListeners,
      onSystemInit: (cp, session, model) => this.onSystemInit(cp, session, model),
      onTextEvent: (session, sessionId, text) => this.onTextEvent(session, sessionId, text),
      onThinkingEvent: (session, summary) => this.onThinkingEvent(session, summary),
      onToolOutputEvent: (session, content, isError) => this.onToolOutputEvent(session, content, isError),
      onImageEvent: (session, base64, mediaType) => this.onImageEvent(session, base64, mediaType),
      onToolActiveEvent: (session, toolName, toolInput) => this.onToolActiveEvent(session, toolName, toolInput),
      onToolDoneEvent: (session, toolName, summary) => this.onToolDoneEvent(session, toolName, summary),
      handleClaudeResult: (session, sessionId, result, isError) => this.handleClaudeResult(session, sessionId, result, isError),
      buildSessionContext: (session) => this.buildSessionContext(session),
    })
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
      if (isHeadlessSession(session)) continue
      // Skip sessions with connected clients or no running process
      if (session.clients.size > 0 || !session.claudeProcess?.isAlive()) continue
      // Skip sessions that are actively processing
      if (session.isProcessing) continue

      const idleMs = now - session._lastActivityAt
      if (idleMs > IDLE_SESSION_TIMEOUT_MS) {
        console.log(`[idle-reaper] stopping idle session=${session.id} name="${session.name}" idle=${Math.round(idleMs / 60_000)}min`)
        session._stoppedByUser = true // prevent auto-restart
        if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
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
    // Headless sessions are exempt from stale pruning — they are long-lived by design.
    const staleIds: string[] = []
    for (const session of this.sessions.values()) {
      if (isHeadlessSession(session)) continue
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
      _isStarting: false,
      _wasActiveBeforeRestart: false,
      _apiRetry: { count: 0 },
      _turnCount: 0,
      _claudeTurnCount: 0,
      _namingAttempts: 0,
      _processGeneration: 0,
      _noOutputExitCount: 0,
      _lifetimeRestarts: 0,
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
   *
   * @param targetBranch — use this as the worktree branch name instead of
   *   the default `wt/{shortId}`. The orchestrator uses this to create the
   *   worktree directly on the desired feature branch so Claude doesn't
   *   need to create a second branch.
   * @param baseBranch — create the worktree branch from this ref (e.g.
   *   'main'). Defaults to auto-detecting the default branch. Prevents
   *   worktrees from accidentally branching off a random HEAD.
   */
  async createWorktree(sessionId: string, workingDir: string, targetBranch?: string, baseBranch?: string): Promise<string | null> {
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

      const shortId = sessionId.slice(0, 8)
      const branchName = targetBranch ?? `${this.getWorktreeBranchPrefix()}${shortId}`
      const projectName = path.basename(repoRoot)
      const worktreePath = path.resolve(repoRoot, '..', `${projectName}-wt-${shortId}`)

      // Auto-detect the default branch if baseBranch not specified.
      // Tries origin/HEAD, then falls back to common names.
      let resolvedBase: string | undefined = baseBranch
      if (!resolvedBase) {
        resolvedBase = await this.detectDefaultBranch(repoRoot, env) ?? undefined
      }

      // Determine if this is an ephemeral branch (wt/ prefix, generated by us)
      // vs a caller-supplied branch name (e.g. fix/feature-xyz from orchestrator).
      // Caller-supplied branches must NEVER be force-deleted — they may contain
      // unique commits from a previous session or manual work.
      const isEphemeralBranch = !targetBranch

      // Check if the target branch already exists as a local branch
      let branchExists = false
      try {
        await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoRoot, env, timeout: 3000 })
        branchExists = true
      } catch {
        // Branch doesn't exist — will be created
      }

      // Clean up stale state from previous failed attempts:
      // 1. Prune orphaned worktree entries (directory gone but git still tracks it)
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot, env, timeout: 5000 })
        .catch((e: unknown) => console.warn(`[worktree] prune failed:`, e instanceof Error ? e.message : e))
      // 2. Remove existing worktree directory if leftover from a partial failure.
      //    If git doesn't recognise it as a worktree, force-remove the directory
      //    so that `git worktree add` below doesn't fail with "already exists".
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, env, timeout: 5000 })
        .catch((e: unknown) => {
          console.debug(`[worktree] remove prior worktree (expected if fresh):`, e instanceof Error ? e.message : e)
          // Git doesn't know about it — nuke the stale directory if it still exists
          if (existsSync(worktreePath)) {
            try {
              rmSync(worktreePath, { recursive: true, force: true })
              console.log(`[worktree] Force-removed stale directory: ${worktreePath}`)
            } catch (rmErr) {
              console.warn(`[worktree] Failed to force-remove stale directory ${worktreePath}:`, rmErr instanceof Error ? rmErr.message : rmErr)
            }
          }
        })
      // 3. Only delete ephemeral branches (wt/*) during cleanup — never caller-supplied ones
      if (isEphemeralBranch && branchExists) {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot, env, timeout: 5000 })
          .catch((e: unknown) => console.debug(`[worktree] ephemeral branch cleanup:`, e instanceof Error ? e.message : e))
        branchExists = false
      }

      // Create the worktree:
      // - Existing branch: check it out in the worktree (no -b)
      // - New branch: create with -b, branching from the resolved base
      let worktreeArgs: string[]
      if (branchExists) {
        worktreeArgs = ['worktree', 'add', worktreePath, branchName]
        console.log(`[worktree] Using existing branch ${branchName}`)
      } else {
        worktreeArgs = ['worktree', 'add', '-b', branchName, worktreePath]
        if (resolvedBase) worktreeArgs.push(resolvedBase)
        console.log(`[worktree] Creating new branch ${branchName}${resolvedBase ? ` from ${resolvedBase}` : ''}`)
      }
      await execFileAsync('git', worktreeArgs, {
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
   * Retries once on failure after a short delay.
   */
  private cleanupWorktree(worktreePath: string, repoDir: string, attempt = 1): void {
    const MAX_CLEANUP_ATTEMPTS = 2
    const RETRY_DELAY_MS = 3000

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
        const errMsg = err instanceof Error ? err.message : String(err)
        if (attempt < MAX_CLEANUP_ATTEMPTS) {
          console.warn(`[worktree] Failed to clean up worktree ${worktreePath} (attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS}): ${errMsg} — retrying in ${RETRY_DELAY_MS}ms`)
          setTimeout(() => this.cleanupWorktree(worktreePath, repoDir, attempt + 1), RETRY_DELAY_MS)
        } else {
          console.error(`[worktree] Failed to clean up worktree ${worktreePath} after ${MAX_CLEANUP_ATTEMPTS} attempts: ${errMsg}`)
          // Last resort: force-remove the directory so it doesn't block future
          // worktree creation or leave the session in a broken restart loop.
          if (existsSync(worktreePath)) {
            try {
              rmSync(worktreePath, { recursive: true, force: true })
              console.log(`[worktree] Force-removed stale worktree directory: ${worktreePath}`)
            } catch (rmErr) {
              console.error(`[worktree] Failed to force-remove ${worktreePath}:`, rmErr instanceof Error ? rmErr.message : rmErr)
            }
          }
        }
      }
    })()
  }

  /**
   * Detect the default branch of a repository (main, master, etc.).
   * Tries `git symbolic-ref refs/remotes/origin/HEAD` first, then checks
   * for common branch names. Returns null if detection fails.
   */
  private async detectDefaultBranch(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    // Try origin/HEAD (set by git clone or git remote set-head)
    try {
      const { stdout } = await execFileAsync(
        'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        { cwd: repoRoot, env, timeout: 5000 },
      )
      const ref = stdout.trim() // e.g. "refs/remotes/origin/main"
      if (ref) {
        const branch = ref.replace('refs/remotes/origin/', '')
        console.log(`[worktree] Detected default branch from origin/HEAD: ${branch}`)
        return branch
      }
    } catch {
      // origin/HEAD not set — fall through to heuristics
    }

    // Check for common default branch names — use show-ref to verify
    // these are actual local branches, not tags or other refs
    for (const candidate of ['main', 'master']) {
      try {
        await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd: repoRoot, env, timeout: 3000 })
        console.log(`[worktree] Detected default branch by name: ${candidate}`)
        return candidate
      } catch {
        // branch doesn't exist, try next
      }
    }

    console.warn(`[worktree] Could not detect default branch for ${repoRoot} — worktree will branch from HEAD`)
    return null
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
    return this.promptRouter.getPendingPrompts()
  }

  /** Clear the isProcessing flag for a session and broadcast the update. */
  clearProcessingFlag(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session && session.isProcessing) {
      session.isProcessing = false
      this._globalBroadcast?.({ type: 'sessions_updated' })
    }
  }

  private serializeSession(s: Session): SessionInfo {
    return {
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
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.source !== 'orchestrator')
      .map((s) => this.serializeSession(s))
  }

  /** List ALL sessions including orchestrator — used by orchestrator cleanup endpoints. */
  listAll(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map((s) => this.serializeSession(s))
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
      // The grace period must be long enough for the client to complete its
      // reconnect flow: zombie retry pings (up to 6s) + auth check + WS handshake.
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
        }, 10_000)
      }
    }
  }

  /** Delete a session: kill its process, notify clients, remove from memory and disk. */
  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Prevent auto-restart when deleting
    session._stoppedByUser = true
    if (session._apiRetry.timer) clearTimeout(session._apiRetry.timer)
    if (session._namingTimer) clearTimeout(session._namingTimer)
    if (session._leaveGraceTimer) clearTimeout(session._leaveGraceTimer)
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }

    // Kill claude process if running — remove listeners first to prevent the
    // exit handler from triggering an auto-restart on a deleted session.
    // Wait for the process to fully exit before worktree cleanup so we don't
    // run `git worktree remove` while Claude is still performing git operations.
    const exitPromise = session.claudeProcess
      ? (() => {
          const cp = session.claudeProcess
          cp.removeAllListeners()
          cp.stop()
          session.claudeProcess = null
          return cp.waitForExit()
        })()
      : Promise.resolve()

    this.archiveSessionIfWorthSaving(session)

    // Clean up git worktree if this session used one — deferred until process exits
    if (session.worktreePath) {
      const wtPath = session.worktreePath
      const repoDir = session.groupDir ?? session.workingDir
      void exitPromise.then(() => this.cleanupWorktree(wtPath, repoDir))
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
    if (totalOutputLength < 150) return // Too short to be meaningful session output

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
   * Delegates to SessionLifecycle.
   */
  startClaude(sessionId: string): boolean {
    return this.sessionLifecycle.startClaude(sessionId)
  }

  /**
   * Wait for a session's Claude process to emit its system_init event.
   * Delegates to SessionLifecycle.
   */
  waitForReady(sessionId: string, timeoutMs = 30_000): Promise<boolean> {
    return this.sessionLifecycle.waitForReady(sessionId, timeoutMs)
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
    session._lastReportedModel = model
    // Always broadcast — this is the single "session is ready" notification.
    // The text includes the model so the user knows which model is active.
    this.broadcastAndHistory(session, { type: 'system_message', subtype: 'init', text: `Model: ${model}`, model })
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
      session._apiRetry.count = 0
      session._apiRetry.scheduled = false
      return false
    }

    // Skip retry if the original input is older than 60 seconds — context has likely moved on
    if (session._lastUserInputAt && Date.now() - session._lastUserInputAt > 60_000) {
      console.log(`[api-retry] skipping stale retry for session=${sessionId} (input age=${Math.round((Date.now() - session._lastUserInputAt) / 1000)}s)`)
      session._apiRetry.count = 0
      session._apiRetry.scheduled = false
      return false
    }

    if (session._apiRetry.count < MAX_API_RETRIES) {
      // Prevent duplicate scheduling from concurrent error paths
      if (session._apiRetry.scheduled) return true

      session._apiRetry.count++
      const attempt = session._apiRetry.count
      const delay = API_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)

      const retryMsg: WsServerMessage = {
        type: 'system_message',
        subtype: 'restart',
        text: `API error (transient). Retrying automatically in ${delay / 1000}s (attempt ${attempt}/${MAX_API_RETRIES})...`,
      }
      this.addToHistory(session, retryMsg)
      this.broadcast(session, retryMsg)

      console.log(`[api-retry] session=${sessionId} attempt=${attempt}/${MAX_API_RETRIES} delay=${delay}ms error=${result.slice(0, 200)}`)

      if (session._apiRetry.timer) clearTimeout(session._apiRetry.timer)
      session._apiRetry.scheduled = true
      session._apiRetry.timer = setTimeout(() => {
        session._apiRetry.timer = undefined
        session._apiRetry.scheduled = false
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
    session._apiRetry.count = 0
    session._apiRetry.scheduled = false
    return false
  }

  /**
   * Broadcast the turn result, suppress orchestrator noise, notify listeners,
   * and trigger session naming if needed.
   */
  private finalizeResult(session: Session, sessionId: string, result: string, isError: boolean): void {
    session._apiRetry.count = 0
    session._apiRetry.scheduled = false
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
      // Short canned responses like "no response requested" — skip archiving
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

  /** Handle Claude process exit. Delegates to SessionLifecycle. @internal — used by tests. */
  handleClaudeExit(...args: Parameters<SessionLifecycle['handleClaudeExit']>): void {
    this.sessionLifecycle.handleClaudeExit(...args)
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

    // --- Phase 1: ensure process is alive ---
    if (!session.claudeProcess?.isAlive()) {
      // Race guard: prevent concurrent startClaude calls when multiple sendInput
      // requests arrive for an inactive session
      if (session._isStarting) return
      session._isStarting = true
      // Claude not running (e.g. after server restart or idle reap) — auto-start first.
      try {
        this.startClaude(sessionId)
      } finally {
        session._isStarting = false
      }
    }

    // --- Phase 2: determine message content (with context injection if needed) ---
    let messageToSend = data

    // If we auto-started above and have no saved claudeSessionId, Claude CLI
    // starts a fresh session without conversation history.  Inject a context
    // summary so the new process has awareness of prior conversation.
    if (!session.claudeSessionId) {
      const context = this.buildSessionContext(session)
      if (context) {
        messageToSend = context + '\n\n' + data
      }
    }

    // Track turn count; retry naming on subsequent interactions if still unnamed
    if (session._turnCount === 0 && session.name.startsWith('hub:')) {
      session._turnCount = 1
    } else if (session.name.startsWith('hub:')) {
      // Session still unnamed after initial attempt — retry on user interaction
      this.retrySessionNamingOnInteraction(sessionId)
    }

    session._lastUserInput = messageToSend
    session._lastUserInputAt = Date.now()
    if (!session._namingUserInput) session._namingUserInput = data
    session._apiRetry.count = 0
    if (!session.isProcessing) {
      session.isProcessing = true
      this._globalBroadcast?.({ type: 'sessions_updated' })
    }

    // --- Phase 3: send, waiting for readiness if needed ---
    if (session.claudeProcess && !session.claudeProcess.isReady()) {
      void this.waitForReady(sessionId).then((ready) => {
        if (ready) session.claudeProcess?.sendMessage(messageToSend)
        // If not ready (process exited), message stays in _lastUserInput
        // and will be re-sent on auto-restart
      })
    } else {
      session.claudeProcess?.sendMessage(messageToSend)
    }
  }

  /**
   * Route a user's prompt response to the correct handler.
   * Delegates to PromptRouter.
   */
  sendPromptResponse(sessionId: string, value: string | string[], requestId?: string): void {
    this.promptRouter.sendPromptResponse(sessionId, value, requestId)
  }

  /**
   * Called by the PermissionRequest hook HTTP endpoint. Sends a prompt to clients
   * and returns a Promise that resolves when the user approves/denies.
   * Delegates to PromptRouter.
   */
  requestToolApproval(sessionId: string, toolName: string, toolInput: Record<string, unknown>): Promise<{ allow: boolean; always: boolean; answer?: string }> {
    return this.promptRouter.requestToolApproval(sessionId, toolName, toolInput)
  }

  getSessionProvider(sessionId: string): string {
    return this.sessions.get(sessionId)?.provider ?? 'claude'
  }

  /** Update the provider for a session and restart with the new provider process. */
  setProvider(sessionId: string, provider: CodingProvider): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session.provider === provider) return true
    session.provider = provider
    session.claudeSessionId = null
    // Clear any pending restart timer from a prior crash to prevent a stale
    // timer from spawning a second process after we restart below.
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
    this.persistToDiskDebounced()
    if (session.claudeProcess?.isAlive()) {
      // Use stopClaudeAndWait to ensure the old process fully exits before
      // spawning a new one — avoids concurrent processes in the same worktree.
      void this.stopClaudeAndWait(sessionId).then(() => {
        if (this.sessions.has(sessionId)) {
          session._stoppedByUser = false
          this.startClaude(sessionId)
        }
      })
    }
    return true
  }

  /** Update the model for a session and restart Claude with the new model. */
  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.model = model || undefined
    // Clear any pending restart timer from a prior crash to prevent a stale
    // timer from spawning a second process after we restart below.
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
    this.persistToDiskDebounced()
    // Restart Claude with the new model if it's running.
    // Use stopClaudeAndWait to ensure the old process fully exits before
    // spawning a new one — avoids concurrent processes in the same worktree.
    if (session.claudeProcess?.isAlive()) {
      void this.stopClaudeAndWait(sessionId).then(() => {
        if (this.sessions.has(sessionId)) {
          session._stoppedByUser = false
          this.startClaude(sessionId)
        }
      })
    }
    return true
  }

  /** Update the permission mode for a session and restart Claude with the new mode. */
  setPermissionMode(sessionId: string, permissionMode: import('./types.js').PermissionMode): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const previousMode = session.permissionMode
    session.permissionMode = permissionMode
    // Clear any pending restart timer from a prior crash to prevent a stale
    // timer from spawning a second process after we restart below.
    if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
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

    // Restart Claude with the new permission mode if it's running.
    // Use stopClaudeAndWait to ensure the old process fully exits before
    // spawning a new one — avoids concurrent processes in the same worktree.
    if (session.claudeProcess?.isAlive()) {
      void this.stopClaudeAndWait(sessionId).then(() => {
        if (this.sessions.has(sessionId)) {
          session._stoppedByUser = false
          this.startClaude(sessionId)
        }
      })
    }
    return true
  }

  /** Stop the Claude process for a session. Delegates to SessionLifecycle. */
  stopClaude(sessionId: string): void {
    this.sessionLifecycle.stopClaude(sessionId)
  }

  /**
   * Stop the Claude process and wait for it to fully exit before resolving.
   * Delegates to SessionLifecycle.
   */
  async stopClaudeAndWait(sessionId: string): Promise<void> {
    return this.sessionLifecycle.stopClaudeAndWait(sessionId)
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
    if (context.length > 4000) { // Truncate to keep context injection reasonable
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
    // Mark all sessions as stopped-by-user and remove exit listeners BEFORE
    // sending SIGTERM — otherwise handleClaudeExit fires, sees stoppedByUser
    // is false, and injects a spurious "Restarting (attempt 1/3)" message.
    const exitPromises: Promise<void>[] = []
    for (const session of this.sessions.values()) {
      if (session.claudeProcess?.isAlive()) {
        session._stoppedByUser = true
        if (session._restartTimer) { clearTimeout(session._restartTimer); session._restartTimer = undefined }
        if (session._apiRetry?.timer) clearTimeout(session._apiRetry.timer)
        const cp = session.claudeProcess
        cp.removeAllListeners()
        exitPromises.push(cp.waitForExit())
        cp.stop()
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
