/**
 * End-to-end REST proxy: browser socket → hub → connector → local server.
 * The local Codekin server is stubbed with an injected fetch so the test
 * exercises the relay path, not the app's routes.
 */
import { BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing, removeMachine } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { BrowserHub, accessFingerprint } from './browser-hub.js'
import { listAuditEvents } from './audit.js'
import { RelayConnector } from './connector.js'
import { envelope, RELAY_ERROR } from './relay-protocol.js'
import type { SessionUser } from './relay-auth-routes.js'

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('waitFor timeout'))
      }
    }, 20)
  })
}

interface Frame {
  kind: string
  id?: string
  channelId?: string
  payload: Record<string, unknown>
}

/** Minimal browser client: connect, hello, and await frames by kind/id. */
class TestBrowser {
  readonly frames: Frame[] = []
  private ws: WebSocket

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', data => {
      this.frames.push(JSON.parse(data.toString('utf-8')) as Frame)
    })
  }

  get closeCode(): Promise<number> {
    return new Promise(resolve => this.ws.on('close', code => { resolve(code) }))
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.on('open', () => { resolve() })
      this.ws.on('error', err => { reject(err) })
    })
  }

  send(kind: string, payload: unknown, id?: string): void {
    this.ws.send(JSON.stringify(envelope(kind as 'hello', payload, id ? { id } : undefined)))
  }

  sendOnChannel(kind: string, payload: unknown, channelId: string): void {
    this.ws.send(JSON.stringify(envelope(kind as 'stream_open', payload, { channelId })))
  }

  async waitForFrame(predicate: (f: Frame) => boolean): Promise<Frame> {
    await waitFor(() => this.frames.some(predicate))
    return this.frames.find(predicate)!
  }

  close(): void {
    this.ws.close()
  }
}


/** Calls the connector made to a given local path (it also polls sessions itself). */
function callsFor(mock: ReturnType<typeof vi.fn>, path: string): { headers: Record<string, string> }[] {
  return mock.mock.calls
    .filter(call => String(call[0]).includes(path))
    .map(call => call[1] as { headers: Record<string, string> })
}

