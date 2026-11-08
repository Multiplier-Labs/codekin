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
import type { AuditEventKind } from './audit.js'

/** Browser frames larger than this aren't parsed for auditing (they are forwarded regardless). */
const MAX_AUDITED_FRAME_BYTES = 2 * 1024 * 1024

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
export function classifyBrowserFrame(data: string): SessionAuditEvent | { join: string } | null {
  if (data.length > MAX_AUDITED_FRAME_BYTES || data[0] !== '{') return null
  let msg: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    msg = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (msg.type) {
    case 'join_session':
      return typeof msg.sessionId === 'string' ? { join: msg.sessionId } : null
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
        metadata: { mode: typeof msg.permissionMode === 'string' ? msg.permissionMode.slice(0, 40) : null },
      }
    default:
      return null
  }
}

const SESSION_REPLY = /^\{"type":"session_(joined|created)","sessionId":"([^"]{1,200})"/

/**
 * The session a machine → browser frame announces (`session_joined` /
 * `session_created`), read from the start of the frame without parsing it:
 * joins carry the whole output buffer.
 */
export function sessionFromMachineFrame(data: string): { sessionId: string; created: boolean } | null {
  if (!data.startsWith('{"type":"session_')) return null
  const m = SESSION_REPLY.exec(data.slice(0, 300))
  return m ? { sessionId: m[2], created: m[1] === 'created' } : null
}

/** REST calls that are audited: uploads and session creation. */
export function classifyRestRequest(method: string, path: string): 'upload' | 'create_session' | null {
  if (method.toUpperCase() !== 'POST') return null
  const route = path.split('?')[0].replace(/\/+$/, '')
  if (route === '/api/upload') return 'upload'
  if (route === '/api/sessions/create') return 'create_session'
  return null
}
