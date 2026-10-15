import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { WebSocket, WebSocketServer } from 'ws'
import { WS_MAX_PAYLOAD_BYTES, wsClientIp } from './ws-limits.js'

describe('wsClientIp', () => {
  it('uses the socket address when TRUST_PROXY is off, ignoring X-Forwarded-For', () => {
    expect(wsClientIp('1.2.3.4', '127.0.0.1', false)).toBe('127.0.0.1')
  })

  it('uses the entry appended by the trusted proxy, not a client-supplied one', () => {
    // Client sent "X-Forwarded-For: 6.6.6.6"; nginx appended the real peer.
    expect(wsClientIp('6.6.6.6, 203.0.113.9', '127.0.0.1', true)).toBe('203.0.113.9')
  })

  it('keys every spoofed header from one client to the same bucket', () => {
    const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map(fake =>
      wsClientIp(`${fake}, 203.0.113.9`, '127.0.0.1', true))
    expect(new Set(ips)).toEqual(new Set(['203.0.113.9']))
  })

  it('handles repeated headers and falls back to the socket address', () => {
    expect(wsClientIp(['6.6.6.6', '203.0.113.9'], '127.0.0.1', true)).toBe('203.0.113.9')
    expect(wsClientIp(undefined, '127.0.0.1', true)).toBe('127.0.0.1')
    expect(wsClientIp(' , ', undefined, true)).toBe('unknown')
  })
})

describe('WS_MAX_PAYLOAD_BYTES', () => {
  let server: Server
  let wss: WebSocketServer

  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('closes an unauthenticated socket that sends an oversized frame without delivering it', async () => {
    // Mirrors ws-server.ts: the cap is a server option, enforced before any message handler runs.
    server = createServer()
    wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD_BYTES })
    let delivered = 0
    const errors: string[] = []
    wss.on('connection', ws => {
      ws.on('message', () => { delivered++ })
      // ws-server.ts has the same handler; without one the RangeError would be uncaught.
      ws.on('error', err => errors.push((err as Error & { code?: string }).code ?? err.message))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise(resolve => client.once('open', resolve))
    const closed = new Promise<number>(resolve => client.once('close', code => resolve(code)))
    client.send('x'.repeat(WS_MAX_PAYLOAD_BYTES + 1))

    expect(await closed).toBe(1009)
    expect(delivered).toBe(0)
    expect(errors).toEqual(['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'])
  })
})
