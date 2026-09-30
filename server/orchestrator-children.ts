/**
 * Orchestrator child session manager — spawns, monitors, and reports on
 * implementation sessions created by the orchestrator.
 *
 * Follows the same patterns as workflow-loader.ts for session creation
 * and result polling.
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { VALID_PROVIDERS } from './types.js'
import type { CodingProvider } from './coding-process.js'
import type { SessionManager, SessionStopReason } from './session-manager.js'
import type { WorktreeRemovalPreflight, WsServerMessage } from './types.js'
import { getAgentDisplayName } from './config.js'
import { AGENT_ALLOWED_TOOLS } from './agent-allowlist.js'
import type { RunStore, StoredRun } from './run-store.js'
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
  /**
   * How changes should land: 'pr' opens a pull request, 'merge' pushes the
   * branch (it does not merge anything), 'commit-only' commits locally.
   */
  completionPolicy: 'pr' | 'merge' | 'commit-only'
  /** Use a git worktree for isolation. */
  useWorktree: boolean
  /**
   * Working-time timeout in ms (default 30 minutes). Time spent blocked on
   * a pending approval/question does not count against this budget — blocked
   * time has its own separate cap (MAX_BLOCKED_MS).
   */
  timeoutMs?: number
  /** Harness override; otherwise inherit the parent or saved Joe preference. */
  provider?: CodingProvider
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
  /** Joe task this child works on; its status follows the child (see OrchestratorTaskService). */
  taskId?: string
}

/**
 * Child lifecycle. Terminal outcomes:
 *  - completed:  the final step was verified (or there is nothing remote to verify)
 *  - unverified: the agent stopped, but its PR / push could not be confirmed —
 *                a human (or Joe) must check before treating it as done
 *  - failed:     the agent errored, or exited with the final step missing
 *  - timed_out:  the working or blocked-time budget ran out
 *  - canceled:   the session was stopped, archived, or deleted
 */
export type ChildStatus = 'starting' | 'running' | 'blocked' | 'completed' | 'unverified' | 'failed' | 'timed_out' | 'canceled'

/** Statuses considered terminal — once entered, the child is done. */
const TERMINAL_STATUSES: ReadonlySet<ChildStatus> = new Set([
  'completed',
  'unverified',
  'failed',
  'timed_out',
  'canceled',
])

export function isTerminalChildStatus(status: ChildStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Evidence behind a child's completion status. */
export interface ChildVerification {
  /**
   * - verified:       the PR (open or merged) / remote branch points at the local HEAD
   * - missing:        checked, and the expected PR / push is absent or behind HEAD
   * - unknown:        the check itself could not run (no gh, no remote, …)
   * - not_applicable: commit-only — nothing remote to verify
   */
  state: 'verified' | 'missing' | 'unknown' | 'not_applicable'
  /** Commit the evidence refers to (the worktree's HEAD when checked). */
  commit: string | null
  prUrl: string | null
  detail: string
  checkedAt: string
}

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
   *  - 'failed': worktree was requested but creation failed (child not started)
   *  - 'none':   worktree was not requested
   */
  worktree: 'active' | 'failed' | 'none'
  /** Absolute path of the worktree when active. */
  worktreePath: string | null
  /** Latest final-step check, once the child has finished a turn. */
  verification: ChildVerification | null
  /** Supervised attempt number — 1 at spawn, incremented by each resume. */
  attempt: number
}

/** A control request that cannot be applied in the child's current state. */
export class ChildControlError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'ChildControlError'
  }
}

