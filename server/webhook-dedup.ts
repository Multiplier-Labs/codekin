import crypto from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DedupEntry } from './webhook-types.js'

const DATA_DIR = join(homedir(), '.codekin')
const DEDUP_FILE = join(DATA_DIR, 'webhook-dedup.json')
const MAX_ENTRIES = 1000
const TTL_MS = 60 * 60 * 1000 // 1 hour
const FLUSH_INTERVAL_MS = 60 * 1000 // 60 seconds

/**
 * Computes the composite idempotency key for a webhook event.
 * sha256(owner + repo + event + runId + action + conclusion + run_attempt)
 */
export function computeIdempotencyKey(
  repo: string,
  event: string,
  runId: number,
  action: string,
  conclusion: string,
  runAttempt: number,
): string {
  const parts = [repo, event, String(runId), action, conclusion, String(runAttempt)]
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

export class WebhookDedup {
  // Two lookup maps for the same data — either key can match
  private byDeliveryId = new Map<string, DedupEntry>()
  private byIdempotencyKey = new Map<string, DedupEntry>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.loadFromDisk()
    this.flushTimer = setInterval(() => this.flushToDisk(), FLUSH_INTERVAL_MS)
    if (this.flushTimer.unref) this.flushTimer.unref()
  }

  /**
   * Check if an event is a duplicate. If not, record it.
   * Returns true if it IS a duplicate.
   */
  isDuplicate(deliveryId: string, idempotencyKey: string): boolean {
    this.evictExpired()

    if (deliveryId && this.byDeliveryId.has(deliveryId)) return true
    if (this.byIdempotencyKey.has(idempotencyKey)) return true

    // Not a duplicate — record it
    const entry: DedupEntry = {
      processedAt: new Date().toISOString(),
      eventId: deliveryId || idempotencyKey.slice(0, 12),
    }

    if (deliveryId) this.byDeliveryId.set(deliveryId, entry)
    this.byIdempotencyKey.set(idempotencyKey, entry)

    // Enforce max entries
    this.enforceMaxEntries()

    return false
  }

  private evictExpired(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [key, entry] of this.byDeliveryId) {
      if (new Date(entry.processedAt).getTime() < cutoff) {
        this.byDeliveryId.delete(key)
      }
    }
    for (const [key, entry] of this.byIdempotencyKey) {
      if (new Date(entry.processedAt).getTime() < cutoff) {
        this.byIdempotencyKey.delete(key)
      }
    }
  }

  private enforceMaxEntries(): void {
    // If over limit, evict oldest from both maps
    while (this.byIdempotencyKey.size > MAX_ENTRIES) {
      const oldestKey = this.byIdempotencyKey.keys().next().value!
      this.byIdempotencyKey.delete(oldestKey)
    }
    while (this.byDeliveryId.size > MAX_ENTRIES) {
      const oldestKey = this.byDeliveryId.keys().next().value!
      this.byDeliveryId.delete(oldestKey)
    }
  }

  flushToDisk(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true })

      // Serialize both maps
      const data = {
        byDeliveryId: Object.fromEntries(this.byDeliveryId),
        byIdempotencyKey: Object.fromEntries(this.byIdempotencyKey),
      }

      const tmp = DEDUP_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      renameSync(tmp, DEDUP_FILE)
    } catch (err) {
      console.warn('[webhook-dedup] Failed to flush to disk:', err)
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(DEDUP_FILE)) return

    try {
      const raw = readFileSync(DEDUP_FILE, 'utf-8')
      const data = JSON.parse(raw) as {
        byDeliveryId?: Record<string, DedupEntry>
        byIdempotencyKey?: Record<string, DedupEntry>
      }

      if (data.byDeliveryId) {
        for (const [k, v] of Object.entries(data.byDeliveryId)) {
          this.byDeliveryId.set(k, v)
        }
      }
      if (data.byIdempotencyKey) {
        for (const [k, v] of Object.entries(data.byIdempotencyKey)) {
          this.byIdempotencyKey.set(k, v)
        }
      }

      this.evictExpired()
      console.log(`[webhook-dedup] Loaded ${this.byIdempotencyKey.size} entries from disk`)
    } catch (err) {
      console.warn('[webhook-dedup] Failed to load from disk:', err)
    }
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flushToDisk()
  }
}
