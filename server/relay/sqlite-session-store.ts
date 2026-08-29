/**
 * express-session store backed by the control-plane SQLite database.
 *
 * TTL is derived from `cookie.originalMaxAge`, not `cookie.maxAge`: with
 * rolling sessions, maxAge is the *remaining* time and would shrink the TTL
 * on every renewal (same gotcha Gitnook's store documents).
 */

import { Store } from 'express-session'
import type { SessionData } from 'express-session'
import type Database from 'better-sqlite3'

/** Fallback TTL when the session cookie has no maxAge: 30 days. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** How often expired rows are swept. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export class SqliteSessionStore extends Store {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Database.Database) {
    super()
    this.cleanupTimer = setInterval(() => { this.deleteExpired(); }, CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  private ttlMs(session: SessionData): number {
    const original = session.cookie.originalMaxAge
    return typeof original === 'number' && original > 0 ? original : DEFAULT_TTL_MS
  }

  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const row = this.db
        .prepare('SELECT sess, expire FROM web_sessions WHERE sid = ?')
        .get(sid) as { sess: string; expire: number } | undefined
      if (!row || row.expire <= Date.now()) {
        callback(null, null)
        return
      }
      callback(null, JSON.parse(row.sess) as SessionData)
    } catch (err) {
      callback(err)
    }
  }

  set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expire = Date.now() + this.ttlMs(session)
      this.db
        .prepare(
          `INSERT INTO web_sessions (sid, sess, expire) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`,
        )
        .run(sid, JSON.stringify(session), expire)
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid)
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  /** Destroy every web session belonging to a user. Returns the number removed. */
  destroyUserSessions(userId: string): number {
    const rows = this.db.prepare('SELECT sid, sess FROM web_sessions').all() as Array<{ sid: string; sess: string }>
    const ids: string[] = []
    for (const row of rows) {
      try {
        const data = JSON.parse(row.sess) as { user?: { id?: unknown } }
        if (data.user?.id === userId) ids.push(row.sid)
      } catch {
        // Corrupt sessions are ignored here and handled as invalid by get().
      }
    }
    const remove = this.db.transaction((sessionIds: string[]) => {
      const statement = this.db.prepare('DELETE FROM web_sessions WHERE sid = ?')
      for (const sid of sessionIds) statement.run(sid)
    })
    remove(ids)
    return ids.length
  }

  touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expire = Date.now() + this.ttlMs(session)
      this.db.prepare('UPDATE web_sessions SET expire = ? WHERE sid = ?').run(expire, sid)
      callback?.()
    } catch (err) {
      callback?.(err)
    }
  }

  /** Remove expired sessions. Exposed for tests. */
  deleteExpired(): void {
    try {
      this.db.prepare('DELETE FROM web_sessions WHERE expire <= ?').run(Date.now())
    } catch {
      // sweep failures are non-fatal; rows are also filtered on read
    }
  }

  /** Stop the cleanup timer (tests / graceful shutdown). */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
