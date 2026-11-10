/**
 * What a relay can make the connector hold or start (signed-intents spec §2:
 * the relay may send anything): grant checks keep bounded keys, a frame has
 * a size limit, hello_ack starts the connection's timers once, and the
 * workspace's "passkey required" can't be dropped before it is recorded.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { IntentVerifier } from './intent-verify.js'
import { emptyTrustStore, readTrustStore, writeTrustStore } from './trust-store.js'
import { CONNECTOR_MAX_FRAME_BYTES, RelayConnector } from './connector.js'
import { envelope, parseEnvelope } from './relay-protocol.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function devicesFile(withStore = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'ck-bounds-'))
  dirs.push(dir)
  const file = join(dir, 'relay-devices.json')
  if (withStore) writeTrustStore(file, { ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required' })
  return file
}

function grantee(signedGrants: unknown[]) {
  const grants: Record<string, string[]> = {}
  for (const g of signedGrants) grants[JSON.parse((g as { grant: string }).grant).sessionId] = ['view']
  return { userId: 'u-x', role: 'grantee' as const, grants, signedGrants }
}

function junkGrant(i: number, intent: unknown) {
  return {
    grant: JSON.stringify({ grantId: `g${i}`, sessionId: `s${i}`, granteeUserId: 'u-x', permissions: ['view'], granteeKeys: [], expiresAt: Date.now() + 60_000 }),
    intent,
  }
}

const cacheOf = (v: IntentVerifier) => (v as unknown as { grantCache: Map<string, unknown> }).grantCache

describe('grant checks keep bounded state', () => {
  it('drops an intent of the wrong shape or size before remembering anything', () => {
    const v = new IntentVerifier({ machineId: 'm1', devicesFile: devicesFile(), log: null })
    const big = 'A'.repeat(100_000)
    v.effectivePrincipal(grantee([
      junkGrant(1, { body: big, sig: 'x' }),
      junkGrant(2, { body: 'x', sig: big }),
      junkGrant(3, { body: 'x', webauthn: { credentialId: big, authenticatorData: 'a', clientDataJSON: 'c', signature: 's' } }),
      junkGrant(4, 'not an intent'),
    ]) as never)
    expect(cacheOf(v).size).toBe(0)
  })

  it('keys what it remembers by hash, whatever else the relay attaches', () => {
    const v = new IntentVerifier({ machineId: 'm1', devicesFile: devicesFile(), log: null })
    v.effectivePrincipal(grantee(Array.from({ length: 64 }, (_, i) => junkGrant(i, { body: 'x', sig: 'y', pad: 'A'.repeat(100_000) }))) as never)
    expect(cacheOf(v).size).toBe(64)
    for (const key of cacheOf(v).keys()) expect(key.length).toBeLessThanOrEqual(64)
  })
})

describe('the workspace passkey requirement', () => {
  it('holds in memory until it is recorded, then only a local surface clears it', () => {
    const file = devicesFile(false)
    const v = new IntentVerifier({ machineId: 'm1', devicesFile: file, log: null })
    const required = () => (v as unknown as { requirePasskey: boolean }).requirePasskey
    v.setRequirePasskey(true)
    // No device list yet: not recorded, so the relay can't take it back.
    v.setRequirePasskey(false)
    expect(required()).toBe(true)
    writeTrustStore(file, { ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required' })
    v.checkRequest({ method: 'GET', path: '/api/health', principal: { userId: 'u-owner', role: 'owner', grants: {} } })
    expect(readTrustStore(file)?.requirePasskeyStepUp).toBe(true)
    // Recorded: the in-memory flag follows the relay again; the list keeps it.
    v.setRequirePasskey(false)
    expect(required()).toBe(false)
    expect(readTrustStore(file)?.requirePasskeyStepUp).toBe(true)
  })
})

describe('connector socket', () => {
  let wss: WebSocketServer | null = null
  let connector: RelayConnector | null = null
  afterEach(async () => {
    connector?.stop()
    connector = null
    await new Promise<void>(resolve => { if (wss) wss.close(() => { resolve() }); else resolve() })
    wss = null
  })

  async function relay() {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const socket = new Promise<WebSocket>(resolve => {
      wss!.on('connection', ws => {
        ws.on('message', data => {
          if (parseEnvelope(String(data))?.kind === 'hello') resolve(ws)
        })
      })
    })
    await new Promise<void>(resolve => { wss!.once('listening', () => { resolve() }) })
    return { socket, url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` }
  }

  it('starts its timers and session count once per connection, however many hello_acks arrive', async () => {
    const r = await relay()
    let fetches = 0
    const intervals = vi.spyOn(globalThis, 'setInterval')
    try {
      connector = new RelayConnector({
        relayUrl: r.url, machineId: 'm1', machineSecret: 's', connectorVersion: '0.11.0',
        fetchImpl: (async () => { fetches += 1; return new Response('{"sessions":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as never,
      })
      connector.start()
      const ws = await r.socket
      const before = intervals.mock.calls.length
      for (let i = 0; i < 50; i++) ws.send(JSON.stringify(envelope('hello_ack', { machineId: 'm1', displayName: 'x', policyReports: true })))
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(intervals.mock.calls.length - before).toBe(2)
      expect(fetches).toBe(1)
    } finally {
      intervals.mockRestore()
    }
  })

  it('closes the connection on a frame over the limit', async () => {
    const r = await relay()
    connector = new RelayConnector({ relayUrl: r.url, machineId: 'm1', machineSecret: 's', connectorVersion: '0.11.0' })
    connector.start()
    const ws = await r.socket
    const closed = new Promise<number>(resolve => { ws.once('close', code => { resolve(code) }) })
    ws.send(Buffer.alloc(CONNECTOR_MAX_FRAME_BYTES + 1, 0x20))
    expect(await closed).toBe(1009)
  })
})
