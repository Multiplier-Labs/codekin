/**
 * Session persistence for Codekin.
 *
 * Handles reading and writing session state to/from disk as JSON.
 * Uses atomic rename to prevent corruption on crash.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import { PlanManager } from './plan-manager.js'
import type { ProcessCoordinator } from './process-coordinator.js'
import type { Session, WsServerMessage } from './types.js'
import { jsonParse } from './json-parse.js'

const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')
const PERSIST_DEBOUNCE_MS = 2000

/** Shape of a session when serialized to disk (no process refs, Sets→arrays). */
export interface PersistedSession {
  id: string
  name: string
  workingDir: string
  groupDir?: string
  /** Absolute path to the git worktree, if this session uses one. */
  worktreePath?: string
  executionMode?: import('./types.js').ExecutionMode
  worktreeState?: import('./types.js').WorktreeState
  worktreeError?: string
  worktreeBranch?: string
  worktreeBase?: string
  reviewBase?: string
  archivedAt?: string
  created: string
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  provider?: import('./coding-process.js').CodingProvider
  model?: string
  permissionMode?: string
  /** Additional tools to pre-approve via --allowedTools. */
  allowedTools?: string[]
  claudeSessionId: string | null
  wasActive?: boolean
  outputHistory: WsServerMessage[]
  /** Handoff awaiting injection after a carry-context provider switch. */
  pendingHandoff?: import('./handoff-manager.js').Handoff
}

export class SessionPersistence {
  private sessions: Map<string, Session>
  private _persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(sessions: Map<string, Session>) {
    this.sessions = sessions
  }

  /** Write all sessions to disk as JSON (atomic rename to prevent corruption). */
  persistToDisk(): void {
    const data: PersistedSession[] = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      workingDir: s.workingDir,
      groupDir: s.groupDir,
      worktreePath: s.worktreePath,
      executionMode: s.executionMode,
      worktreeState: s.worktreeState,
      worktreeError: s.worktreeError,
      worktreeBranch: s.worktreeBranch,
      worktreeBase: s.worktreeBase,
      reviewBase: s.reviewBase,
      archivedAt: s.archivedAt,
      created: s.created,
      source: s.source,
    provider: s.provider,
      model: s.model,
      permissionMode: s.permissionMode,
      allowedTools: s.allowedTools,
      claudeSessionId: s.claudeSessionId,
      wasActive: s.claudeProcess?.isAlive() ?? false,
      outputHistory: s.outputHistory,
      pendingHandoff: s.pendingHandoff,
    }))

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = SESSIONS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      renameSync(tmp, SESSIONS_FILE)
    } catch (err) {
      console.error('Failed to persist sessions:', err)
    }
  }

  persistToDiskDebounced(): void {
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      this.persistToDisk()
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Restore sessions from disk into the sessions Map. */
  restoreFromDisk(): void {
    if (!existsSync(SESSIONS_FILE)) return

    try {
      const raw = readFileSync(SESSIONS_FILE, 'utf-8')
      const data = jsonParse(raw) as PersistedSession[]

      for (const s of data) {
        // An isolated session keeps its worktree identity even when the
        // directory is gone; it is marked missing and waits for the user to
        // retry or explicitly switch to the shared checkout. Sessions saved
        // before executionMode existed are isolated if they had a worktree.
        const executionMode = s.executionMode ?? (s.worktreePath ? 'isolated' : undefined)
        let worktreeState = s.worktreeState ?? (s.worktreePath ? 'ready' : undefined)
        let worktreeError = s.worktreeError
        if (executionMode === 'isolated' && worktreeState === 'preparing') {
          // Creation was interrupted by the restart.
          worktreeState = 'failed'
          worktreeError = 'Worktree creation was interrupted by a server restart.'
        }
        if (s.worktreePath && worktreeState !== 'removed' && !existsSync(s.worktreePath)) {
          console.warn(`[restore] Worktree ${s.worktreePath} for session ${s.id} is missing — session will wait for recovery`)
          worktreeState = 'missing'
          worktreeError = `Worktree ${s.worktreePath} no longer exists.`
        }

        const session: Session = {
          id: s.id,
          name: s.name,
          workingDir: s.workingDir,
          groupDir: s.groupDir,
          worktreePath: s.worktreePath,
          executionMode,
          worktreeState,
          worktreeError,
          worktreeBranch: s.worktreeBranch,
          worktreeBase: s.worktreeBase,
          reviewBase: s.reviewBase,
          archivedAt: s.archivedAt,
          created: s.created,
          source: s.source ?? 'manual',
          provider: s.provider ?? 'claude',
          model: s.model,
          permissionMode: s.permissionMode as Session['permissionMode'],
          allowedTools: s.allowedTools,
          claudeProcess: null,
          clients: new Set(),
          outputHistory: s.outputHistory || [],
          // Restore claudeSessionId so Claude CLI resumes with full conversation
          // history from its own session storage (not just our 4000-char summary).
          claudeSessionId: s.claudeSessionId ?? null,
          pendingHandoff: s.pendingHandoff,
          restartCount: 0,
          lastRestartAt: null,
          _isStarting: false,
          _stoppedByUser: false,
          _wasActiveBeforeRestart: s.wasActive ?? false,
          _apiRetry: { count: 0 },
          _turnCount: 99, // restored sessions already have a name
          _claudeTurnCount: 0,
          _namingAttempts: 0,
          _processGeneration: 0,
          _noOutputExitCount: 0,
          _lifetimeRestarts: 0,
          isProcessing: false,
          pendingControlRequests: new Map(),
          pendingToolApprovals: new Map(),
          _lastActivityAt: Date.now(),
          planManager: new PlanManager(),
          coordinator: null as unknown as ProcessCoordinator, // wired by SessionManager after restore
        }
        this.sessions.set(session.id, session)
      }

      console.log(`Restored ${data.length} session(s) from disk`)
    } catch (err) {
      console.error('Failed to restore sessions from disk:', err)
    }
  }
}
