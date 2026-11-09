/**
 * Replay protection for GitHub deliveries that arrive through the relay.
 *
 * GitHub's HMAC signature proves a delivery is genuine, but it carries no
 * timestamp. A relay that saw a delivery could send it again later, and the
 * local server only remembers delivery ids for an hour. The connector sits
 * between the relay and the machine, so it is the right place to refuse
 * replays:
 *
 * - a delivery is accepted once, keyed on the SHA-256 of its body: the bytes
 *   GitHub's HMAC covers. (The `x-github-delivery` id is not covered, so a
 *   relay could resend a captured body under a fresh id.)
 * - a dated event is remembered until RETENTION_MS after the later of its
 *   own timestamp and when it was accepted, and one whose timestamp is older
 *   than RETENTION_MS is refused, so a replay after it has been forgotten
 *   fails too (and a machine clock behind GitHub's can't shorten that)
 * - an undated event can't be aged, so it is remembered until the undated
 *   cap pushes it out (no undated event starts a session)
 *
 * The history is a SQLite file, so it survives restarts and is shared by
 * every connector on the machine (CLI and embedded). A body is claimed
 * before it reaches the local server, in one transaction, so two connectors
 * can't both forward it; the claim is released if the local server refuses
 * the delivery, so a forged frame (which the HMAC check rejects) cannot block
 * the genuine one.
 *
 * It fails closed. History that can't be read or written refuses every
 * delivery. History that is lost (a new or corrupt file) is started again in
 * recovery: events dated before it started can't be checked against what was
 * forgotten, so they are refused.
 */

import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/** How long a delivery is remembered, and the oldest event accepted. */
export const WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Slack for GitHub's clock and delivery delay when history restarts. */
export const WEBHOOK_RECOVERY_SLACK_MS = 5 * 60 * 1000

/** Undated deliveries remembered, oldest dropped first. */
const MAX_UNDATED = 20_000

/**
 * Dated deliveries remembered. Far above what the relay's per-machine rate
 * allows in a week; at the bound new deliveries are refused, never an
 * unexpired one forgotten.
 */
const MAX_DATED = 2_000_000

/** Payload objects whose `updated_at` dates the event. */
const DATED_OBJECTS = ['workflow_run', 'workflow_job', 'check_run', 'check_suite', 'pull_request', 'issue'] as const

/**
 * `deliveryId` is the replay key to pass to record() or release(): the body's
 * hash, prefixed `u:` for undated events.
 */
export type WebhookGuardVerdict = { ok: true; deliveryId: string } | { ok: false; reason: string }

/** Prefix for undated events, which are never aged out. */
const UNDATED = 'u:'

export function defaultWebhookGuardFile(home = homedir()): string {
  return join(home, '.config', 'codekin', 'relay-webhook-deliveries.sqlite')
}

/** The JSON history kept before 0.11.1, imported once. */
function legacyFile(file: string): string | null {
  return file.endsWith('.sqlite') ? `${file.slice(0, -'.sqlite'.length)}.json` : null
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS webhook_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), history_since INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    key TEXT PRIMARY KEY, dated INTEGER NOT NULL, recorded_at INTEGER NOT NULL, event_at INTEGER,
    accepted INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webhook_age ON webhook_deliveries(dated, recorded_at);
