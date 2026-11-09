/**
 * Session activity audit for traffic the relay forwards
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §7.1).
 *
 * The hub classifies what a browser sends to a machine and records who did
 * what, where and when, never the content: no prompt text, file names or
 * tool input. `payloadHash` is the SHA-256 of the exact bytes forwarded, so
 * a machine-side log can later be compared with the relay's (§7.2). Before
 * signed intents it is computed here; afterwards it comes from the intent.
 *
 * The relay's audit is only as honest as the relay; it serves team
 * accountability, not tamper evidence.
 */

import { createHash } from 'crypto'
import { VALID_PERMISSION_MODES } from '../types.js'
import type { PermissionMode } from '../types.js'
import type { AuditEventKind } from './audit.js'

// The transport bounds stream frames; every accepted frame is classified,
// including whitespace-prefixed JSON and large prompts.

export interface SessionAuditEvent {
  kind: AuditEventKind
  /** Set when the frame names its session; otherwise the channel's joined session applies. */
  sessionId?: string
  metadata: Record<string, string | number | boolean | null>
}

export type ApprovalDecision = 'approve' | 'always' | 'deny' | 'other'

export function payloadHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Reduce a prompt answer to its class; the answer itself is never recorded. */
export function decisionClass(value: unknown): ApprovalDecision {
  if (value === 'allow' || value === 'allow_once' || value === 'once') return 'approve'
  if (value === 'always_allow' || value === 'allow_always' || value === 'always') return 'always'
  if (value === 'deny' || value === 'reject') return 'deny'
  return 'other'
}

/**
 * What a browser → machine stream frame means for the audit log, or null
 * for frames that aren't audited (reads, pings, resizes, review comments).
 * `join_session` comes back as a `join` marker so the caller can bind the
 * channel to its session.
 */
export type BrowserAuditFrame = SessionAuditEvent | { join: string } | { leave: true } | { create: true }

function parseSessionFrame(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

export function classifyBrowserFrame(data: string): BrowserAuditFrame | null {
  const msg = parseSessionFrame(data)
  if (!msg) return null
  switch (msg.type) {
    case 'join_session':
      return typeof msg.sessionId === 'string' ? { join: msg.sessionId } : null
    case 'leave_session': return { leave: true }
    case 'create_session': return { create: true }
    case 'input':
    case 'review_feedback_send':
      return { kind: 'prompt_sent', metadata: { via: msg.type, payloadHash: payloadHash(data) } }
    case 'prompt_response':
      return {
        kind: 'approval_answered',
        metadata: {
          decision: decisionClass(Array.isArray(msg.value) ? null : msg.value),
          requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 100) : null,
          payloadHash: payloadHash(data),
        },
      }
    case 'stop':
      return { kind: 'session_stopped', metadata: {} }
    case 'set_permission_mode':
      return {
        kind: 'permission_mode_changed',
        metadata: { mode: typeof msg.permissionMode === 'string' && VALID_PERMISSION_MODES.has(msg.permissionMode as PermissionMode) ? msg.permissionMode : null },
      }
    default:
      return null
  }
}

/** Read a machine acknowledgement independently of JSON property order. */
export function sessionFromMachineFrame(data: string): { sessionId: string; created: boolean } | null {
  return sessionAnnouncement(parseSessionFrame(data))
}

function sessionAnnouncement(msg: Record<string, unknown> | null): { sessionId: string; created: boolean } | null {
  if (!msg || (msg.type !== 'session_joined' && msg.type !== 'session_created') || typeof msg.sessionId !== 'string') return null
  return { sessionId: msg.sessionId.slice(0, 200), created: msg.type === 'session_created' }
}

/** Audit attribution is confirmed by the machine, never by a browser's requested session. */
export class SessionAuditState {
  private confirmed: string | null = null
  private pending = false

  get sessionId(): string | null { return this.pending ? null : this.confirmed }

  requested(): void { this.pending = true }

