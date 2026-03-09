/**
 * Session persistence for Codekin.
 *
 * Handles reading and writing session state to/from disk as JSON.
 * Uses atomic rename to prevent corruption on crash.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import type { Session, WsServerMessage } from './types.js'

const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')
const PERSIST_DEBOUNCE_MS = 2000

/** Shape of a session when serialized to disk (no process refs, Sets→arrays). */
export interface PersistedSession {
  id: string
  name: string
  workingDir: string
  groupDir?: string
  created: string
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow'
  model?: string
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
      created: s.created,
      source: s.source,
      model: s.model,
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
        const session: Session = {
          id: s.id,
          name: s.name,
          workingDir: s.workingDir,
          groupDir: s.groupDir,
          created: s.created,
          source: s.source ?? 'manual',
          model: s.model,
          claudeProcess: null,
          clients: new Set(),
          outputHistory: s.outputHistory || [],
          // Restore claudeSessionId so Claude CLI resumes with full conversation
          // history from its own session storage (not just our 4000-char summary).
          claudeSessionId: s.claudeSessionId ?? null,
          restartCount: 0,
          lastRestartAt: null,
          _stoppedByUser: false,
          _stallTimer: null,
          _wasActiveBeforeRestart: s.wasActive ?? false,
          _apiRetryCount: 0,
          _turnCount: 99, // restored sessions already have a name
          _namingAttempts: 0,
          isProcessing: false,
          pendingControlRequests: new Map(),
          pendingToolApprovals: new Map(),
        }
        this.sessions.set(session.id, session)
      }

      console.log(`Restored ${data.length} session(s) from disk`)
    } catch (err) {
      console.error('Failed to restore sessions from disk:', err)
    }
  }
}