`

export class WebhookReplayGuard {
  /** Kept open only for an in-memory history (file === null, tests and embedding). */
  private memory: Database.Database | null = null

  constructor(
    private readonly file: string | null = defaultWebhookGuardFile(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Decide whether a forwarded delivery may reach the local server, and if so
   * claim it: until record() or release(), no other connector forwards it.
   */
  check(headers: Record<string, string> | undefined, body: Buffer | undefined): WebhookGuardVerdict {
    const deliveryId = headers?.['x-github-delivery']
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      return { ok: false, reason: 'Delivery has no id' }
    }
    const eventAt = eventTimestamp(body)
    const key = `${eventAt === null ? UNDATED : ''}${createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex')}`
    const now = this.now()
    try {
      return this.withDatabase(db => {
        this.prune(db, now)
        if (db.prepare('SELECT 1 FROM webhook_deliveries WHERE key = ?').get(key)) {
          return { ok: false, reason: 'Delivery was already accepted' }
        }
        if (eventAt !== null && now - eventAt > WEBHOOK_RETENTION_MS) {
          return { ok: false, reason: 'Delivery is older than the replay window' }
        }
        const { history_since: since } = db.prepare('SELECT history_since FROM webhook_meta WHERE id = 1').get() as { history_since: number }
        if (eventAt !== null && eventAt < since - WEBHOOK_RECOVERY_SLACK_MS) {
          return { ok: false, reason: 'Delivery is older than this computer\'s replay history' }
        }
        if (eventAt !== null) {
          const { count } = db.prepare('SELECT count(*) AS count FROM webhook_deliveries WHERE dated = 1').get() as { count: number }
          if (count >= MAX_DATED) return { ok: false, reason: 'Replay history is full' }
        }
        db.prepare('INSERT INTO webhook_deliveries(key, dated, recorded_at, event_at, accepted) VALUES (?, ?, ?, ?, 0)')
          .run(key, eventAt === null ? 0 : 1, now, eventAt)
        return { ok: true, deliveryId: key }
      })
    } catch (err) {
      console.warn('[connector] Webhook replay history unavailable:', err instanceof Error ? err.message : err)
      return { ok: false, reason: 'Replay history is unavailable on this computer' }
    }
  }

  /** The local server accepted the claimed delivery: remember it. */
  record(deliveryId: string): void {
    try {
      this.withDatabase(db => {
        db.prepare('UPDATE webhook_deliveries SET accepted = 1, recorded_at = ? WHERE key = ?').run(this.now(), deliveryId)
        const { count } = db.prepare('SELECT count(*) AS count FROM webhook_deliveries WHERE dated = 0').get() as { count: number }
        if (count > MAX_UNDATED) {
          db.prepare(`DELETE FROM webhook_deliveries WHERE key IN (
            SELECT key FROM webhook_deliveries WHERE dated = 0 ORDER BY recorded_at LIMIT ?)`).run(count - MAX_UNDATED)
        }
      })
    } catch (err) {
      // The claim stays in place, so the delivery still counts as seen.
      console.warn('[connector] Could not confirm a webhook delivery:', err instanceof Error ? err.message : err)
    }
  }

  /** The local server refused the claimed delivery (bad signature, error): let a genuine one through. */
  release(deliveryId: string): void {
    try {
      this.withDatabase(db => {
        db.prepare('DELETE FROM webhook_deliveries WHERE key = ? AND accepted = 0').run(deliveryId)
      })
    } catch (err) {
      console.warn('[connector] Could not release a webhook delivery:', err instanceof Error ? err.message : err)
    }
  }

  private prune(db: Database.Database, now: number): void {
    // Dated rows live until the window has passed for both the event and its acceptance.
    const cutoff = now - WEBHOOK_RETENTION_MS
    db.prepare('DELETE FROM webhook_deliveries WHERE dated = 1 AND recorded_at < ? AND coalesce(event_at, 0) < ?').run(cutoff, cutoff)
  }

  private withDatabase<T>(fn: (db: Database.Database) => T): T {
    if (!this.file) {
      if (!this.memory) {
        this.memory = new Database(':memory:')
        this.prepare(this.memory)
      }
      const db = this.memory
      return db.transaction(() => fn(db)).immediate()
    }
    mkdirSync(dirname(this.file), { recursive: true })
    let db = this.open(this.file)
    try {
      return db.transaction(() => fn(db)).immediate()
    } catch (err) {
      if (!isCorrupt(err)) throw err
      // A corrupt history is set aside, and a new one starts in recovery.
      db.close()
      this.setAside(this.file)
      db = this.open(this.file)
      return db.transaction(() => fn(db)).immediate()
    } finally {
      db.close()
    }
  }

  private open(file: string): Database.Database {
    const db = new Database(file, { timeout: 1000 })
    try {
      chmodSync(file, 0o600)
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = FULL')
      this.prepare(db)
      return db
    } catch (err) {
      db.close()
      if (!isCorrupt(err)) throw err
      this.setAside(file)
      return this.open(file)
    }
  }

  private setAside(file: string): void {
    renameSync(file, `${file}.corrupt-${this.now()}`)
    console.warn('[connector] Webhook replay history was corrupt; started again (deliveries dated before now are refused)')
  }

  /**
   * Create the tables, and on a new history record when it starts. The old
   * JSON history is imported once, but it may have dropped entries still in
   * the window, so a new history starts now either way.
   */
  private prepare(db: Database.Database): void {
    db.exec(SCHEMA)
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM webhook_meta WHERE id = 1').get()) return
      const legacy = this.file ? legacyFile(this.file) : null
      if (legacy) importLegacy(db, legacy)
      db.prepare('INSERT INTO webhook_meta(id, history_since) VALUES (1, ?)').run(this.now())
    }).immediate()
  }
}

/** Import the JSON history kept before 0.11.1, once, then set it aside. */
function importLegacy(db: Database.Database, file: string): void {
  if (!existsSync(file)) return
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { deliveries?: unknown } | null
    if (parsed && typeof parsed.deliveries === 'object' && parsed.deliveries !== null) {
      const insert = db.prepare('INSERT OR IGNORE INTO webhook_deliveries(key, dated, recorded_at, event_at, accepted) VALUES (?, ?, ?, NULL, 1)')
      for (const [key, at] of Object.entries(parsed.deliveries as Record<string, unknown>)) {
        if (typeof at === 'number') insert.run(key, key.startsWith(UNDATED) ? 0 : 1, at)
      }
    }
  } catch {
    // Unreadable: nothing to import; the new history starts in recovery anyway.
  }
  try { renameSync(file, `${file}.migrated`) } catch { /* imported; the file is left for the user */ }
}

function isCorrupt(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB'
}

/**
 * When the event happened, from the payload itself, or null when the payload
 * names no dated object (then only the delivery id protects it).
 */
export function eventTimestamp(body: Buffer | undefined): number | null {
  if (!body || body.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf-8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  for (const key of DATED_OBJECTS) {
    const obj = (parsed as Record<string, unknown>)[key]
    if (obj && typeof obj === 'object') {
      const updated = (obj as Record<string, unknown>).updated_at
      if (typeof updated === 'string') {
        const ms = Date.parse(updated)
        if (!Number.isNaN(ms)) return ms
      }
    }
  }
  return null
}
