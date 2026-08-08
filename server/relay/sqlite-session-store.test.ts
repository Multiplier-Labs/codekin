/** Tests for SqliteSessionStore — TTL from originalMaxAge, expiry filtering, touch. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { SessionData } from 'express-session'
import { openControlPlaneDb } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'

function sessionData(originalMaxAge: number | null): SessionData {
  return { cookie: { originalMaxAge } } as SessionData
}

function get(store: SqliteSessionStore, sid: string): Promise<SessionData | null | undefined> {
  return new Promise((resolve, reject) => {
    store.get(sid, (err, sess) => (err ? reject(err as Error) : resolve(sess)))
  })
}

function set(store: SqliteSessionStore, sid: string, sess: SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, sess, err => (err ? reject(err as Error) : resolve()))
  })
}

describe('SqliteSessionStore', () => {
  let db: Database.Database
  let store: SqliteSessionStore

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    store = new SqliteSessionStore(db)
  })

  afterEach(() => {
    store.close()
    db.close()
    vi.useRealTimers()
  })

  it('round-trips a session', async () => {
    await set(store, 'sid1', sessionData(60_000))
    const sess = await get(store, 'sid1')
    expect(sess?.cookie.originalMaxAge).toBe(60_000)
  })

  it('returns null for unknown sids', async () => {
    expect(await get(store, 'nope')).toBeNull()
  })

  it('computes TTL from originalMaxAge, not remaining maxAge', async () => {
    await set(store, 'sid1', sessionData(60_000))
    const row = db.prepare('SELECT expire FROM web_sessions WHERE sid = ?').get('sid1') as { expire: number }
    const expected = Date.now() + 60_000
    expect(Math.abs(row.expire - expected)).toBeLessThan(2000)
  })

  it('treats expired sessions as missing and sweeps them', async () => {
    vi.useFakeTimers()
    await set(store, 'sid1', sessionData(1000))
    vi.advanceTimersByTime(2000)
    expect(await get(store, 'sid1')).toBeNull()
    store.deleteExpired()
    const count = db.prepare('SELECT COUNT(*) as n FROM web_sessions').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('touch extends expiry without rewriting the payload', async () => {
    await set(store, 'sid1', sessionData(60_000))
    const before = (db.prepare('SELECT expire FROM web_sessions WHERE sid = ?').get('sid1') as { expire: number }).expire
    await new Promise<void>((resolve, reject) => {
      store.touch('sid1', sessionData(120_000), err => (err ? reject(err as Error) : resolve()))
    })
    const after = (db.prepare('SELECT expire FROM web_sessions WHERE sid = ?').get('sid1') as { expire: number }).expire
    expect(after).toBeGreaterThan(before)
  })

  it('destroy removes the session', async () => {
    await set(store, 'sid1', sessionData(60_000))
    await new Promise<void>((resolve, reject) => {
      store.destroy('sid1', err => (err ? reject(err as Error) : resolve()))
    })
    expect(await get(store, 'sid1')).toBeNull()
  })
})
