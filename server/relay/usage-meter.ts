/**
 * Relayed-traffic metering and the daily bandwidth quota
 * (docs/RELAY-HARDENING.md §6).
 *
 * The hubs report every frame they receive, from machines and from browsers,
 * against the workspace that owns the machine. Counts live in memory and are
 * flushed to `usage_daily` once a minute: a crash loses at most a minute of
 * counting, which is fine for quotas and capacity planning (this is not a
 * billing meter).
 *
 * Over `relayedBytesPerWorkspacePerDay`, traffic is slowed, never cut off: a
 * per-socket token bucket at `throttledBytesPerSecond` says how long the hub
 * should stop *reading* that socket. TCP backpressure then holds the excess
 * at the sender, so the relay buffers nothing extra.
 */

import type Database from 'better-sqlite3'
import type { EntitlementsProvider } from './quotas.js'

/** Throttled rate when a workspace has no `throttledBytesPerSecond` of its own. */
export const DEFAULT_THROTTLE_BYTES_PER_SECOND = 64 * 1024
/** Longest single pause, so heartbeats keep flowing and idle timeouts never fire. */
export const MAX_PAUSE_MS = 5_000
export const USAGE_RETENTION_DAYS = 400

export type Direction = 'b2m' | 'm2b'

interface Counters {
  b2m: number
  m2b: number
  frames: number
}

interface Bucket {
  tokens: number
  at: number
}

export interface UsageMeterOptions {
  flushIntervalMs?: number
  now?: () => number
  log?: (line: string) => void
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export class UsageMeter {
  private day: string
  private pending = new Map<string, Counters>()
  /** Bytes already in usage_daily for today, per workspace (loaded lazily). */
  private flushed = new Map<string, number>()
  private buckets = new WeakMap<object, Bucket>()
  private throttledToday = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private db: Database.Database,
    private entitlements: EntitlementsProvider,
    opts: UsageMeterOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (line => { console.warn(line) })
    this.day = utcDay(this.now())
    this.timer = setInterval(() => { this.flush() }, opts.flushIntervalMs ?? 60_000)
    this.timer.unref()
  }

  /**
   * Count one received frame of `bytes` for `workspaceId`. Returns how many
   * milliseconds the caller should stop reading `source` (0 almost always).
   */
  record(workspaceId: string, direction: Direction, bytes: number, source: object): number {
    const now = this.now()
    this.rollDay(now)
    const counters = this.pending.get(workspaceId) ?? { b2m: 0, m2b: 0, frames: 0 }
    counters[direction] += bytes
    counters.frames += 1
    this.pending.set(workspaceId, counters)

    const limits = this.entitlements.limitsFor(workspaceId)
    const limit = limits.relayedBytesPerWorkspacePerDay
    if (limit === undefined || this.todayBytes(workspaceId) <= limit) return 0

    if (!this.throttledToday.has(workspaceId)) {
      this.throttledToday.add(workspaceId)
      this.log(`[relay] workspace ${workspaceId} is over its daily relayed-bytes quota (${limit}); throttling until UTC midnight`)
    }
    const rate = Math.max(1, limits.throttledBytesPerSecond ?? DEFAULT_THROTTLE_BYTES_PER_SECOND)
    const bucket = this.buckets.get(source) ?? { tokens: rate, at: now }
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) / 1000) * rate) - bytes
    bucket.at = now
    this.buckets.set(source, bucket)
    if (bucket.tokens >= 0) return 0
    return Math.min(MAX_PAUSE_MS, Math.ceil((-bucket.tokens / rate) * 1000))
  }

  /** Bytes relayed for a workspace today (UTC), both directions. */
  todayBytes(workspaceId: string): number {
    let base = this.flushed.get(workspaceId)
    if (base === undefined) {
      const row = this.db
        .prepare('SELECT bytes_b2m + bytes_m2b AS total FROM usage_daily WHERE workspace_id = ? AND day = ?')
        .get(workspaceId, this.day) as { total: number } | undefined
      base = row?.total ?? 0
      this.flushed.set(workspaceId, base)
    }
    const p = this.pending.get(workspaceId)
    return base + (p ? p.b2m + p.m2b : 0)
  }

  /** Write pending counts to usage_daily. */
  flush(): void {
    if (this.pending.size === 0) return
    const upsert = this.db.prepare(
      `INSERT INTO usage_daily (workspace_id, day, bytes_b2m, bytes_m2b, frames) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, day) DO UPDATE SET
         bytes_b2m = bytes_b2m + excluded.bytes_b2m,
         bytes_m2b = bytes_m2b + excluded.bytes_m2b,
         frames = frames + excluded.frames`,
    )
    const entries = [...this.pending]
    this.pending.clear()
    try {
      this.db.transaction(() => {
        for (const [workspaceId, c] of entries) upsert.run(workspaceId, this.day, c.b2m, c.m2b, c.frames)
      })()
      // Only once committed: the flushed totals move from pending to base.
      for (const [workspaceId, c] of entries) {
        const base = this.flushed.get(workspaceId)
        if (base !== undefined) this.flushed.set(workspaceId, base + c.b2m + c.m2b)
      }
    } catch (err) {
      // Keep the counts for the next attempt rather than losing them.
      for (const [workspaceId, c] of entries) {
        const p = this.pending.get(workspaceId) ?? { b2m: 0, m2b: 0, frames: 0 }
        this.pending.set(workspaceId, { b2m: p.b2m + c.b2m, m2b: p.m2b + c.m2b, frames: p.frames + c.frames })
      }
      this.log(`[relay] usage flush failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Flush and stop the timer (shutdown). */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  private rollDay(now: number): void {
    const day = utcDay(now)
    if (day === this.day) return
    this.flush() // yesterday's counts stay yesterday's
    this.day = day
    this.flushed.clear()
    this.throttledToday.clear()
  }
}

/** Meter one received frame and, when throttled, stop reading the socket for a while. */
export function meterFrame(
  meter: UsageMeter | undefined,
  socket: { pause(): void; resume(): void; readyState: number },
  workspaceId: string,
  direction: Direction,
  bytes: number,
): void {
  if (!meter) return
  const pauseMs = meter.record(workspaceId, direction, bytes, socket)
  if (pauseMs <= 0) return
  socket.pause()
  setTimeout(() => {
    if (socket.readyState === 1) socket.resume()
  }, pauseMs).unref()
}

/** Drop usage rows older than the retention window. Returns rows removed. */
export function pruneUsage(db: Database.Database, days = USAGE_RETENTION_DAYS, now = Date.now()): number {
  const cutoff = utcDay(now - days * 86_400_000)
  return db.prepare('DELETE FROM usage_daily WHERE day < ?').run(cutoff).changes
}