  /** Connector policy rejected the transition before it reached the local server. */
  rejected(): void { this.pending = false }

  observe(data: string): { sessionId: string; created: boolean } | null {
    const msg = parseSessionFrame(data)
    const announcement = sessionAnnouncement(msg)
    if (announcement) {
      this.confirmed = announcement.sessionId
      this.pending = false
    } else if (msg?.type === 'session_left' || (this.pending && msg?.type === 'error')) {
      // The local server leaves the old session before attempting a join.
      this.confirmed = null
      this.pending = false
    }
    return announcement
  }
}

/** REST calls that are audited: uploads and session creation. */
export function classifyRestRequest(method: string, path: string): 'upload' | 'create_session' | null {
  if (method.toUpperCase() !== 'POST') return null
  const route = path.split('?')[0].replace(/\/+$/, '')
  if (route === '/api/upload') return 'upload'
  if (route === '/api/sessions/create') return 'create_session'
  return null
}

/** Audit rows written per user, machine and kind before further ones are counted instead. */
export const AUDIT_BURST = 30
/** Rows that budget earns back per minute. */
export const AUDIT_PER_MINUTE = 30

interface AuditBucket {
  tokens: number
  at: number
  /** Events not recorded one by one since the last row of this kind. */
  coalesced: number
  /** The latest of them, for the summary row. */
  last: { localSessionId: string | null; metadata: Record<string, string | number | boolean | null> } | null
}

export interface CoalescedRow {
  actorUserId: string
  machineId: string
  kind: AuditEventKind
  localSessionId: string | null
  metadata: Record<string, string | number | boolean | null>
}

/**
 * Bounds the audit rows one user can cause on one machine (each forwarded
 * frame would otherwise be a row). Up to AUDIT_BURST rows of a kind go in at
 * once and AUDIT_PER_MINUTE more each minute; past that, events are counted,
 * and the next row of that kind carries `coalesced: N`. A burst that ends is
 * summed up in one row by sweep(), so nothing goes unrecorded, only
 * unitemized. Keyed by user, not channel, so reopening channels doesn't
 * reset it.
 */
export class AuditBudget {
  private buckets = new Map<string, AuditBucket>()

  constructor(
    private readonly burst = AUDIT_BURST,
    private readonly perMinute = AUDIT_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether to write this event now. Returns the extra metadata for its row
   * (`coalesced` when earlier ones were counted), or null to count it instead.
   */
  admit(
    actorUserId: string, machineId: string, kind: AuditEventKind,
    event: { localSessionId: string | null; metadata: Record<string, string | number | boolean | null> },
  ): { coalesced?: number } | null {
    const key = `${actorUserId}\u0000${machineId}\u0000${kind}`
    const t = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.burst, at: t, coalesced: 0, last: null }
      this.buckets.set(key, bucket)
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((t - bucket.at) / 60_000) * this.perMinute)
    bucket.at = t
    if (bucket.tokens < 1) {
      bucket.coalesced += 1
      bucket.last = event
      return null
    }
    bucket.tokens -= 1
    const coalesced = bucket.coalesced
    bucket.coalesced = 0
    bucket.last = null
    return coalesced > 0 ? { coalesced } : {}
  }

  /**
   * Summary rows for counted events whose burst has ended (no event for
   * `idleMs`), and forget buckets that are full again.
   */
  sweep(idleMs = 60_000): CoalescedRow[] {
    const t = this.now()
    const rows: CoalescedRow[] = []
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.at < idleMs) continue
      if (bucket.coalesced > 0 && bucket.last) {
        const [actorUserId, machineId, kind] = key.split('\u0000') as [string, string, AuditEventKind]
        rows.push({ actorUserId, machineId, kind, localSessionId: bucket.last.localSessionId, metadata: { ...bucket.last.metadata, coalesced: bucket.coalesced } })
      }
      this.buckets.delete(key)
    }
    return rows
  }
}
