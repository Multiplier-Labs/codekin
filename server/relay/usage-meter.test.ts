/** Tests for usage metering and the daily bandwidth throttle. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb } from './control-plane-db.js'
import { parseQuotas, UNLIMITED } from './quotas.js'
import { MAX_PAUSE_MS, meterFrame, pruneUsage, UsageMeter, utcDay } from './usage-meter.js'

const DAY1 = Date.parse('2026-11-08T12:00:00Z')

function rows(db: Database.Database) {
  return db.prepare('SELECT workspace_id, day, bytes_b2m, bytes_m2b, frames FROM usage_daily ORDER BY day, workspace_id').all()
}

describe('UsageMeter', () => {
  let db: Database.Database
  let now: number
  let meter: UsageMeter
  const log = vi.fn()
  const source = {}

  const make = (quotas: unknown = undefined) => {
    meter = new UsageMeter(db, quotas ? parseQuotas(quotas) : UNLIMITED, { now: () => now, log, flushIntervalMs: 3_600_000 })
  }

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    now = DAY1
    log.mockClear()
  })
  afterEach(() => {
    meter.close()
    db.close()
  })

  it('counts both directions per workspace and flushes them, adding to earlier flushes', () => {
    make()
    meter.record('ws1', 'm2b', 1000, source)
    meter.record('ws1', 'b2m', 200, source)
    meter.record('ws2', 'm2b', 5, source)
    expect(meter.todayBytes('ws1')).toBe(1200)
    meter.flush()
    meter.record('ws1', 'm2b', 300, source)
    meter.flush()
    expect(rows(db)).toEqual([
      { workspace_id: 'ws1', day: '2026-11-08', bytes_b2m: 200, bytes_m2b: 1300, frames: 3 },
      { workspace_id: 'ws2', day: '2026-11-08', bytes_b2m: 0, bytes_m2b: 5, frames: 1 },
    ])
    expect(meter.todayBytes('ws1')).toBe(1500)
  })

  it("picks up today's earlier total after a restart", () => {
    make()
    meter.record('ws1', 'm2b', 700, source)
    meter.close()
    make()
    expect(meter.todayBytes('ws1')).toBe(700)
  })

  it('keeps counts on the day they happened across UTC midnight', () => {
    make()
    meter.record('ws1', 'm2b', 100, source)
    now = Date.parse('2026-11-09T00:00:01Z')
    meter.record('ws1', 'm2b', 7, source)
    meter.flush()
    expect(rows(db)).toEqual([
      { workspace_id: 'ws1', day: '2026-11-08', bytes_b2m: 0, bytes_m2b: 100, frames: 1 },
      { workspace_id: 'ws1', day: '2026-11-09', bytes_b2m: 0, bytes_m2b: 7, frames: 1 },
    ])
    expect(meter.todayBytes('ws1')).toBe(7)
  })

  it('never throttles without a daily limit, or under it', () => {
    make({ workspaces: { capped: { relayedBytesPerWorkspacePerDay: 10_000 } } })
    expect(meter.record('free', 'm2b', 50_000_000, source)).toBe(0)
    expect(meter.record('capped', 'm2b', 9_000, source)).toBe(0)
  })

  it('slows a workspace over its daily bytes to the throttled rate, per connection, and logs it once', () => {
    make({ default: { relayedBytesPerWorkspacePerDay: 1000, throttledBytesPerSecond: 1000 } })
    expect(meter.record('ws', 'm2b', 1000, source)).toBe(0)
    // Over the limit now: the first second's worth passes, then each byte costs 1 ms.
    expect(meter.record('ws', 'm2b', 1000, source)).toBe(0)
    expect(meter.record('ws', 'm2b', 500, source)).toBe(500)
    // Another connection has its own bucket.
    expect(meter.record('ws', 'm2b', 500, {})).toBe(0)
    // Time refills the bucket.
    now += 2000
    expect(meter.record('ws', 'm2b', 400, source)).toBe(0)
    // A huge frame pauses for at most MAX_PAUSE_MS, so heartbeats keep flowing.
    expect(meter.record('ws', 'm2b', 10_000_000, source)).toBe(MAX_PAUSE_MS)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('throttling until UTC midnight')
  })

  it('lifts the throttle at UTC midnight', () => {
    make({ default: { relayedBytesPerWorkspacePerDay: 100, throttledBytesPerSecond: 10 } })
    meter.record('ws', 'm2b', 200, source)
    expect(meter.record('ws', 'm2b', 100, source)).toBeGreaterThan(0)
    now = Date.parse('2026-11-09T00:00:00Z')
    expect(meter.record('ws', 'm2b', 50, source)).toBe(0)
  })
})

describe('meterFrame', () => {
  it('pauses reading the socket while throttled and resumes it after', () => {
    vi.useFakeTimers()
    try {
      const socket = { pause: vi.fn(), resume: vi.fn(), readyState: 1 }
      const meter = { record: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(250) } as unknown as UsageMeter
      meterFrame(meter, socket, 'ws', 'b2m', 10)
      expect(socket.pause).not.toHaveBeenCalled()
      meterFrame(meter, socket, 'ws', 'b2m', 10)
      expect(socket.pause).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(249)
      expect(socket.resume).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(socket.resume).toHaveBeenCalledTimes(1)
      // No meter: nothing happens.
      meterFrame(undefined, socket, 'ws', 'b2m', 10)
      expect(socket.pause).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pruneUsage', () => {
  it('drops rows past the retention window', () => {
    const db = openControlPlaneDb(':memory:')
    const insert = db.prepare('INSERT INTO usage_daily (workspace_id, day, bytes_m2b) VALUES (?, ?, 1)')
    insert.run('ws', '2025-01-01')
    insert.run('ws', utcDay(DAY1))
    expect(pruneUsage(db, 400, DAY1)).toBe(1)
    expect(db.prepare('SELECT day FROM usage_daily').all()).toEqual([{ day: '2026-11-08' }])
    db.close()
  })
})
