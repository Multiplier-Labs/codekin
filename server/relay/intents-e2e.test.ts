/**
 * Signed intents end to end: browser socket → BrowserHub → ConnectorHub →
 * RelayConnector with a verifier, on a machine that requires confirmed
 * devices (signed-intents spec §6.3–6.4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { BOOTSTRAP_WORKSPACE_ID, openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { BrowserHub } from './browser-hub.js'
import { RelayConnector } from './connector.js'
import { envelope } from './relay-protocol.js'
import type { SessionUser } from './relay-auth-routes.js'
import { IntentVerifier } from './intent-verify.js'
import { IntentLog, readRecentIntents } from './intent-log.js'
import { frameAction, framePayload, requestAction, requestPayload } from './intent-actions.js'
import type { IntentBody, SignedIntent } from './intent-actions.js'
import { signP1363 } from './enrolment-crypto.js'
import { keyIdForSpki } from './machine-identity.js'
import { emptyTrustStore, writeTrustStore } from './trust-store.js'
import type { WebSocketFactory } from './connector-stream.js'

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve() } else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')) }
    }, 20)
  })
}

interface Frame { kind: string; id?: string; channelId?: string; payload: Record<string, unknown> }

/** A local Codekin socket that completes the handshake and records what reaches it. */
class FakeLocalSocket extends EventEmitter {
  static readonly OPEN = 1
  readyState = 0
  received: string[] = []
  constructor() {
    super()
    setTimeout(() => { this.readyState = 1; this.emit('open') }, 0)
  }
  send(data: string) {
    if (JSON.parse(data).type === 'auth') { setTimeout(() => { this.emit('message', JSON.stringify({ type: 'connected', connectionId: 'c' })) }, 0); return }
    this.received.push(data)
  }
  close() { this.readyState = 3 }
}

