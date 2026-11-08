/** Durable, account-scoped nonce consumption, independent of audit rotation.
 * SQLite transactions serialize simultaneous CLI/embedded connectors; FULL
 * synchronization commits the nonce before any action can reach the server.
 */
import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { INTENT_MAX_SKEW_MS } from './intent-actions.js'
import type { IntentRefusal } from './intent-actions.js'

export const REPLAY_TTL_MS = 2 * INTENT_MAX_SKEW_MS
export const REPLAY_CACHE_MAX = 50_000

export class IntentReplayStore {
  constructor(
    private readonly file: string,
    private readonly machineId: string,
    private readonly limit = REPLAY_CACHE_MAX,
  ) {}

  /** Initialize before this verifier writes any audit entries. */
  initialize(now: number, fresh = false): boolean {
    try {
      this.withDatabase(db => { this.initializeMachine(db, now, fresh) })
      return true
    } catch { return false }
  }

  private initializeMachine(db: Database.Database, now: number, fresh = false): void {
    if (db.prepare('SELECT 1 FROM replay_machines WHERE machine_id = ?').get(this.machineId)) return
    // Old releases used an incomplete audit tail. Its missing nonces cannot
    // be reconstructed reliably: once on upgrade, wait out their entire
    // validity window. Persist the deadline so restarts don't extend it.
    db.prepare('INSERT INTO replay_machines(machine_id, recover_until) VALUES (?, ?)')
      .run(this.machineId, fresh ? 0 : now + REPLAY_TTL_MS)
  }

  consume(userId: string, nonce: string, now: number): IntentRefusal | null {
    try {
      return this.withDatabase(db => {
        this.initializeMachine(db, now)
        const recovery = db.prepare('SELECT recover_until FROM replay_machines WHERE machine_id = ?')
          .get(this.machineId) as { recover_until: number }
        if (now <= recovery.recover_until) return 'intent_replay_unavailable'
        db.prepare('DELETE FROM replay_nonces WHERE expires_at < ?').run(now)
        if (db.prepare('SELECT 1 FROM replay_nonces WHERE machine_id = ? AND user_id = ? AND nonce = ?')
          .get(this.machineId, userId, nonce)) return 'intent_replayed'
        const { count } = db.prepare('SELECT count(*) AS count FROM replay_nonces WHERE machine_id = ?')
          .get(this.machineId) as { count: number }
        if (count >= this.limit) return 'intent_rate_limited'
        db.prepare('INSERT INTO replay_nonces(machine_id, user_id, nonce, expires_at) VALUES (?, ?, ?, ?)')
          .run(this.machineId, userId, nonce, now + REPLAY_TTL_MS)
        return null
      })
    } catch {
      // Includes failed commits, corrupt databases, and unavailable storage.
      return 'intent_replay_unavailable'
    }
  }

  private withDatabase<T>(fn: (db: Database.Database) => T): T {
    mkdirSync(dirname(this.file), { recursive: true })
    const db = new Database(this.file, { timeout: 1000 })
    try {
      chmodSync(this.file, 0o600)
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = FULL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS replay_machines (
          machine_id TEXT PRIMARY KEY, recover_until INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS replay_nonces (
          machine_id TEXT NOT NULL, user_id TEXT NOT NULL, nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL, PRIMARY KEY(machine_id, user_id, nonce)
        );
        CREATE INDEX IF NOT EXISTS replay_expiry ON replay_nonces(expires_at);
      `)
      return db.transaction(() => fn(db)).immediate()
    } finally { db.close() }
  }
}
