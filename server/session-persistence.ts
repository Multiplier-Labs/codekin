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
import type { Session, WsServerMessage } from './types.js'

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
      created: s.created,
      source: s.source,
    provider: s.provider,
      model: s.model,
      permissionMode: s.permissionMode,
      allowedTools: s.allowedTools,
      claudeSessionId: s.claudeSessionId,
      wasActive: s.claudeProcess?.isAlive() ?? false,
      outputHistory: s.outputHistory,
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
      const data: PersistedSession[] = JSON.parse(raw)

      for (const s of data) {
        // Validate worktree paths on restore: if the worktree directory was
        // removed while the server was down, reset to the original repo to
        // prevent spawning Claude in a nonexistent CWD.
        let workingDir = s.workingDir
        let worktreePath = s.worktreePath
        const groupDir = s.groupDir
        if (worktreePath && !existsSync(worktreePath)) {
          const fallback = groupDir ?? workingDir
          if (fallback !== worktreePath && existsSync(fallback)) {
            console.warn(`[restore] Worktree ${worktreePath} no longer exists — resetting session ${s.id} to ${fallback}`)
            workingDir = fallback
            worktreePath = undefined
          } else {
            console.warn(`[restore] Worktree ${worktreePath} and fallback both missing for session ${s.id}`)
            worktreePath = undefined
          }
        }

        const session: Session = {
          id: s.id,
          name: s.name,
          workingDir,
          groupDir,
          worktreePath,
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
          restartCount: 0,
          lastRestartAt: null,
          _stoppedByUser: false,
          _wasActiveBeforeRestart: s.wasActive ?? false,
          _apiRetry: { count: 0 },
          _turnCount: 99, // restored sessions already have a name
          _claudeTurnCount: 0,
          _namingAttempts: 0,
          isProcessing: false,
          pendingControlRequests: new Map(),
          pendingToolApprovals: new Map(),
          _lastActivityAt: Date.now(),
          planManager: new PlanManager(),
        }
        this.sessions.set(session.id, session)
      }

      console.log(`Restored ${data.length} session(s) from disk`)
    } catch (err) {
      console.error('Failed to restore sessions from disk:', err)
    }
  }
}
