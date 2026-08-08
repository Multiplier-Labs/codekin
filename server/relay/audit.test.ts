/** Audit recording, scoping, metadata handling, and retention. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb } from './control-plane-db.js'
import { listAuditEvents, pruneAuditEvents, recordAuditEvent } from './audit.js'

describe('audit events', () => {
  let db: Database.Database

  beforeEach(() => { db = openControlPlaneDb(':memory:') })
  afterEach(() => { db.close() })

  it('records and returns an event, newest first', () => {
    recordAuditEvent(db, { kind: 'machine_paired', actorUserId: 'u1', machineId: 'm1' })
    recordAuditEvent(db, { kind: 'session_shared', actorUserId: 'u1', machineId: 'm1', localSessionId: 's1' })

    const events = listAuditEvents(db)
    expect(events.map(e => e.kind)).toEqual(['session_shared', 'machine_paired'])
    expect(events[0].localSessionId).toBe('s1')
  })

  it('filters by machine and by actor', () => {
    recordAuditEvent(db, { kind: 'session_viewed', actorUserId: 'u1', machineId: 'm1' })
    recordAuditEvent(db, { kind: 'session_viewed', actorUserId: 'u2', machineId: 'm2' })

    expect(listAuditEvents(db, { machineId: 'm1' })).toHaveLength(1)
    expect(listAuditEvents(db, { actorUserId: 'u2' })[0].machineId).toBe('m2')
  })

  it('round-trips metadata and truncates an oversized blob', () => {
    recordAuditEvent(db, { kind: 'prompt_sent', metadata: { tool: 'Bash', allowed: false } })
    expect(listAuditEvents(db)[0].metadata).toEqual({ tool: 'Bash', allowed: false })

    recordAuditEvent(db, { kind: 'prompt_sent', metadata: { blob: 'x'.repeat(5000) } })
    const truncated = listAuditEvents(db)[0]
    // Truncation makes it unparsable, which is preferred over storing 5 kB
    expect(truncated.kind).toBe('prompt_sent')
    expect(truncated.metadata).toBeNull()
  })

  it('clamps the limit to a sane range', () => {
    for (let i = 0; i < 20; i++) recordAuditEvent(db, { kind: 'session_viewed' })
    expect(listAuditEvents(db, { limit: 5 })).toHaveLength(5)
    expect(listAuditEvents(db, { limit: 0 })).toHaveLength(1)
    expect(listAuditEvents(db, { limit: 100_000 })).toHaveLength(20)
  })

  it('prunes events older than the retention window', () => {
    recordAuditEvent(db, { kind: 'machine_connected', machineId: 'm1' })
    db.prepare(`UPDATE audit_events SET created_at = datetime('now', '-100 days')`).run()
    recordAuditEvent(db, { kind: 'machine_connected', machineId: 'm2' })

    expect(pruneAuditEvents(db, 90)).toBe(1)
    const remaining = listAuditEvents(db)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].machineId).toBe('m2')
  })
})