/** What closing a child did to its session, worktree, and branch. */
export interface ChildCloseResult {
  child: ChildSession
  /** archived: stopped + hidden, resumable. deleted: session record removed. */
  action: 'archived' | 'deleted'
  worktree: {
    path: string | null
    /**
     * kept: left in place (archive, or delete with uncommitted work)
     * removal_started: clean — removed once the process exits
     * none: the child had no worktree
     */
    outcome: 'kept' | 'removal_started' | 'none'
    modified: string[]
    untracked: string[]
  }
  /** Branches are never deleted. */
  branch: string
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
   * Per-child monitor controllers — let session events act on a monitored
   * child immediately: pause/resume the working-time clock the moment a
   * prompt opens or resolves, and cancel when the session is stopped.
   */
  private controllers = new Map<string, { pause(): void; resume(): void; cancel(error: string): void }>()
  private exec: ExecFn
  /** Unified run store — children persist as engine:'agent' runs when set. */
  private runStore: RunStore | null
  /** Notified on every persisted child state change (task sync, …). */
  private updateListeners: Array<(child: ChildSession) => void> = []

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
    // An answered (or auto-denied) prompt unblocks the child right away — the
    // agent keeps working before its next result event arrives.
    this.sessions.onSessionPromptResolved((sessionId) => {
      this.handlePromptResolved(sessionId)
    })
    // Stop/archive/delete detach the process's listeners before killing it,
    // so no exit event reaches the monitor — settle the child here instead.
    this.sessions.onSessionStopped((sessionId, reason) => {
      this.handleSessionStopped(sessionId, reason)
    })
  }

  /** Register a listener for every child state change. Returns an unsubscribe function. */
  onChildUpdate(listener: (child: ChildSession) => void): () => void {
    this.updateListeners.push(listener)
    return () => {
      const idx = this.updateListeners.indexOf(listener)
      if (idx >= 0) this.updateListeners.splice(idx, 1)
    }
  }

  /** Unblock a child once its last pending prompt is resolved. */
  private handlePromptResolved(sessionId: string): void {
    const child = this.children.get(sessionId)
    if (child?.status !== 'blocked') return
    const session = this.sessions.get(sessionId)
    if (session && (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0)) return
    child.status = 'running'
    this.controllers.get(sessionId)?.resume()
    this.persistRun(child, 'Unblocked: prompt resolved, working clock resumed.')
  }

  /** Cancel an active child whose session was deliberately taken out of service. */
  private handleSessionStopped(sessionId: string, reason: SessionStopReason): void {
    const child = this.children.get(sessionId)
    if (!child || TERMINAL_STATUSES.has(child.status)) return
    const error = reason === 'deleted' ? 'Session was deleted'
      : reason === 'archived' ? 'Session was archived'
      : 'Session was stopped by the user'
    const controller = this.controllers.get(sessionId)
    if (controller) {
      controller.cancel(error)  // monitorChild's finally persists + notifies
      return
    }
    // Not monitored yet (still spawning) — settle directly.
    child.status = 'canceled'
    child.error = error
    child.completedAt = new Date().toISOString()
    this.persistRun(child, `Finished: canceled — ${error}`)
    this.notifyTerminal(child)
  }

  /**
   * Rebuild children whose runs were interrupted by a server restart (the
   * run store has already failed them). They are listed again, their parent
   * is told once so partial work can be salvaged, and their sessions are
   * kept from auto-restarting unsupervised.
   */
  recoverInterrupted(runIds: string[]): ChildSession[] {
    const recovered: ChildSession[] = []
    for (const id of runIds) {
      const run = this.runStore?.getRun(id)
      if (run?.engine !== 'agent' || run.kind !== 'child' || this.children.has(id)) continue
      const child = this.childFromRun(run)
      if (!child) continue
      const session = this.sessions.get(id)
      if (session) session._wasActiveBeforeRestart = false
      this.children.set(id, child)
      this.notifyTerminal(child)
      recovered.push(child)
    }
    return recovered
  }

  /** Reconstruct a (read-only) child record from its persisted run. */
  private childFromRun(run: StoredRun): ChildSession | null {
    const spec = run.spec as Partial<ChildSessionRequest>
    if (typeof spec.repo !== 'string' || typeof spec.task !== 'string' || typeof spec.branchName !== 'string') return null
    const statusMap: Partial<Record<RunLifecycleStatus, ChildStatus>> = {
      queued: 'starting',
      running: 'running',
      blocked: 'blocked',
      succeeded: 'completed',
      awaiting_human: 'unverified',
      failed: run.error?.startsWith('Timed out') ? 'timed_out' : 'failed',
      canceled: 'canceled',
    }
    const worktreePath = this.sessions.get(run.id)?.worktreePath ?? null
    return {
      id: run.id,
      request: {
        repo: spec.repo,
        task: spec.task,
        branchName: spec.branchName,
        completionPolicy: spec.completionPolicy ?? 'pr',
        useWorktree: spec.useWorktree ?? true,
        timeoutMs: spec.timeoutMs,
        provider: spec.provider,
        model: spec.model,
        allowedTools: spec.allowedTools,
        parentSessionId: spec.parentSessionId,
        taskId: spec.taskId,
      },
      status: statusMap[run.status] ?? 'failed',
      startedAt: run.createdAt,
      completedAt: run.completedAt,
      result: null,
      error: run.error,
      terminalNotifiedAt: null,
      worktree: worktreePath ? 'active' : spec.useWorktree === false ? 'none' : 'failed',
      worktreePath,
      verification: null,
      attempt: 1,
    }
  }

  // -------------------------------------------------------------------------
  // Control — only for children this manager owns (spawned by the orchestrator)
  // -------------------------------------------------------------------------

  private requireChild(id: string): ChildSession {
    const child = this.get(id)
    if (!child) throw new ChildControlError('Not one of your child sessions', 404)
    return child
  }

  /**
   * Send a follow-up instruction to an active child. A turn in progress
   * receives it as its next message. Blocked children must have their prompt
   * answered first (respond_to_prompt) — free text would not answer it.
   */
  sendFollowUp(id: string, text: string): ChildSession {
    const child = this.requireChild(id)
    if (TERMINAL_STATUSES.has(child.status)) {
      throw new ChildControlError(`Child is ${child.status} — use resume to start another supervised attempt`, 409)
    }
    const session = this.sessions.get(id)
    if (!session) throw new ChildControlError('Session no longer exists', 404)
    if (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0) {
      throw new ChildControlError('Child is waiting on a prompt — answer it with respond_to_prompt first', 409)
    }
    this.sessions.sendInput(id, text)
    this.persistRun(child, `Follow-up from the orchestrator: ${text.slice(0, 200)}`)
    return child
  }

  /** Stop an active child. It becomes canceled; its worktree and branch are kept. */
  stop(id: string): ChildSession {
    const child = this.requireChild(id)
    if (TERMINAL_STATUSES.has(child.status)) {
      throw new ChildControlError(`Child is already ${child.status}`, 409)
    }
    this.markOrchestratorInitiated(child)
    this.sessions.stopSession(id)  // → onSessionStopped → canceled
    return child
  }

  /**
   * Start a new supervised attempt on a finished child's session: same
   * branch and worktree, fresh working-time budget, verification rerun at
   * the end. The agent keeps its conversation and gets `instructions`.
   */
  resume(id: string, instructions?: string): ChildSession {
    const existing = this.requireChild(id)
    if (!TERMINAL_STATUSES.has(existing.status)) {
      throw new ChildControlError(`Child is ${existing.status} — send it a follow-up instead`, 409)
    }
    const session = this.sessions.get(id)
    if (!session) throw new ChildControlError('Session was deleted — spawn a new child instead', 409)
    if (session.worktreeState === 'removed') {
      throw new ChildControlError('The worktree was removed — spawn a new child from the branch instead', 409)
    }
    this.purgeStaleChildren()
    if (this.activeCount() >= MAX_CONCURRENT) {
      throw new ChildControlError(`Cannot resume: ${MAX_CONCURRENT} concurrent sessions already running`, 409)
    }

    const child: ChildSession = {
      ...existing,
      status: 'running',
      completedAt: null,
      result: null,
      error: null,
      terminalNotifiedAt: null,
      verification: null,
      attempt: existing.attempt + 1,
      worktreePath: session.worktreePath ?? existing.worktreePath,
    }
    this.children.set(id, child)
    if (session.archivedAt) this.sessions.resumeSession(id)
    this.persistRun(child, `Resumed: attempt ${child.attempt}.`)
    void this.monitorChild(child)
    this.sessions.sendInput(id, instructions?.trim() || this.buildResumeInstruction(child.request))
    return child
  }

  /**
   * Close a child. `archive` (default) stops it and keeps session, transcript,
   * worktree and branch — resume brings it back. `delete` removes the session;
   * a clean worktree is removed, one with uncommitted work is kept. Active
   * children are refused unless `cancel` is set. Branches are never deleted.
   */
  async close(id: string, opts: { mode?: 'archive' | 'delete'; cancel?: boolean } = {}): Promise<ChildCloseResult> {
    const child = this.requireChild(id)
    if (!TERMINAL_STATUSES.has(child.status) && !opts.cancel) {
      throw new ChildControlError(`Child is ${child.status} — stop it first or pass cancel: true`, 409)
    }
    const session = this.sessions.get(id)
    if (!session) throw new ChildControlError('Session no longer exists', 404)
    if (!TERMINAL_STATUSES.has(child.status)) this.markOrchestratorInitiated(child)
    const mode = opts.mode ?? 'archive'
    const worktreePath = session.worktreePath ?? null
    const noWorktree = { path: null, outcome: 'none' as const, modified: [], untracked: [] }

    if (mode === 'archive') {
      this.sessions.archiveSession(id)  // → onSessionStopped cancels an active child
      return {
        child: this.get(id) ?? child,
        action: 'archived',
        worktree: worktreePath ? { path: worktreePath, outcome: 'kept', modified: [], untracked: [] } : noWorktree,
        branch: child.request.branchName,
      }
    }

    let preflight: WorktreeRemovalPreflight | null = null
    if (worktreePath) preflight = await this.sessions.getRemovalPreflight(id)
    this.sessions.delete(id)  // → onSessionStopped cancels an active child
    const current = this.children.get(id) ?? child
    this.children.delete(id)  // the run store keeps the history
    return {
      child: current,
      action: 'deleted',
      worktree: worktreePath
        ? {
            path: worktreePath,
            // delete() never forces removal: dirty/untracked work stays on disk.
            outcome: preflight && preflight.modified.length + preflight.untracked.length === 0 ? 'removal_started' : 'kept',
            modified: preflight?.modified ?? [],
            untracked: preflight?.untracked ?? [],
          }
        : noWorktree,
      branch: child.request.branchName,
    }
  }

  /**
   * The orchestrator asked for this stop, and the tool result tells it the
   * outcome — skip the redundant "Child Session Stopped" notification.
   */
  private markOrchestratorInitiated(child: ChildSession): void {
    child.terminalNotifiedAt = new Date().toISOString()
  }

  private buildResumeInstruction(request: ChildSessionRequest): string {
    const delivery = request.completionPolicy === 'pr'
      ? 'make sure your latest commit is pushed and an open Pull Request points at it'
      : request.completionPolicy === 'merge'
        ? 'make sure your latest commits are pushed to the remote branch'
        : 'commit your changes locally'
    return `Continue the task: ${request.task}\n\nPick up where you left off, finish the remaining work, then ${delivery}. Summarize what you changed when done.`
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
    this.controllers.get(sessionId)?.pause()

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

  /**
   * Get a child session by ID. Children evicted from the live list (or from
   * before a restart) are rebuilt from the run store as read-only history.
   */
  get(id: string): ChildSession | null {
    const live = this.children.get(id)
    if (live) return live
    const run = this.runStore?.getRun(id)
    return run?.engine === 'agent' && run.kind === 'child' ? this.childFromRun(run) : null
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
    for (const listener of this.updateListeners) {
      try { listener(child) } catch (err) { console.error('[orchestrator-child] Update listener threw:', err) }
    }
    if (!this.runStore) return
    try {
      const statusMap: Record<ChildStatus, RunLifecycleStatus> = {
        starting: 'queued',
        running: 'running',
        blocked: 'blocked',
        completed: 'succeeded',
        unverified: 'awaiting_human',
        failed: 'failed',
        timed_out: 'failed',
        canceled: 'canceled',
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
        ...(child.verification?.prUrl ? { prUrl: child.verification.prUrl } : {}),
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
    const parent = request.parentSessionId ? this.sessions.get(request.parentSessionId) : undefined
    const provider = request.provider ?? parent?.provider ?? this.sessions.archive.getSetting('agent_provider', '')
    if (!VALID_PROVIDERS.has(provider as CodingProvider)) {
      throw new Error('Choose an agent harness for Joe or specify a child provider before spawning')
    }
    request = {
      ...request,
      provider: provider as CodingProvider,
      model: request.model ?? (provider === parent?.provider ? parent?.model : undefined),
    }
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
      verification: null,
      attempt: 1,
    }
    this.children.set(sessionId, child)
    this.persistRun(child, `Spawned in ${request.repo} on branch ${request.branchName}.`)

    try {
      // Create the session
      this.sessions.create(sessionName, request.repo, {
        source: 'agent',
        id: sessionId,
        groupDir: request.repo,
        provider: request.provider,
        model: request.model,
        permissionMode: 'acceptEdits',
        allowedTools: request.allowedTools ?? AGENT_CHILD_ALLOWED_TOOLS,
        useWorktree: request.useWorktree,
      })

      // Create a git worktree for isolation if requested (default for Joe children).
      // This must happen BEFORE startClaude so Claude runs in the worktree directory.
      // Pass the target branch name so the worktree is created directly on the
      // feature branch — no need for Claude to create a second branch.
      // A child that asked for isolation never runs in the shared checkout:
      // if the worktree cannot be created, the child fails and the parent is told.
      if (request.useWorktree) {
        const result = await this.sessions.prepareSessionWorktree(sessionId, request.repo, request.branchName)
        // Stopped or deleted while the worktree was being prepared — already settled.
        if (TERMINAL_STATUSES.has(child.status)) return child
        if (!result.ok) {
          console.warn(`[orchestrator-child] Failed to create worktree for ${sessionId}: ${result.message}`)
          this.sessions.delete(sessionId)
          child.status = 'failed'
          child.error = `Could not create an isolated worktree: ${result.message}`
          child.completedAt = new Date().toISOString()
          this.persistRun(child, 'Worktree creation failed; nothing was started in the shared checkout.')
          this.notifyTerminal(child)
          return child
        }
        child.worktree = 'active'
        child.worktreePath = result.path
      }

      // Start the selected coding agent
      this.sessions.startClaude(sessionId)
      child.status = 'running'
      this.persistRun(child)

      // Build and send the task prompt, including worktree failure context
      const prompt = this.buildPrompt(request)
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
    if (child.request.taskId) lines.push(`Task: ${child.request.taskId}`)
    if (child.error) lines.push(`Error: ${child.error}`)
    const v = child.verification
    if (v) {
      lines.push(`Verification: ${v.state} — ${v.detail}`)
      if (v.commit) lines.push(`Commit: ${v.commit}`)
      if (v.prUrl) lines.push(`PR: ${v.prUrl}`)
    }
    lines.push(this.buildHintLine(child))
    return lines.join('\n')
  }

  /**
   * Build a single-line hint about how to proceed, tailored to the status:
   *   - timed_out / failed / canceled → point at the worktree so partial work can be salvaged
   *   - unverified → the PR / push must be checked before treating the work as done
   *   - completed  → the evidence above is ready for review
   */
  private buildHintLine(child: ChildSession): string {
    const worktreePath = this.sessions.get(child.id)?.worktreePath ?? child.worktreePath
    const where = worktreePath ?? `${child.request.repo} (no worktree)`
    if (child.status === 'timed_out' || child.status === 'failed' || child.status === 'canceled') {
      return `Inspect worktree at ${where} for partial work.`
    }
    if (child.status === 'unverified') {
      return `Not confirmed done — check the ${child.request.completionPolicy === 'pr' ? 'PR' : 'pushed branch'} (worktree: ${where}) before reporting it as ready.`
    }
    if (child.status === 'completed') {
      if (child.request.completionPolicy === 'commit-only') return 'Verify changes were committed locally as expected.'
      return 'Ready for review.'
    }
    return 'Review the child session output before deciding next steps.'
  }

  /**
   * Build a focused task prompt for a child session.
   */
  private buildPrompt(request: ChildSessionRequest): string {
    const inWorktree = request.useWorktree

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
          // A deliberate stop — a bare process kill would look like a crash
          // and be auto-restarted, leaving an unsupervised process behind.
          this.sessions.stopClaude(child.id)
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

        const cancel = (error: string) => {
          if (settled) return
          child.status = 'canceled'
          child.error = error
          child.completedAt = new Date().toISOString()
          clearTimers()
          settle()
        }

        // Expose the clock and cancellation to session-event handlers.
        this.controllers.set(child.id, { pause, resume, cancel })

        // Start the working clock.
        workStartedAt = Date.now()
        workTimer = setTimeout(() => {
          fireTimeout(`Timed out after ${timeoutMs}ms of working time`)
        }, remainingMs)

        // Guard against overlapping async ground-truth checks when result
        // events arrive in quick succession.
        let verifying = false

        // Result hook: the coding agent completed a turn
        const onResult = (sessionId: string, isError: boolean) => {
          if (sessionId !== child.id || settled || verifying) return
          const session = this.sessions.get(child.id)
          if (!session) {
            cancel('Session was deleted')
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

          // Normally the prompt-resolved event already unblocked the child;
          // this covers prompts resolved without one.
          resume()
          if (child.status === 'blocked') {
            child.status = 'running'
            this.persistRun(child)
          }

          verifying = true
          void (async () => {
            try {
              const text = this.extractText(session.outputHistory)
              if (isError) {
                if (isSettled()) return
                child.status = 'failed'
                child.result = text || null
                child.error = 'Coding agent returned an error'
                child.completedAt = new Date().toISOString()
                clearTimers()
                settle()
                return
              }

              // Ground-truth check: did the final step (PR / push) really land,
              // at the commit the child ended on?
              const verification = await this.verifyFinalStep(child)
              if (isSettled()) return
              child.verification = verification

              // Final step missing — nudge once, then keep monitoring.
              if (verification.state === 'missing' && !nudgedIds.has(child.id) && session.claudeProcess?.isAlive()) {
                nudgedIds.add(child.id)
                this.persistRun(child, `Final step missing (${verification.detail}); nudged once.`)
                this.sessions.sendInput(child.id, this.buildNudgeInstruction(child.request.completionPolicy, verification))
                return
              }

              const done = verification.state === 'verified' || verification.state === 'not_applicable'
              child.status = done ? 'completed' : 'unverified'
              child.result = text || null
              child.error = done ? null : `Completion not verified: ${verification.detail}`
              child.completedAt = new Date().toISOString()
              clearTimers()
              settle()
            } finally {
              verifying = false
            }
          })()
        }

        // Exit hook: the coding agent process exited
        const onExit = (sessionId: string, _code: number | null, _signal: string | null, willRestart: boolean) => {
          if (sessionId !== child.id || settled) return
          if (willRestart) return  // Will auto-restart, keep monitoring

          const session = this.sessions.get(child.id)
          const text = session ? this.extractText(session.outputHistory) : ''
          void (async () => {
            // Process is gone — decide the terminal status from ground truth
            // (did the PR / push land?) rather than transcript length.
            let verification: ChildVerification = session
              ? await this.verifyFinalStep(child)
              : { state: 'missing', commit: null, prUrl: null, detail: 'the session no longer exists', checkedAt: new Date().toISOString() }
            // commit-only has no remote artifact to verify; an exit without
            // any output cannot be considered a success.
            if (verification.state === 'not_applicable' && !text) {
              verification = { ...verification, state: 'missing', detail: 'the agent exited without any output' }
            }
            if (isSettled()) return
            child.verification = verification
            const done = verification.state === 'verified' || verification.state === 'not_applicable'
            child.status = done ? 'completed' : verification.state === 'unknown' ? 'unverified' : 'failed'
            child.result = text || null
            child.error = done ? null : `Coding agent exited before the final step could be verified: ${verification.detail}`
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
      this.controllers.delete(child.id)
      // Safety net: ensure isProcessing is cleared when monitoring ends.
      // handleClaudeResult should have already done this, but edge cases
      // (nudge race, missed result event) can leave the flag stuck.
      this.sessions.clearProcessingFlag(child.id)
      // Every terminal path funnels through here — one persist captures the
      // final status, error, and outcome.
      this.persistRun(child, `Finished: ${child.status}${child.error ? ` — ${child.error}` : ''}`)
      // Push-notify the parent orchestrator so it learns about the terminal
      // state immediately, instead of waiting for the 30-minute polling cron.
      this.notifyTerminal(child)
    }
  }

  /**
   * Ground-truth check for the child's expected final step, tied to the
   * commit the child ended on (the worktree's HEAD):
   *   - 'pr':    an open or merged PR for the branch whose head is that commit
   *   - 'merge': the remote branch points at that commit
   *   - 'commit-only': nothing remote to verify
   * When a check cannot run (gh missing, no remote) the result is 'unknown' —
   * never a success inferred from the transcript.
   */
  private async verifyFinalStep(child: ChildSession): Promise<ChildVerification> {
    const policy = child.request.completionPolicy
    const cwd = child.worktreePath ?? child.request.repo
    const branch = child.request.branchName
    const checkedAt = new Date().toISOString()
    const result = (state: ChildVerification['state'], detail: string, commit: string | null, prUrl: string | null = null): ChildVerification =>
      ({ state, detail, commit, prUrl, checkedAt })

    let head: string | null = null
    try {
      head = (await this.exec('git', ['rev-parse', 'HEAD'], cwd)).trim() || null
    } catch { /* reported per policy below */ }

    if (policy === 'commit-only') {
      return result('not_applicable', 'commit-only: nothing remote to verify', head)
    }

    if (policy === 'pr') {
      let prs: Array<{ number?: number; url?: string; state?: string; headRefOid?: string }>
      try {
        const out = await this.exec(
          'gh',
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefOid', '--limit', '5'],
          cwd,
        )
        const parsed: unknown = JSON.parse(out)
        prs = Array.isArray(parsed) ? parsed as typeof prs : []
      } catch (err) {
        return result('unknown', `could not query pull requests (${this.errorSummary(err)})`, head)
      }
      const pr = prs.find(p => p.state === 'OPEN' || p.state === 'MERGED')
      if (!pr) {
        return result('missing', prs.length > 0 ? `only closed pull requests exist for ${branch}` : `no pull request exists for ${branch}`, head)
      }
      const prUrl = pr.url ?? null
      if (head && pr.headRefOid && pr.headRefOid !== head) {
        return result('missing', `pull request ${prUrl ?? `#${pr.number}`} is at ${pr.headRefOid.slice(0, 12)}, but the branch HEAD is ${head.slice(0, 12)} — latest commits are not pushed`, head, prUrl)
      }
      return result('verified', `pull request ${prUrl ?? `#${pr.number}`} is ${pr.state === 'MERGED' ? 'merged' : 'open'} at the branch HEAD`, head ?? pr.headRefOid ?? null, prUrl)
    }

    // policy === 'merge' — the remote branch must point at the local HEAD
    let remote: string
    try {
      remote = (await this.exec('git', ['ls-remote', '--heads', 'origin', branch], cwd)).trim()
    } catch (err) {
      return result('unknown', `could not query the remote (${this.errorSummary(err)})`, head)
    }
    const remoteSha = remote.split(/\s+/)[0] || null
    if (!remoteSha) return result('missing', `branch ${branch} is not on the remote`, head)
    if (!head) return result('unknown', `branch ${branch} is on the remote, but the local HEAD could not be read`, remoteSha)
    if (remoteSha !== head) {
      return result('missing', `origin/${branch} is at ${remoteSha.slice(0, 12)}, but the branch HEAD is ${head.slice(0, 12)} — latest commits are not pushed`, head)
    }
    return result('verified', `origin/${branch} is at the branch HEAD`, head)
  }

  private errorSummary(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)
  }

  /** Follow-up instruction sent (once) when the final step is missing. */
  private buildNudgeInstruction(policy: ChildSessionRequest['completionPolicy'], verification: ChildVerification): string {
    if (policy === 'pr') {
      return `You are not done yet: ${verification.detail}. Please push your branch and make sure an open Pull Request with a clear description of what was changed and why points at your latest commit.`
    }
    return `You are not done yet: ${verification.detail}. Please push your latest commits to the remote branch now.`
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
