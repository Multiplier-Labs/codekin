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
 * at the sender, so the relay buffers nothing extra. Heartbeat checks account
 * for these deliberate pauses; outbound keepalives continue during them.
 */

import type Database from 'better-sqlite3'
import type { EntitlementsProvider } from './quotas.js'

/** Throttled rate when a workspace has no `throttledBytesPerSecond` of its own. */
export const DEFAULT_THROTTLE_BYTES_PER_SECOND = 64 * 1024
/** Recheck quota state and send an outbound keepalive while reads are paused. */
export const PAUSE_CHECK_MS = 1_000
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
  private pending = new Map<string, Map<string, Counters>>()
  /** Bytes already in usage_daily for today, per workspace (loaded lazily). */
  private flushed = new Map<string, number>()
  private buckets = new WeakMap<object, Bucket>()
  private throttledToday = new Set<string>()
  /** Workspaces slowed regardless of their daily bytes (open `throttle` abuse flags). */
  private forced = new Set<string>()
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
    const daily = this.pending.get(this.day) ?? new Map<string, Counters>()
    this.pending.set(this.day, daily)
    const counters = daily.get(workspaceId) ?? { b2m: 0, m2b: 0, frames: 0 }
    counters[direction] += bytes
    counters.frames += 1
    daily.set(workspaceId, counters)

    const limits = this.entitlements.limitsFor(workspaceId)
    const limit = limits.relayedBytesPerWorkspacePerDay
    const forced = this.forced.has(workspaceId)
    if (!forced && (limit === undefined || this.todayBytes(workspaceId) <= limit)) return 0

    if (!forced && !this.throttledToday.has(workspaceId)) {
      this.throttledToday.add(workspaceId)
      this.log(`[relay] workspace ${workspaceId} is over its daily relayed-bytes quota (${limit}); throttling until UTC midnight`)
    }
    const rate = Math.max(1, limits.throttledBytesPerSecond ?? DEFAULT_THROTTLE_BYTES_PER_SECOND)
    const bucket = this.buckets.get(source) ?? { tokens: rate, at: now }
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) / 1000) * rate) - bytes
    bucket.at = now
    this.buckets.set(source, bucket)
    if (bucket.tokens >= 0) return 0
    return Math.ceil((-bucket.tokens / rate) * 1000)
  }

  /** Bytes relayed for a workspace today (UTC), both directions. */
  todayBytes(workspaceId: string): number {
    this.rollDay(this.now())
    let base = this.flushed.get(workspaceId)
    if (base === undefined) {
      const row = this.db
        .prepare('SELECT bytes_b2m + bytes_m2b AS total FROM usage_daily WHERE workspace_id = ? AND day = ?')
        .get(workspaceId, this.day) as { total: number } | undefined
      base = row?.total ?? 0
      this.flushed.set(workspaceId, base)
    }
    const p = this.pending.get(this.day)?.get(workspaceId)
    return base + (p ? p.b2m + p.m2b : 0)
  }

  /** Replace the set of workspaces throttled by the abuse queue. */
  setForcedThrottle(workspaceIds: Set<string>): void {
    this.forced = new Set(workspaceIds)
  }

  /** Remaining debt, without charging another frame. Quota changes can release a pause. */
  pauseRemaining(workspaceId: string, source: object): number {
    const now = this.now()
    this.rollDay(now)
    const limits = this.entitlements.limitsFor(workspaceId)
    const limit = limits.relayedBytesPerWorkspacePerDay
    if (!this.forced.has(workspaceId) && (limit === undefined || this.todayBytes(workspaceId) <= limit)) {
      this.buckets.delete(source)
      return 0
    }
    const bucket = this.buckets.get(source)
    if (!bucket) return 0
    const rate = Math.max(1, limits.throttledBytesPerSecond ?? DEFAULT_THROTTLE_BYTES_PER_SECOND)
    return Math.max(0, Math.ceil((-bucket.tokens / rate) * 1000 - (now - bucket.at)))
  }

  /** Write all pending days atomically; leave them intact on any failure. */
  flush(): void {
    if (this.pending.size === 0) return
    try {
      const upsert = this.db.prepare(
        `INSERT INTO usage_daily (workspace_id, day, bytes_b2m, bytes_m2b, frames) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, day) DO UPDATE SET
           bytes_b2m = bytes_b2m + excluded.bytes_b2m,
           bytes_m2b = bytes_m2b + excluded.bytes_m2b,
           frames = frames + excluded.frames`,
      )
      this.db.transaction(() => {
        for (const [day, daily] of this.pending) {
          for (const [workspaceId, c] of daily) upsert.run(workspaceId, day, c.b2m, c.m2b, c.frames)
        }
      })()
      for (const [workspaceId, c] of this.pending.get(this.day) ?? []) {
        const base = this.flushed.get(workspaceId)
        if (base !== undefined) this.flushed.set(workspaceId, base + c.b2m + c.m2b)
      }
      this.pending.clear()
    } catch (err) {
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

interface MeteredSocket {
  pause(): void
  resume(): void
  send(data: string): void
  close(code: number, reason: string): void
  readyState: number
  bufferedAmount: number
  once(event: 'close', listener: () => void): unknown
  removeListener(event: 'close', listener: () => void): unknown
}

const paused = new WeakSet<MeteredSocket>()

/** A deliberate read pause must not be mistaken for a missed heartbeat. */
export function isMeterPaused(socket: MeteredSocket): boolean {
  return paused.has(socket)
}

/** One scheduler per socket. Rechecking never admits data until the full debt is paid. */
export function meterFrame(
  meter: UsageMeter | undefined,
  socket: MeteredSocket,
  workspaceId: string,
  direction: Direction,
  bytes: number,
): void {
  if (!meter) return
  const delay = meter.record(workspaceId, direction, bytes, socket)
  if (delay <= 0 || paused.has(socket)) return
  paused.add(socket)
  socket.pause()
  let timer: ReturnType<typeof setTimeout>
  const cancel = () => {
    clearTimeout(timer)
    paused.delete(socket)
    socket.removeListener('close', cancel)
  }
  const tick = () => {
    try {
      if (socket.readyState !== 1) { cancel(); return }
      const remaining = meter.pauseRemaining(workspaceId, socket)
      if (remaining <= 0) { cancel(); socket.resume(); return }
      // The hosted client's resume probe accepts any incoming frame as liveness.
      // Keep that path and reverse-proxy idle timers alive without reading data.
      if (socket.bufferedAmount === 0) socket.send('{"version":1,"kind":"pong","payload":{}}')
      timer = setTimeout(tick, Math.min(PAUSE_CHECK_MS, remaining))
      timer.unref()
    } catch {
      cancel()
      socket.close(1011, 'traffic accounting unavailable')
    }
  }
  socket.once('close', cancel)
  timer = setTimeout(tick, Math.min(PAUSE_CHECK_MS, delay))
  timer.unref()
}

/** Drop usage rows older than the retention window. Returns rows removed. */
export function pruneUsage(db: Database.Database, days = USAGE_RETENTION_DAYS, now = Date.now()): number {
  const cutoff = utcDay(now - days * 86_400_000)
  return db.prepare('DELETE FROM usage_daily WHERE day < ?').run(cutoff).changes
}
