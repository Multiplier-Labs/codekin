/** Tests for classifying forwarded traffic into audit events, and filtering the audit log. */
import { describe, it, expect } from 'vitest'
import { openControlPlaneDb, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { listAuditEvents, recordAuditEvent } from './audit.js'
import { classifyBrowserFrame, classifyRestRequest, decisionClass, sessionFromMachineFrame } from './session-audit.js'

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
