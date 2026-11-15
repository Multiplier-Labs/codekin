/**
 * Session persistence for Codekin.
 *
 * Handles reading and writing session state to/from disk as JSON.
 * Uses atomic rename to prevent corruption on crash.
 *
 * `sessions.json` holds metadata only. Each session's output history lives in
 * its own file under `session-history/`, rewritten only when that history
 * changed. Histories run to megabytes per session, and the writes are
 * synchronous: serializing every history on every persist blocked the event
 * loop for most of a second on a busy machine, which delayed every
 * `session_created` (three persists for a worktree session) and stalled
 * every live stream.
 *
 * A session saved with its history inline (older versions, or a history file
 * that could not be written) restores from the inline copy; the next persist
 * moves it into its own file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import { PlanManager } from './plan-manager.js'
import type { ProcessCoordinator } from './process-coordinator.js'
import type { Session, WsServerMessage } from './types.js'
import { jsonParse } from './json-parse.js'

const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')
const HISTORY_DIR = join(DATA_DIR, 'session-history')
const PERSIST_DEBOUNCE_MS = 2000

/** Ids that are safe as file names; any other id keeps its history inline. */
const FILE_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function historyFile(id: string): string {
  return join(HISTORY_DIR, `${id}.json`)
}

/**
 * Enough of a history's state to tell whether it changed since it was
 * written. History is appended to (push), trimmed from the front (splice),
 * replaced (filter), and its last `output` entry grows in place as chunks
 * merge; each of those changes the array, its length, its last entry, or that
 * entry's text length.
 */
interface HistoryMark {
  ref: WsServerMessage[]
  length: number
  last: WsServerMessage | undefined
  lastSize: number
}

function markOf(history: WsServerMessage[]): HistoryMark {
  const last: WsServerMessage | undefined = history.length ? history[history.length - 1] : undefined
  return { ref: history, length: history.length, last, lastSize: last?.type === 'output' ? last.data.length : 0 }
}

function unchanged(mark: HistoryMark | undefined, history: WsServerMessage[]): boolean {
  if (!mark) return false
  const now = markOf(history)
  return mark.ref === now.ref && mark.length === now.length && mark.last === now.last && mark.lastSize === now.lastSize
}

function writeAtomic(file: string, content: string): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
}

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
  reviewComments?: import('./types.js').ReviewComment[]
  archivedAt?: string
  controller?: import('./types.js').SessionController
  created: string
  lastTurnAt?: string
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  provider?: import('./coding-process.js').CodingProvider
  model?: string
  effort?: string
  permissionMode?: string
  /** Additional tools to pre-approve via --allowedTools. */
  allowedTools?: string[]
  claudeSessionId: string | null
  wasActive?: boolean
  /** Inline history: older files, or a session whose history file could not be written. */
  outputHistory?: WsServerMessage[]
  /** Handoff awaiting injection after a carry-context provider switch. */
  pendingHandoff?: import('./handoff-manager.js').Handoff
  /** Org manifest awaiting injection into the first message. */
  pendingOrgManifest?: string
  /** Folders attached beside the primary place. */
  addDirs?: string[]
  /** Attach/detach notes awaiting injection into the next message. */
  pendingPlaceNotes?: string[]
}

export class SessionPersistence {
  private sessions: Map<string, Session>
  private _persistTimer: ReturnType<typeof setTimeout> | null = null
  /** Sessions whose history is on disk in its own file, and its state when written. */
  private historyMarks = new Map<string, HistoryMark>()

  constructor(sessions: Map<string, Session>) {
    this.sessions = sessions
  }

