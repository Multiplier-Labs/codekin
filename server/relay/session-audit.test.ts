/** Tests for classifying forwarded traffic into audit events, and filtering the audit log. */
import { describe, it, expect } from 'vitest'
import { openControlPlaneDb, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { listAuditEvents, recordAuditEvent } from './audit.js'
import { AuditBudget, classifyBrowserFrame, classifyRestRequest, decisionClass, sessionFromMachineFrame, SessionAuditState } from './session-audit.js'

describe('classifyBrowserFrame', () => {
  it('audits prompts, approvals, stops and permission changes, and binds joins', () => {
    expect(classifyBrowserFrame('{"type":"input","data":"hi"}')).toMatchObject({ kind: 'prompt_sent', metadata: { via: 'input' } })
    expect(classifyBrowserFrame('{"type":"review_feedback_send"}')).toMatchObject({ kind: 'prompt_sent', metadata: { via: 'review_feedback_send' } })
    expect(classifyBrowserFrame('{"type":"prompt_response","value":"deny"}')).toMatchObject({ kind: 'approval_answered', metadata: { decision: 'deny', requestId: null } })
    expect(classifyBrowserFrame('{"type":"stop"}')).toEqual({ kind: 'session_stopped', metadata: {} })
    expect(classifyBrowserFrame('{"type":"set_permission_mode","permissionMode":"plan"}')).toMatchObject({ kind: 'permission_mode_changed', metadata: { mode: 'plan' } })
    expect(classifyBrowserFrame('{"type":"join_session","sessionId":"s1"}')).toEqual({ join: 's1' })
  })

  it('hashes the exact bytes and keeps no content', () => {
    const a = classifyBrowserFrame('{"type":"input","data":"secret"}')
    const b = classifyBrowserFrame('{"type":"input","data":"secret "}')
    expect(JSON.stringify(a)).not.toContain('secret')
    expect((a as { metadata: { payloadHash: string } }).metadata.payloadHash).not.toBe((b as { metadata: { payloadHash: string } }).metadata.payloadHash)
  })

  it('records supported permission modes while omitting arbitrary strings', () => {
    expect(classifyBrowserFrame(JSON.stringify({ type: 'set_permission_mode', permissionMode: 'dangerouslySkipPermissions' })))
      .toMatchObject({ metadata: { mode: 'dangerouslySkipPermissions' } })
    expect(classifyBrowserFrame(JSON.stringify({ type: 'set_permission_mode', permissionMode: 'private content' })))
      .toMatchObject({ metadata: { mode: null } })
  })

  it.each(['{"type":"get_diff"}', '{"type":"ping"}', '{"type":"resize","cols":1,"rows":1}', 'not json', '[1]', '{"type":"join_session"}'])('ignores %s', frame => {
    expect(classifyBrowserFrame(frame)).toBeNull()
  })

  it('classifies answers without recording them', () => {
    expect(['allow', 'always_allow', 'deny', 'Option B', null].map(decisionClass)).toEqual(['approve', 'always', 'deny', 'other', 'other'])
  })
})

describe('sessionFromMachineFrame', () => {
  it('reads the session from the head of join/create replies only', () => {
    expect(sessionFromMachineFrame('{"type":"session_joined","sessionId":"s1","outputBuffer":[]}')).toEqual({ sessionId: 's1', created: false })
    expect(sessionFromMachineFrame('{"type":"session_created","sessionId":"s2"}')).toEqual({ sessionId: 's2', created: true })
    expect(sessionFromMachineFrame('{"type":"output","data":"{\\"type\\":\\"session_created\\",\\"sessionId\\":\\"x\\"}"}')).toBeNull()
  })
})

describe('confirmed session attribution', () => {
  it('keeps a denied join from changing the session, and clears a confirmed leave', () => {
    const state = new SessionAuditState()
    state.observe('{"sessionId":"a","type":"session_joined"}')
    state.requested()
    expect(state.sessionId).toBeNull()
    state.rejected()
    expect(state.sessionId).toBe('a')
    state.requested()
    state.observe(' { "type": "session_left" } ')
    expect(state.sessionId).toBeNull()
    state.requested()
    state.observe('{"sessionId":"b","type":"session_joined"}')
    expect(state.sessionId).toBe('b')
    state.requested()
    state.observe('{"type":"error","message":"Session not found"}')
    expect(state.sessionId).toBeNull()
  })

  it('audits valid whitespace-prefixed JSON and prompts larger than the old audit cap', () => {
    const data = '  ' + JSON.stringify({ type: 'input', data: 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(classifyBrowserFrame(data)).toMatchObject({ kind: 'prompt_sent', metadata: { payloadHash: expect.any(String) } })
    expect(sessionFromMachineFrame(' {"outputBuffer":[],"sessionId":"b","type":"session_joined"} ')).toEqual({ sessionId: 'b', created: false })
  })
})

describe('classifyRestRequest', () => {
  it('audits uploads and creations only', () => {
    expect(classifyRestRequest('POST', '/api/upload')).toBe('upload')
    expect(classifyRestRequest('post', '/api/sessions/create/?x=1')).toBe('create_session')
    expect(classifyRestRequest('GET', '/api/upload')).toBeNull()
    expect(classifyRestRequest('POST', '/api/sessions/list')).toBeNull()
  })
})

describe('audit filters', () => {
  it('filters by kinds and session', () => {
    const db = openControlPlaneDb(':memory:')
    const add = (kind: 'prompt_sent' | 'session_stopped', session: string) => {
      recordAuditEvent(db, { kind, workspaceId: BOOTSTRAP_WORKSPACE_ID, localSessionId: session })
    }
    add('prompt_sent', 's1')
    add('session_stopped', 's1')
    add('prompt_sent', 's2')
    expect(listAuditEvents(db, { kinds: ['prompt_sent'] }).map(e => e.localSessionId)).toEqual(['s2', 's1'])
    expect(listAuditEvents(db, { localSessionId: 's1' }).map(e => e.kind)).toEqual(['session_stopped', 'prompt_sent'])
    db.close()
  })
})

describe('AuditBudget', () => {
  const event = (n: number) => ({ localSessionId: 's1', metadata: { role: 'owner', n } })

  it('itemizes a burst, then counts, and carries the count on the next row', () => {
    let now = 0
    const budget = new AuditBudget(3, 60, () => now)
    const admitted = Array.from({ length: 10 }, (_, i) => budget.admit('u1', 'm1', 'prompt_sent', event(i)))
    expect(admitted.filter(a => a !== null)).toHaveLength(3)
    now += 1000 // one more row earned
    expect(budget.admit('u1', 'm1', 'prompt_sent', event(10))).toEqual({ coalesced: 7 })
  })

  it('keeps budgets per user, machine and kind', () => {
    const budget = new AuditBudget(1, 1, () => 0)
    expect(budget.admit('u1', 'm1', 'prompt_sent', event(0))).toEqual({})
    expect(budget.admit('u1', 'm1', 'prompt_sent', event(1))).toBeNull()
    expect(budget.admit('u2', 'm1', 'prompt_sent', event(0))).toEqual({})
    expect(budget.admit('u1', 'm2', 'prompt_sent', event(0))).toEqual({})
    expect(budget.admit('u1', 'm1', 'session_viewed', event(0))).toEqual({})
  })

  it('sums up a burst that ended in one row, and forgets idle budgets', () => {
    let now = 0
    const budget = new AuditBudget(1, 1, () => now)
    budget.admit('u1', 'm1', 'approval_answered', event(0))
    for (let i = 1; i <= 5; i++) budget.admit('u1', 'm1', 'approval_answered', event(i))
    expect(budget.sweep()).toEqual([])
    now += 61_000
    expect(budget.sweep()).toEqual([{
      actorUserId: 'u1', machineId: 'm1', kind: 'approval_answered', localSessionId: 's1', metadata: { role: 'owner', n: 5, coalesced: 5 },
    }])
    expect(budget.sweep()).toEqual([])
    // A fresh budget afterwards.
    expect(budget.admit('u1', 'm1', 'approval_answered', event(6))).toEqual({})
  })

  it('bounds the rows a flood can write', () => {
    let now = 0
    const budget = new AuditBudget(30, 30, () => now)
    let rows = 0
    // 40 frames a second for ten minutes.
    for (let i = 0; i < 40 * 600; i++) {
      now = i * 25
      if (budget.admit('u1', 'm1', 'prompt_sent', event(i))) rows++
    }
    expect(rows).toBeLessThanOrEqual(30 + 30 * 10 + 1)
  })
})
