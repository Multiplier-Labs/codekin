/**
 * Persistent outbox for orchestrator notifications.
 *
 * When a notification cannot be delivered to the orchestrator session
 * (Claude process not running), it is queued here and replayed as a single
 * digest message once the orchestrator is back. The queue survives server
 * restarts via a JSON file in the orchestrator workspace.
 */

import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { DATA_DIR, getAgentDisplayName } from './config.js'
import { getOrchestratorSessionId } from './orchestrator-manager.js'
import type { SessionManager } from './session-manager.js'

export interface OutboxItem {
  id: string
  label: string
  title: string
  body: string
  queuedAt: string
}

/** Hard cap on queued items — oldest entries are dropped beyond this. */
const MAX_QUEUED_ITEMS = 200
/** Default interval for the background flusher. */
const FLUSH_INTERVAL_MS = 60_000

export class OrchestratorOutbox {
  private items: OutboxItem[] = []
  private filePath: string
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(filePath = join(DATA_DIR, 'orchestrator', 'outbox.json')) {
    this.filePath = filePath
    this.load()
  }

  /** Number of queued (undelivered) notifications. */
  size(): number {
    return this.items.length
  }

  /** Queue a notification for later delivery. Oldest items are dropped at the cap. */
  enqueue(args: { label: string; title: string; body: string }): void {
    this.items.push({
      id: randomUUID(),
      label: args.label,
      title: args.title,
      body: args.body,
      queuedAt: new Date().toISOString(),
    })
    if (this.items.length > MAX_QUEUED_ITEMS) {
      this.items = this.items.slice(-MAX_QUEUED_ITEMS)
    }
    this.persist()
  }

  /**
   * Attempt to deliver all queued items to the orchestrator session as a
   * single digest message. No-op when the queue is empty, the orchestrator
   * session is missing / not running, or the rate-limit circuit breaker is
   * open. Returns the number of items delivered.
   */
  flush(sessions: SessionManager): number {
    if (this.items.length === 0) return 0
    if (sessions.isRateLimited()) return 0

    const orchestratorId = getOrchestratorSessionId(sessions)
    if (!orchestratorId) return 0
    const session = sessions.get(orchestratorId)
    if (!session?.claudeProcess?.isAlive()) return 0

    const count = this.items.length
    const digest = this.buildDigest()
    // Clear before sending: if sendInput throws we'd rather drop than
    // double-deliver on the next flush tick.
    this.items = []
    this.persist()
    sessions.sendInput(orchestratorId, digest)
    return count
  }

  /** Start a background timer that periodically attempts a flush. */
  startFlusher(sessions: SessionManager, intervalMs = FLUSH_INTERVAL_MS): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      try {
        const delivered = this.flush(sessions)
        if (delivered > 0) {
          console.log(`[orchestrator-outbox] replayed ${delivered} queued notification(s)`)
        }
      } catch (err) {
        console.error('[orchestrator-outbox] flush error:', err)
      }
    }, intervalMs)
    if (this.flushTimer.unref) this.flushTimer.unref()
  }

  /** Stop the background flusher. */
  stopFlusher(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private buildDigest(): string {
    const agent = getAgentDisplayName()
    const header = this.items.length === 1
      ? `[Agent ${agent} Notification — ${this.items[0].label} (queued while you were away)]`
      : `[Agent ${agent} Notifications — ${this.items.length} queued while you were away]`

    const sections = this.items.map(item => {
      const ts = item.queuedAt.replace('T', ' ').slice(0, 16)
      return this.items.length === 1
        ? `${item.title}\n${item.body}`
        : `--- [${item.label}] ${ts} ---\n${item.title}\n${item.body}`
    })

    return [header, ...sections].join('\n')
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      if (Array.isArray(parsed)) {
        this.items = parsed.filter((it): it is OutboxItem =>
          !!it && typeof it === 'object'
          && typeof (it as OutboxItem).label === 'string'
          && typeof (it as OutboxItem).title === 'string'
          && typeof (it as OutboxItem).body === 'string',
        ).slice(-MAX_QUEUED_ITEMS)
      }
    } catch (err) {
      console.warn('[orchestrator-outbox] failed to load outbox file, starting empty:', err)
      this.items = []
    }
  }

  private persist(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.items, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[orchestrator-outbox] failed to persist outbox file:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: OrchestratorOutbox | null = null

/** Get the process-wide outbox instance. */
export function getOrchestratorOutbox(): OrchestratorOutbox {
  if (!singleton) singleton = new OrchestratorOutbox()
  return singleton
}

/** Test-only: replace the singleton (pass null to reset). */
export function setOrchestratorOutboxForTest(outbox: OrchestratorOutbox | null): void {
  singleton = outbox
}
