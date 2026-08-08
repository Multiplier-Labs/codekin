/**
 * Token-bucket rate limiting and backpressure helpers for the relay
 * (spec §11.5).
 *
 * The hub sits between an untrusted browser and someone's development
 * machine, so both directions need a ceiling: a browser cannot flood a
 * machine, and a machine cannot flood the hub's memory. Buckets are keyed
 * by user or machine so one noisy participant cannot starve the rest.
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimitOptions {
  /** Sustained rate, in events per second. */
  ratePerSecond: number
  /** How many events may arrive at once before the sustained rate applies. */
  burst: number
}

/**
 * A keyed token bucket. Idle keys are dropped on sweep, so the map tracks
 * active participants rather than everyone ever seen.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private sweepTimer: ReturnType<typeof setInterval>

  constructor(private opts: RateLimitOptions, sweepIntervalMs = 60_000) {
    this.sweepTimer = setInterval(() => { this.sweep() }, sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  /** Consume one token. Returns false when the key is over its limit. */
  tryConsume(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key)
    if (!bucket) {
      this.buckets.set(key, { tokens: this.opts.burst - 1, updatedAt: now })
      return true
    }

    const elapsedSeconds = (now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(this.opts.burst, bucket.tokens + elapsedSeconds * this.opts.ratePerSecond)
    bucket.updatedAt = now

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** Forget a key (participant disconnected). */
  forget(key: string): void {
    this.buckets.delete(key)
  }

  /** Number of tracked keys, for tests. */
  get size(): number {
    return this.buckets.size
  }

  private sweep(now = Date.now()): void {
    const idleMs = (this.opts.burst / this.opts.ratePerSecond) * 1000
    for (const [key, bucket] of this.buckets) {
      // A bucket idle long enough to have fully refilled carries no state
      if (now - bucket.updatedAt > idleMs) this.buckets.delete(key)
    }
  }

  close(): void {
    clearInterval(this.sweepTimer)
    this.buckets.clear()
  }
}

/**
 * Outbound queue ceiling. `ws` buffers whatever the socket cannot write; a
 * consumer that stops reading would otherwise grow that buffer without
 * bound, so past this many bytes the channel is closed instead (spec §11.5).
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export interface BufferedSocket {
  bufferedAmount: number
}

/** True when a socket's unwritten backlog has grown past the ceiling. */
export function isBackedUp(socket: BufferedSocket): boolean {
  return socket.bufferedAmount > MAX_BUFFERED_BYTES
}

/** Frames per second a single browser may send, and a burst allowance. */
export const BROWSER_FRAME_LIMIT: RateLimitOptions = { ratePerSecond: 40, burst: 120 }

/** Frames per second a single machine may send back. */
export const MACHINE_FRAME_LIMIT: RateLimitOptions = { ratePerSecond: 200, burst: 600 }

/** Channels one machine may serve across all of its viewers. */
export const MAX_CHANNELS_PER_MACHINE = 32