  /**
   * Write each changed history to its own file. Returns the ids whose history
   * is not in a file and so must stay inline in `sessions.json`.
   */
  private writeHistories(): Set<string> {
    const inline = new Set<string>()
    try {
      mkdirSync(HISTORY_DIR, { recursive: true })
    } catch (err) {
      console.error('Failed to create the session history folder:', err)
      for (const id of this.sessions.keys()) inline.add(id)
      return inline
    }
    for (const s of this.sessions.values()) {
      if (!FILE_SAFE_ID.test(s.id)) { inline.add(s.id); continue }
      if (unchanged(this.historyMarks.get(s.id), s.outputHistory)) continue
      try {
        writeAtomic(historyFile(s.id), JSON.stringify(s.outputHistory))
        this.historyMarks.set(s.id, markOf(s.outputHistory))
      } catch (err) {
        console.error(`Failed to persist history for session ${s.id}:`, err)
        this.historyMarks.delete(s.id)
        inline.add(s.id)
      }
    }
    return inline
  }

  /** Remove the history files of sessions that are gone (deleted or archived). */
  private removeStaleHistories(): void {
    for (const id of this.historyMarks.keys()) {
      if (this.sessions.has(id)) continue
      this.historyMarks.delete(id)
      try {
        unlinkSync(historyFile(id))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Failed to remove history for session ${id}:`, err)
      }
    }
  }

  /** Write all sessions to disk as JSON (atomic rename to prevent corruption). */
  persistToDisk(): void {
    // Histories first: sessions.json stops carrying a history only once its file exists.
    const inline = this.writeHistories()
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
      // `stale` is computed when listed, never stored.
      reviewComments: s.reviewComments?.map(c => { const copy = { ...c }; delete copy.stale; return copy }),
      archivedAt: s.archivedAt,
      controller: s.controller,
      created: s.created,
      lastTurnAt: s.lastTurnAt,
      source: s.source,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      permissionMode: s.permissionMode,
      allowedTools: s.allowedTools,
      claudeSessionId: s.claudeSessionId,
      wasActive: s.claudeProcess?.isAlive() ?? false,
      ...(inline.has(s.id) ? { outputHistory: s.outputHistory } : {}),
      pendingHandoff: s.pendingHandoff,
      pendingOrgManifest: s.pendingOrgManifest,
      addDirs: s.addDirs,
      pendingPlaceNotes: s.pendingPlaceNotes,
    }))

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeAtomic(SESSIONS_FILE, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error('Failed to persist sessions:', err)
      return
    }
    this.removeStaleHistories()
  }

  /** A restored session's history: inline if saved that way, else from its own file. */
  private readHistory(s: PersistedSession): WsServerMessage[] {
    if (s.outputHistory) return s.outputHistory
    if (!FILE_SAFE_ID.test(s.id)) return []
    const file = historyFile(s.id)
    if (!existsSync(file)) return []
    try {
      const history = jsonParse(readFileSync(file, 'utf-8')) as WsServerMessage[]
      if (!Array.isArray(history)) return []
      this.historyMarks.set(s.id, markOf(history))
      return history
    } catch (err) {
      console.warn(`Failed to restore history for session ${s.id}:`, err)
      return []
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
          reviewComments: s.reviewComments,
          archivedAt: s.archivedAt,
          controller: s.controller,
          created: s.created,
          lastTurnAt: s.lastTurnAt,
          source: s.source ?? 'manual',
          provider: s.provider ?? 'claude',
          model: s.model,
          effort: s.effort,
          permissionMode: s.permissionMode as Session['permissionMode'],
          allowedTools: s.allowedTools,
          claudeProcess: null,
          clients: new Set(),
          outputHistory: this.readHistory(s),
          // Restore claudeSessionId so Claude CLI resumes with full conversation
          // history from its own session storage (not just our 4000-char summary).
          claudeSessionId: s.claudeSessionId ?? null,
          pendingHandoff: s.pendingHandoff,
          pendingOrgManifest: s.pendingOrgManifest,
          addDirs: s.addDirs,
          pendingPlaceNotes: s.pendingPlaceNotes,
          restartCount: 0,
          lastRestartAt: null,
          _isStarting: false,
          _stoppedByUser: false,
          _wasActiveBeforeRestart: s.wasActive ?? false,
          _apiRetry: { count: 0 },
          _turnCount: 99, // restored sessions already have a name
          _claudeTurnCount: 0,
          _namingAttempts: 0,
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
