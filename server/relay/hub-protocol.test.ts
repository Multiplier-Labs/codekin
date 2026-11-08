import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { WebSocket } from 'ws'
import { onHubMessage, parseHubEnvelope } from './hub-protocol.js'

const wire = (kind: string, payload: unknown, extra = {}) => JSON.stringify({ version: 1, kind, payload, ...extra })

describe('hub wire validation', () => {
  it.each([null, [], 123, 'hello', undefined])('rejects a non-object hello payload: %j', payload => {
    for (const peer of ['browser', 'connector'] as const) {
      expect(parseHubEnvelope(wire('hello', payload), peer)).toBeNull()
    }
  })

  it('validates connector versions and nested capability/session fields', () => {
    const hello = { machineId: 'm', machineSecret: 'secret' }
    expect(parseHubEnvelope(wire('hello', hello), 'connector')).not.toBeNull()
    for (const extra of [
      { connectorVersion: 123 }, { localCodekinVersion: {} }, { capabilities: [] },
      { capabilities: { features: [42] } }, { sessions: { total: -1, active: 'yes' } },
    ]) expect(parseHubEnvelope(wire('hello', { ...hello, ...extra }), 'connector')).toBeNull()
  })

  it('bounds routing fields and validates every routed payload', () => {
    for (const [kind, payload, extra] of [
      ['request', { method: 'GET', path: '/api/health', body: {} }, { id: 'r' }],
      ['stream_data', { data: null }, { channelId: 'c' }],
      ['stream_close', { code: 1006 }, { channelId: 'c' }],
      ['stream_close', { reason: '🙂'.repeat(40) }, { channelId: 'c' }],
      ['stream_open', {}, { channelId: 'x'.repeat(201) }],
    ] as const) expect(parseHubEnvelope(wire(kind, payload, extra), 'browser')).toBeNull()
    expect(parseHubEnvelope(wire('response', null, { id: 'r' }), 'connector')).toBeNull()
    expect(parseHubEnvelope(wire('error', { code: {}, message: 'bad' }), 'connector')).toBeNull()
    expect(parseHubEnvelope(wire('request', { method: 'GET', path: '/' }, { id: 'r' }), 'connector')).toBeNull()
  })

  it('carries what grant supersedes and clock probes need through the relay', () => {
    const intent = { body: '{}', sig: 'AAAA' }
    const supersede = parseHubEnvelope(wire('enrol_grant_revoke', { grantId: 'g1', keep: 'g1:abc0123abcd', intent }, { id: 'e' }), 'browser')
    expect((supersede?.payload as { keep?: string }).keep).toBe('g1:abc0123abcd')
    expect(parseHubEnvelope(wire('enrol_time', { nonce: 'A'.repeat(22) }, { id: 'e' }), 'browser')).not.toBeNull()
    expect(parseHubEnvelope(wire('enrol_time', { nonce: 'not base64url!' }, { id: 'e' }), 'browser')).toBeNull()
    const result = parseHubEnvelope(wire('enrol_result', { enrolId: 'time:x', state: 'approved', machineTime: 5, signature: 'AA' }, { id: 'e' }), 'connector')
    expect((result?.payload as { machineTime?: number }).machineTime).toBe(5)
  })

  it('carries the policy a connector reports, and the owner asking to raise it', () => {
    const hello = { machineId: 'm', machineSecret: 'secret', intentPolicy: 'required' }
    expect((parseHubEnvelope(wire('hello', hello), 'connector')?.payload as { intentPolicy?: string }).intentPolicy).toBe('required')
    expect(parseHubEnvelope(wire('hello', { ...hello, intentPolicy: 'sometimes' }), 'connector')).toBeNull()
    expect(parseHubEnvelope(wire('intent_policy', { policy: 'warn' }), 'connector')).not.toBeNull()
    expect(parseHubEnvelope(wire('intent_policy', { policy: 'warn' }), 'browser')).toBeNull()
    const raise = parseHubEnvelope(wire('enrol_policy', { policy: 'required', intent: { body: '{}', sig: 'AA' } }, { id: 'e' }), 'browser')
    expect((raise?.payload as { policy?: string }).policy).toBe('required')
  })

  it('leaves stream frame size to the socket limit, so large session replays pass', () => {
    const replay = wire('stream_data', { data: 'x'.repeat(9 * 1024 * 1024) }, { channelId: 'c' })
    expect(parseHubEnvelope(replay, 'connector')).not.toBeNull()
    expect(parseHubEnvelope(replay, 'browser')).not.toBeNull()
  })

  it('contains synchronous and asynchronous handler failures without logging their contents', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const handle of [() => { throw new Error('private') }, () => Promise.reject(new Error('private'))]) {
        const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, close: vi.fn() })
        onHubMessage(socket as unknown as WebSocket, handle)
        socket.emit('message', Buffer.from('private'))
        await Promise.resolve()
        expect(socket.close).toHaveBeenCalledWith(1011, 'relay handler failed')
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    } finally { log.mockRestore() }
  })

  it('accepts connector reports of abnormal local closes without accepting them as browser close commands', () => {
    const close = wire('stream_close', { code: 1006, reason: 'local connection lost' }, { channelId: 'c' })
    expect(parseHubEnvelope(close, 'connector')).not.toBeNull()
    expect(parseHubEnvelope(close, 'browser')).toBeNull()
  })
})
