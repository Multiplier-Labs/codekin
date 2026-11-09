/**
 * A relay can send the connector anything (signed-intents spec §2). Frames
 * whose payloads don't match the protocol are refused or dropped; none may
 * throw out of the socket handler and take the connector down.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { RelayConnector } from './connector.js'
import { envelope, parseEnvelope, RELAY_ERROR } from './relay-protocol.js'
import type { RelayEnvelope } from './relay-protocol.js'
import { asPrincipal, asProxyRequest, asStreamClose, asStreamData, asStreamOpen, safeCloseReason } from './connector-frames.js'

let wss: WebSocketServer | null = null
let connector: RelayConnector | null = null

afterEach(async () => {
  connector?.stop()
  connector = null
  await new Promise<void>(resolve => { if (wss) wss.close(() => { resolve() }); else resolve() })
  wss = null
})

const owner = { userId: 'u1', role: 'owner', grants: {} }

/** A relay that acks hello and hands back the connector's socket and every frame it sent. */
async function relay(): Promise<{ socket: Promise<WebSocket>; frames: RelayEnvelope[]; url: string }> {
  const frames: RelayEnvelope[] = []
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const socket = new Promise<WebSocket>(resolve => {
    wss!.on('connection', ws => {
      ws.on('message', data => {
        const msg = parseEnvelope(String(data))
        if (!msg) return
        frames.push(msg)
        if (msg.kind === 'hello') {
          ws.send(JSON.stringify(envelope('hello_ack', { machineId: 'm1', displayName: 'Dev box' })))
          resolve(ws)
        }
      })
    })
  })
  await new Promise<void>(resolve => { wss!.once('listening', () => { resolve() }) })
  return { socket, frames, url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` }
}

/** Wait for the connector's reply to request `id`. */
async function replyTo(frames: RelayEnvelope[], id: string): Promise<RelayEnvelope> {
  for (let i = 0; i < 100; i++) {
    const found = frames.find(f => f.id === id && f.kind !== 'hello')
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`no reply to ${id}`)
}

function start(url: string, checkRequest: () => unknown = () => ({ forward: false, reason: 'intent_required' })) {
  connector = new RelayConnector({
    relayUrl: url, machineId: 'm1', machineSecret: 's', connectorVersion: '0.11.0',
    intents: { checkRequest, checkChannelOpen: () => ({ decision: { forward: false } }), checkFrame: () => ({}), policy: () => 'required' } as never,
    onStatus: () => { /* the CLI sets one, which is what made `error` frames throw */ },
  })
  connector.start()
}

const raw = (kind: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind, payload, ...extra })

describe('connector with malformed relay frames', () => {
  it('survives null, array and wrong-typed payloads of every kind, and still answers', async () => {
    const r = await relay()
    start(r.url)
    const ws = await r.socket
    const bad: unknown[] = [null, [], 'x', 5, { method: 5, path: [] }, { principal: 'owner' }, { code: 'x', reason: 5 }]
    for (const payload of bad) {
      for (const kind of ['hello_ack', 'event', 'error', 'stream_open', 'stream_data', 'stream_close', 'enrol_list']) {
        ws.send(raw(kind, payload, { channelId: 'c1', id: `${kind}-x` }))
      }
    }
    ws.send(JSON.stringify(envelope('request', { method: 'GET', path: '/api/health', principal: owner }, { id: 'probe' })))
    const reply = await replyTo(r.frames, 'probe')
    expect(reply.kind).toBe('error')
  })

  it('refuses a malformed request with bad_request instead of throwing', async () => {
    const r = await relay()
    start(r.url)
    const ws = await r.socket
    for (const [i, payload] of [null, { method: 'GET', path: 5 }, { method: 'GET', path: '/x', body: 1 }, { method: 'GET', path: '/x', principal: { role: 'owner' } }].entries()) {
      ws.send(raw('request', payload, { id: `r${i}` }))
      const reply = await replyTo(r.frames, `r${i}`)
      expect(reply.kind).toBe('error')
      expect((reply.payload as { code: string }).code).toBe(RELAY_ERROR.badRequest)
    }
  })

  it('answers when checking a request fails, instead of leaving an unhandled rejection', async () => {
    const r = await relay()
    start(r.url, () => { throw new TypeError('boom') })
    const ws = await r.socket
    ws.send(JSON.stringify(envelope('request', { method: 'GET', path: '/api/health', principal: owner }, { id: 'r1' })))
    const reply = await replyTo(r.frames, 'r1')
    expect(reply.kind).toBe('error')
    ws.send(JSON.stringify(envelope('request', { method: 'GET', path: '/api/health', principal: owner }, { id: 'r2' })))
    expect((await replyTo(r.frames, 'r2')).kind).toBe('error')
  })
})

describe('connector frame shapes', () => {
  it('accepts protocol principals and refuses anything else', () => {
    expect(asPrincipal(owner)).toEqual(owner)
    expect(asPrincipal({ userId: 'u', role: 'grantee', grants: { s1: ['view'] }, signedGrants: [] })).not.toBeNull()
    for (const bad of [null, [], { userId: 'u', role: 'admin', grants: {} }, { userId: 'u', role: 'owner' }, { userId: 'u', role: 'grantee', grants: { s1: 'view' } }, { userId: 'u', role: 'grantee', grants: {}, signedGrants: {} }]) {
      expect(asPrincipal(bad)).toBeNull()
    }
  })

  it('checks request fields', () => {
    expect(asProxyRequest({ method: 'POST', path: '/x', body: 'e30=', contentType: 'application/json', headers: { a: 'b' }, principal: owner })).not.toBeNull()
    expect(asProxyRequest({ method: 'GET', path: '/x' })).not.toBeNull()
    expect(asProxyRequest({ method: 'GET', path: '/x', headers: { a: 1 } })).toBeNull()
    expect(asProxyRequest({ method: 'GET', path: '/x', contentType: null })).toBeNull()
  })

  it('drops a malformed channel principal and frame text', () => {
    expect(asStreamOpen(null)).toEqual({})
    expect(asStreamOpen({ principal: 'owner' }).principal).toBeUndefined()
    expect(asStreamData({ data: 5 })).toBeNull()
    expect(asStreamData({ data: '{}' })).toEqual({ data: '{}', intent: undefined })
  })

  it('makes close codes and reasons safe for ws.close', () => {
    expect(asStreamClose({ code: 4002, reason: 'gone' }, 'f')).toEqual({ code: 4002, reason: 'gone' })
    for (const code of ['x', 1005, 1006, 2999, 5000, 4000.5, null]) {
      expect(asStreamClose({ code }, 'f').code).toBe(1000)
    }
    expect(asStreamClose({ reason: 5 }, 'fallback').reason).toBe('fallback')
    const long = safeCloseReason('é'.repeat(200), 'f')
    expect(Buffer.byteLength(long, 'utf-8')).toBeLessThanOrEqual(123)
    expect(Buffer.byteLength(safeCloseReason('😀'.repeat(100), 'f'), 'utf-8')).toBeLessThanOrEqual(123)
  })
})
