/**
 * Replay protection for GitHub deliveries that arrive through the relay.
 *
 * GitHub's HMAC signature proves a delivery is genuine, but it carries no
 * timestamp. A relay that saw a delivery could send it again later, and the
 * local server only remembers delivery ids for an hour. The connector sits
 * between the relay and the machine, so it is the right place to refuse
 * replays:
 *
 * - a delivery id is accepted once: it is remembered for RETENTION_MS after
 *   the local server accepted it (2xx)
 * - a delivery whose own event timestamp is older than RETENTION_MS is
 *   refused, so a replay after the id has been forgotten fails too
 *
 * Ids are recorded only after the local server accepted the delivery, so a
 * forged frame reusing a real id (which the HMAC check rejects) cannot block
 * the genuine one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/** How long a delivery id is remembered, and the oldest event accepted. */
export const WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Upper bound on remembered ids, oldest dropped first. */
const MAX_REMEMBERED = 20_000

/** Payload objects whose `updated_at` dates the event. */
const DATED_OBJECTS = ['workflow_run', 'workflow_job', 'check_run', 'check_suite', 'pull_request', 'issue'] as const

export type WebhookGuardVerdict = { ok: true; deliveryId: string } | { ok: false; reason: string }

export function defaultWebhookGuardFile(home = homedir()): string {
  return join(home, '.config', 'codekin', 'relay-webhook-deliveries.json')
}

export class WebhookReplayGuard {
  private seen = new Map<string, number>()
  private loaded = false

  constructor(
    private readonly file: string | null = defaultWebhookGuardFile(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Decide whether a forwarded delivery may reach the local server. */
  check(headers: Record<string, string> | undefined, body: Buffer | undefined): WebhookGuardVerdict {
    this.load()
    const deliveryId = headers?.['x-github-delivery']
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      return { ok: false, reason: 'Delivery has no id' }
    }
    this.prune()
    if (this.seen.has(deliveryId)) {
      return { ok: false, reason: 'Delivery was already accepted' }
    }
    const eventAt = eventTimestamp(body)
    if (eventAt !== null && this.now() - eventAt > WEBHOOK_RETENTION_MS) {
      return { ok: false, reason: 'Delivery is older than the replay window' }
    }
    return { ok: true, deliveryId }
  }

  /** Remember a delivery the local server accepted. */
  record(deliveryId: string): void {
    this.load()
    this.seen.set(deliveryId, this.now())
    while (this.seen.size > MAX_REMEMBERED) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    this.persist()
  }

  private prune(): void {
    const cutoff = this.now() - WEBHOOK_RETENTION_MS
    for (const [id, at] of this.seen) {
      if (at < cutoff) this.seen.delete(id)
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.file || !existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as { deliveries?: unknown }
      if (typeof parsed.deliveries === 'object' && parsed.deliveries !== null) {
        const entries = Object.entries(parsed.deliveries as Record<string, unknown>)
          .filter((e): e is [string, number] => typeof e[1] === 'number')
          .sort((a, b) => a[1] - b[1])
        for (const [id, at] of entries) this.seen.set(id, at)
      }
    } catch {
      // A corrupt file loses the memory, not the safety net: the event-age
      // check still refuses anything older than the window.
    }
  }

  private persist(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ deliveries: Object.fromEntries(this.seen) }) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      console.warn('[connector] Could not save webhook delivery ids:', err instanceof Error ? err.message : err)
    }
  }
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