describe('browser hub REST proxy', () => {
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
  let localFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const ownerRow = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    owner = {
      id: ownerRow.id,
      login: ownerRow.login,
      displayName: null,
      avatarUrl: null,
      status: ownerRow.status,
    }

    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, owner.id, BOOTSTRAP_WORKSPACE_ID, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed in setup')
    machineId = complete.machineId
    machineSecret = complete.machineSecret

    hub = new ConnectorHub(db)
    browserHub = new BrowserHub(db, hub)

    server = createServer()
    const connectorWss = new WebSocketServer({ noServer: true })
    connectorWss.on('connection', socket => { hub.handleConnection(socket) })
    const browserWss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/relay/connector') {
        connectorWss.handleUpgrade(req, socket, head, ws => connectorWss.emit('connection', ws, req))
      } else if (path === '/relay/browser') {
        browserWss.handleUpgrade(req, socket, head, ws => { browserHub.handleConnection(ws, owner) })
      } else {
        socket.destroy()
      }
    })

    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port
    relayUrl = `http://127.0.0.1:${port}`
    browserUrl = `ws://127.0.0.1:${port}/relay/browser`

    // A fresh Response per call: a body can only be read once, and the
    // connector polls the session list itself on connect.
    localFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessions: [{ id: 's1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
  })

  afterEach(async () => {
    connector?.stop()
    connector = null
    browserHub.close()
    hub.close()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  async function startConnector(): Promise<void> {
    connector = new RelayConnector({
      relayUrl,
      machineId,
      machineSecret,
      connectorVersion: '0.10.0-test',
      localTarget: { origin: 'http://127.0.0.1:32352', authToken: 'local-token' },
      fetchImpl: localFetch as never,
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))
  }

  it('proxies a read-only request to the machine and returns its response', async () => {
    await startConnector()

    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    const ack = await browser.waitForFrame(f => f.kind === 'hello_ack')
    expect(ack.payload.online).toBe(true)
    expect(ack.payload.displayName).toBe('Dev box')

    browser.send('request', { method: 'GET', path: '/api/sessions/list' }, 'r1')
    const res = await browser.waitForFrame(f => f.kind === 'response' && f.id === 'r1')

    expect(res.payload.status).toBe(200)
    expect(JSON.parse(Buffer.from(res.payload.body as string, 'base64').toString())).toEqual({
      sessions: [{ id: 's1' }],
    })
    // The connector supplied the local credential; the browser never sees it
    expect(callsFor(localFetch, '/api/sessions/list')[0].headers.Authorization).toBe('Bearer local-token')
    browser.close()
  })

  it('audits uploads and REST session creation by size and id, never by content', async () => {
    localFetch.mockImplementation((url: string) => Promise.resolve(new Response(
      JSON.stringify(String(url).includes('/api/sessions/create') ? { sessionId: 'sess-rest', session: {} } : { sessions: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    const file = Buffer.from('screenshot bytes: confidential.png')
    browser.send('request', { method: 'POST', path: '/api/upload', contentType: 'image/png; charset=binary', body: file.toString('base64') }, 'u1')
    browser.send('request', { method: 'POST', path: '/api/sessions/create', contentType: 'application/json', body: Buffer.from('{"name":"secret-project","workingDir":"/x"}').toString('base64') }, 'c1')
    await browser.waitForFrame(f => f.kind === 'response' && f.id === 'u1')
    await browser.waitForFrame(f => f.kind === 'response' && f.id === 'c1')

    const [created, uploaded] = listAuditEvents(db, { machineId, kinds: ['file_uploaded', 'session_created'] })
    expect(uploaded.kind).toBe('file_uploaded')
    expect(uploaded.metadata).toMatchObject({ bytes: file.length, contentType: 'image/png', role: 'owner' })
    expect(created).toMatchObject({ kind: 'session_created', localSessionId: 'sess-rest', metadata: { via: 'rest' } })
    expect(JSON.stringify(listAuditEvents(db, { machineId }))).not.toMatch(/confidential|secret-project/)
    browser.close()
  })

  it('drops browser-supplied headers instead of forwarding them to the machine', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browser.send(
      'request',
      { method: 'GET', path: '/api/sessions/list', headers: { Authorization: 'Bearer forged' } },
      'r1',
    )
    await browser.waitForFrame(f => f.kind === 'response' && f.id === 'r1')

    expect(callsFor(localFetch, '/api/sessions/list')[0].headers.Authorization).toBe('Bearer local-token')
    browser.close()
  })

  it('refuses a path the connector does not proxy', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browser.send('request', { method: 'GET', path: '/api/hook-config' }, 'r1')
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.id === 'r1')

    expect(err.payload.code).toBe(RELAY_ERROR.pathNotAllowed)
    expect(callsFor(localFetch, '/api/hook-config')).toHaveLength(0)
    browser.close()
  })

  it('answers machine_offline when no connector is attached', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    const ack = await browser.waitForFrame(f => f.kind === 'hello_ack')
    expect(ack.payload.online).toBe(false)

    browser.send('request', { method: 'GET', path: '/api/sessions/list' }, 'r1')
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.id === 'r1')
    expect(err.payload.code).toBe(RELAY_ERROR.machineOffline)
    browser.close()
  })

  it('fails in-flight requests when the connector drops', async () => {
    // A connector that accepts the request and never answers
    let release: (() => void) | null = null
    localFetch.mockImplementation(() => new Promise(resolve => { release = () => { resolve(new Response('')) } }))
    await startConnector()

    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')
    browser.send('request', { method: 'GET', path: '/api/health' }, 'r1')
    await waitFor(() => localFetch.mock.calls.length > 0)

    connector!.stop()
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.id === 'r1')
    expect(err.payload.code).toBe(RELAY_ERROR.machineOffline)

    release?.()
    browser.close()
  })

  describe('quotas', () => {
    function useLimits(limits: Record<string, number>): void {
      browserHub.close()
      browserHub = new BrowserHub(db, hub, { entitlements: { limitsFor: () => limits } })
    }

    it('refuses a browser connection past the per-user limit, with a close code the app will not retry', async () => {
      useLimits({ browserSocketsPerUser: 1 })
      const first = new TestBrowser(browserUrl)
      await first.open()
      first.send('hello', { machineId })
      await first.waitForFrame(f => f.kind === 'hello_ack')

      const second = new TestBrowser(browserUrl)
      await second.open()
      const closed = second.closeCode
      second.send('hello', { machineId })
      expect(await closed).toBe(4030)

      // Closing the first frees the slot.
      first.close()
      await waitFor(() => browserHub.clientCount === 0)
      const third = new TestBrowser(browserUrl)
      await third.open()
      third.send('hello', { machineId })
      await third.waitForFrame(f => f.kind === 'hello_ack')
      third.close()
    })

    it('refuses a session stream past the per-user channel limit', async () => {
      useLimits({ channelsPerUser: 0 })
      await startConnector()
      const browser = new TestBrowser(browserUrl)
      await browser.open()
      browser.send('hello', { machineId })
      await browser.waitForFrame(f => f.kind === 'hello_ack')
      browser.sendOnChannel('stream_open', {}, 'c1')
      const refusal = await browser.waitForFrame(f => f.channelId === 'c1')
      expect(refusal.kind).toBe('error')
      expect(refusal.payload).toMatchObject({ code: 'quota_exceeded' })
      expect(hub.channelCount).toBe(0)
      browser.close()
    })
  })

  it('closes the socket for a machine the user does not own', async () => {
    const otherMachine = 'machine-that-is-not-theirs'
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId: otherMachine })
    expect(await browser.closeCode).toBe(4003)
  })

  it('reauthorize drops an open socket once the user is disabled in the database', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    // Access was resolved at hello; disabling the user must not leave the
    // already-open socket working.
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(owner.id)
    browserHub.reauthorize()

    expect(await browser.closeCode).toBe(4003)
  })

  it('reauthorize drops an open socket once its machine is removed', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    removeMachine(db, machineId)
    browserHub.reauthorize({ machineId })

    expect(await browser.closeCode).toBe(4003)
  })

  it('reauthorize keeps sockets whose access is unchanged', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browserHub.reauthorize()

    browser.send('ping', {})
    await browser.waitForFrame(f => f.kind === 'pong')
    browser.close()
  })

  it('closes the socket when the first frame is not hello', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('request', { method: 'GET', path: '/api/health' }, 'r1')
    expect(await browser.closeCode).toBe(4001)
  })

  it('closes a socket that floods the hub with frames', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    // Well past the per-user burst allowance (120)
    for (let i = 0; i < 400; i++) {
      browser.send('ping', {})
    }

    expect(await browser.closeCode).toBe(4029)
  })
})