describe('signed intents over the relay', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let browserHub: BrowserHub
  let server: Server
  let relayUrl: string
  let browserUrl: string
  let machineId: string
  let machineSecret: string
  let owner: SessionUser
  let connector: RelayConnector | null = null
  let dir: string
  let logFile: string
  let localFetch: ReturnType<typeof vi.fn>
  let localSockets: FakeLocalSocket[]
  let key: { keyId: string; privateKey: KeyObject }
  let ws: WebSocket
  let frames: Frame[]

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const row = upsertUserFromGithub(db, { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [] })
    owner = { id: row.id, login: row.login, displayName: null, avatarUrl: null, status: row.status }
    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, owner.id, BOOTSTRAP_WORKSPACE_ID, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed')
    machineId = complete.machineId
    machineSecret = complete.machineSecret

    dir = mkdtempSync(join(tmpdir(), 'codekin-intents-e2e-'))
    logFile = join(dir, 'intents.jsonl')
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    key = { keyId: keyIdForSpki(spki), privateKey: pair.privateKey }
    writeTrustStore(join(dir, 'relay-devices.json'), {
      ...emptyTrustStore(machineId, 'https://relay.test', owner.id),
      policy: 'required',
      credentials: [{ keyId: key.keyId, kind: 'browser', userId: owner.id, spki, label: 'Firefox', addedAt: 'x', addedBy: 'local' }],
    })

    hub = new ConnectorHub(db)
    browserHub = new BrowserHub(db, hub)
    server = createServer()
    const connectorWss = new WebSocketServer({ noServer: true })
    connectorWss.on('connection', socket => { hub.handleConnection(socket) })
    const browserWss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/relay/connector') connectorWss.handleUpgrade(req, socket, head, s => connectorWss.emit('connection', s, req))
      else if (path === '/relay/browser') browserWss.handleUpgrade(req, socket, head, s => { browserHub.handleConnection(s, owner) })
      else socket.destroy()
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port
    relayUrl = `http://127.0.0.1:${port}`
    browserUrl = `ws://127.0.0.1:${port}/relay/browser`

    localFetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"sessions":[]}', { status: 200, headers: { 'content-type': 'application/json' } })))
    localSockets = []
    connector = new RelayConnector({
      relayUrl, machineId, machineSecret, connectorVersion: '0.10.6-test',
      localTarget: { origin: 'http://127.0.0.1:32352', authToken: 't' },
      fetchImpl: localFetch as never,
      socketFactory: (() => { const s = new FakeLocalSocket(); localSockets.push(s); return s as unknown as WebSocket }) as WebSocketFactory,
      intents: new IntentVerifier({ machineId, devicesFile: join(dir, 'relay-devices.json'), log: new IntentLog(logFile) }),
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))

    frames = []
    ws = new WebSocket(browserUrl)
    ws.on('message', d => { frames.push(JSON.parse(d.toString()) as Frame) })
    await new Promise<void>(resolve => { ws.on('open', () => { resolve() }) })
    ws.send(JSON.stringify(envelope('hello', { machineId })))
    await waitFor(() => frames.some(f => f.kind === 'hello_ack'))
  })

  afterEach(async () => {
    ws.close()
    connector?.stop()
    browserHub.close()
    hub.close()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function sign(action: string, payload: Uint8Array, sessionId: string | null = null, extra: Partial<IntentBody> = {}): SignedIntent {
    const body: IntentBody = {
      v: 1, machineId, sessionId, action, nonce: randomBytes(16).toString('base64url'), ts: Date.now(), keyId: key.keyId,
      payloadHash: createHash('sha256').update(payload).digest('base64url'),
      ...extra,
    }
    const text = JSON.stringify(body)
    return { body: text, sig: signP1363(key.privateKey, Buffer.from(text)).toString('base64url') }
  }
  const send = (kind: string, payload: unknown, extra: { id?: string; channelId?: string }) => { ws.send(JSON.stringify(envelope(kind as 'hello', payload, extra))) }
  const reply = async (pred: (f: Frame) => boolean) => { await waitFor(() => frames.some(pred)); return frames.find(pred)! }
  const localCalls = (path: string) => localFetch.mock.calls.filter(c => String(c[0]).includes(path)).length

  it('tells the browser it sent the server time, for its clock', () => {
    expect(typeof frames.find(f => f.kind === 'hello_ack')?.payload.serverTime).toBe('number')
  })

  it('carries a signed request through the hub and runs it; refuses an unsigned one with the reason', async () => {
    const path = '/api/repos'
    send('request', { method: 'GET', path, intent: sign(requestAction('GET', path), requestPayload('GET', path, undefined, null)) }, { id: 'ok' })
    expect((await reply(f => f.id === 'ok')).kind).toBe('response')
    expect(localCalls('/api/repos')).toBe(1)

    send('request', { method: 'GET', path }, { id: 'bare' })
    const refused = await reply(f => f.id === 'bare')
    expect(refused).toMatchObject({ kind: 'error', payload: { code: 'not_permitted', detail: 'intent_required' } })
    expect(localCalls('/api/repos')).toBe(1)
  })

  it('refuses a request the relay altered, and tells the browser which intent', async () => {
    const intent = sign(requestAction('GET', '/api/repos'), requestPayload('GET', '/api/repos', undefined, null))
    send('request', { method: 'GET', path: '/api/repos?all=1', intent }, { id: 'x' })
    const refused = await reply(f => f.id === 'x')
    expect(refused.payload).toMatchObject({ detail: 'intent_wrong_payload', intentNonce: (JSON.parse(intent.body) as IntentBody).nonce })
  })

  it('opens a channel and forwards frames only when signed', async () => {
    const channel = randomBytes(16).toString('base64url')
    send('stream_open', { intent: sign('channel:open', new Uint8Array(), null, { channel }) }, { channelId: 'c1' })
    await reply(f => f.channelId === 'c1' && f.kind === 'event')
    const join = '{"type":"join_session","sessionId":"s1"}'
    send('stream_data', { data: join, intent: sign(frameAction(join), framePayload(join), 's1', { channel, seq: 1 }) }, { channelId: 'c1' })
    const input = '{"type":"input","data":"ls"}'
    send('stream_data', { data: input, intent: sign(frameAction(input), framePayload(input), 's1', { channel, seq: 2 }) }, { channelId: 'c1' })
    await waitFor(() => localSockets[0]?.received.length === 2)
    expect(localSockets[0].received).toEqual([join, input])

    // Unsigned: refused on the machine, reason passed back through the hub.
    send('stream_data', { data: '{"type":"stop"}' }, { channelId: 'c1' })
    const refused = await reply(f => f.channelId === 'c1' && f.kind === 'error')
    expect(refused.payload).toMatchObject({ code: 'not_permitted', detail: 'intent_required' })
    expect(localSockets[0].received).toHaveLength(2)

    const log = readRecentIntents(logFile, { limit: 100 }).reverse()
    expect(log.map(e => [e.action, e.verdict])).toEqual([
      ['channel:open', 'accepted'], ['ws:join_session', 'accepted'], ['ws:input', 'accepted'], ['ws:stop', 'unsigned'],
    ])
  })

  it('refuses an unsigned channel open', async () => {
    send('stream_open', {}, { channelId: 'c2' })
    const refused = await reply(f => f.channelId === 'c2' && f.kind === 'error')
    expect(refused.payload).toMatchObject({ detail: 'intent_required' })
    expect(localSockets).toHaveLength(0)
  })
})
