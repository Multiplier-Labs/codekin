/**
 * End-to-end REST proxy: browser socket → hub → connector → local server.
 * The local Codekin server is stubbed with an injected fetch so the test
 * exercises the relay path, not the app's routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { BrowserHub, canAccessMachine } from './browser-hub.js'
import { RelayConnector } from './connector.js'
import { envelope, RELAY_ERROR } from './relay-protocol.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { MachineRow } from './control-plane-db.js'

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

  async waitForFrame(predicate: (f: Frame) => boolean): Promise<Frame> {
    await waitFor(() => this.frames.some(predicate))
    return this.frames.find(predicate)!
  }

  close(): void {
    this.ws.close()
  }
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
      { ownerGithubLogin: 'alari76', allowedGithubLogins: [] },
    )
    owner = {
      id: ownerRow.id,
      login: ownerRow.login,
      displayName: null,
      avatarUrl: null,
      role: ownerRow.role,
      status: ownerRow.status,
    }

    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, owner.id, 'Dev box')
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

    localFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: [{ id: 's1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
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
      connectorVersion: 'test',
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
    expect(localFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer local-token')
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

    expect(localFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer local-token')
    browser.close()
  })

  it('refuses a path the connector does not proxy', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browser.send('request', { method: 'GET', path: '/api/webhooks/events' }, 'r1')
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.id === 'r1')

    expect(err.payload.code).toBe(RELAY_ERROR.pathNotAllowed)
    expect(localFetch).not.toHaveBeenCalled()
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

  it('closes the socket for a machine the user does not own', async () => {
    const otherMachine = 'machine-that-is-not-theirs'
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId: otherMachine })
    expect(await browser.closeCode).toBe(4003)
  })

  it('closes the socket when the first frame is not hello', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('request', { method: 'GET', path: '/api/health' }, 'r1')
    expect(await browser.closeCode).toBe(4001)
  })
})

describe('canAccessMachine', () => {
  const machine = { id: 'm1', owner_user_id: 'u1' } as MachineRow
  const active: SessionUser = {
    id: 'u1', login: 'a', displayName: null, avatarUrl: null, role: 'owner', status: 'active',
  }

  it('allows the machine owner', () => {
    expect(canAccessMachine(active, machine)).toBe(true)
  })

  it('refuses another user, a pending user, and an unknown machine', () => {
    expect(canAccessMachine({ ...active, id: 'u2' }, machine)).toBe(false)
    expect(canAccessMachine({ ...active, status: 'pending' }, machine)).toBe(false)
    expect(canAccessMachine(active, undefined)).toBe(false)
  })
})