describe('accessFingerprint', () => {
  it('is blind to the order grants and permissions come back in', () => {
    // Same standing, different iteration order: the periodic sweep must read
    // this as "nothing changed" rather than closing a healthy socket.
    const a = { kind: 'grantee', grants: { s1: ['read', 'write'], s2: ['read'] } } as const
    const b = { kind: 'grantee', grants: { s2: ['read'], s1: ['write', 'read'] } } as const
    expect(accessFingerprint(a)).toBe(accessFingerprint(b))
  })

  it('separates every standing that actually differs', () => {
    const grantee = { kind: 'grantee', grants: { s1: ['read'] } } as const
    const widened = { kind: 'grantee', grants: { s1: ['read', 'write'] } } as const
    const extraSession = { kind: 'grantee', grants: { s1: ['read'], s2: ['read'] } } as const

    const prints = [
      accessFingerprint({ kind: 'owner' }),
      accessFingerprint({ kind: 'none' }),
      accessFingerprint(grantee),
      accessFingerprint(widened),
      accessFingerprint(extraSession),
    ]
    expect(new Set(prints).size).toBe(prints.length)
  })

  it('does not confuse a session id with the permissions it carries', () => {
    // A naive join on a separator would collide these two.
    const a = { kind: 'grantee', grants: { 'a:read': [] } } as const
    const b = { kind: 'grantee', grants: { a: ['read'] } } as const
    expect(accessFingerprint(a)).not.toBe(accessFingerprint(b))
  })
})
