/**
 * Session streaming end to end: browser socket → hub → connector → a stand-in
 * local Codekin server, including the local auth handshake the connector
 * performs on the browser's behalf.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { BrowserHub } from './browser-hub.js'
import { RelayConnector } from './connector.js'
import { envelope, MAX_CHANNELS_PER_CLIENT, RELAY_ERROR, STREAM_CLOSE } from './relay-protocol.js'
import { localWsUrl, StreamChannel } from './connector-stream.js'
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

/** Stand-in for the local Codekin server's WebSocket endpoint. */
class FakeLocalServer {
  readonly server: Server
  readonly wss: WebSocketServer
  /** Tokens seen in `auth` frames. */
  readonly authTokens: string[] = []
  /** Frames received after authentication. */
  readonly received: string[] = []
  readonly sockets: WebSocket[] = []
  /** When set, the auth frame is rejected with 4001. */
  rejectAuth = false
  port = 0

  constructor() {
    this.server = createServer()
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', socket => {
      this.sockets.push(socket)
      let authed = false
      socket.on('message', raw => {
        const text = raw.toString('utf-8')
        const msg = JSON.parse(text) as { type?: string; token?: string }
        if (!authed) {
          this.authTokens.push(msg.token ?? '')
          if (msg.type !== 'auth' || this.rejectAuth) {
            socket.close(4001, 'Unauthorized')
            return
          }
          authed = true
          socket.send(JSON.stringify({ type: 'connected', connectionId: 'local-1' }))
          return
        }
        this.received.push(text)
      })
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>(resolve => { this.server.listen(0, '127.0.0.1', () => { resolve() }) })
    this.port = (this.server.address() as AddressInfo).port
  }

  broadcast(payload: unknown): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close()
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
  }
}

/** Minimal browser client speaking the relay envelope protocol. */
class TestBrowser {
  readonly frames: Frame[] = []
  private ws: WebSocket

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', data => {
      this.frames.push(JSON.parse(data.toString('utf-8')) as Frame)
    })
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.on('open', () => { resolve() })
      this.ws.on('error', err => { reject(err) })
    })
  }

  send(kind: string, payload: unknown, extra: { id?: string; channelId?: string } = {}): void {
    this.ws.send(JSON.stringify(envelope(kind as 'hello', payload, extra)))
  }

  async waitForFrame(predicate: (f: Frame) => boolean): Promise<Frame> {
    await waitFor(() => this.frames.some(predicate))
    return this.frames.find(predicate)!
  }

  close(): void {
    this.ws.close()
  }
}

describe('localWsUrl', () => {
  it('converts the local origin to its WebSocket root', () => {
    expect(localWsUrl('http://127.0.0.1:32352')).toBe('ws://127.0.0.1:32352/')
    expect(localWsUrl('https://box.example')).toBe('wss://box.example/')
  })
})

describe('local Origin header', () => {
  /**
   * A local server running with NODE_ENV=production rejects a WebSocket
   * whose Origin is not its CORS_ORIGIN, and the connector is not a browser
   * — so it must be told which origin to present.
   */
  it('presents the configured origin, and none when unconfigured', () => {
    const created: { url: string; options?: { origin?: string } }[] = []
    const factory = ((url: string, options?: { origin?: string }) => {
      created.push({ url, options })
      return { on: () => {}, close: () => {}, send: () => {}, readyState: 0 } as unknown as WebSocket
    }) as never

    const callbacks = { onReady: () => {}, onData: () => {}, onClose: () => {} }

    new StreamChannel(
      { origin: 'http://127.0.0.1:32352', authToken: 't', browserOrigin: 'https://app.example' },
      callbacks,
      factory,
    ).open()
    new StreamChannel({ origin: 'http://127.0.0.1:32352', authToken: 't' }, callbacks, factory).open()

    expect(created[0].options).toEqual({ origin: 'https://app.example' })
    expect(created[1].options).toBeUndefined()
  })
})

describe('session streaming over the relay', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let browserHub: BrowserHub
  let server: Server
  let local: FakeLocalServer
  let relayUrl: string
  let browserUrl: string
  let machineId: string
  let machineSecret: string
  let connector: RelayConnector | null = null

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const ownerRow = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      { ownerGithubLogin: 'alari76', allowedGithubLogins: [] },
    )
    const owner: SessionUser = {
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

    local = new FakeLocalServer()
    await local.listen()

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
  })

  afterEach(async () => {
    connector?.stop()
    connector = null
    browserHub.close()
    hub.close()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await local.close()
    db.close()
  })

  async function startConnector(): Promise<void> {
    connector = new RelayConnector({
      relayUrl,
      machineId,
      machineSecret,
      connectorVersion: 'test',
      localTarget: { origin: `http://127.0.0.1:${local.port}`, authToken: 'local-token' },
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))
  }

  /** Open a browser socket with an established channel. */
  async function openChannel(channelId = 'c1'): Promise<TestBrowser> {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')
    browser.send('stream_open', {}, { channelId })
    await browser.waitForFrame(f => f.kind === 'event' && f.channelId === channelId)
    return browser
  }

  it('authenticates to the local server with the machine token, not the browser', async () => {
    await startConnector()
    const browser = await openChannel()

    expect(local.authTokens).toEqual(['local-token'])
    browser.close()
  })

  it('answers the browser auth frame from the cached local handshake', async () => {
    await startConnector()
    const browser = await openChannel()

    // The frontend always sends its own auth frame on open
    browser.send('stream_data', { data: JSON.stringify({ type: 'auth', token: 'hosted-relay' }) }, { channelId: 'c1' })
    const connected = await browser.waitForFrame(
      f => f.kind === 'stream_data' && String(f.payload.data).includes('"connected"'),
    )

    expect(JSON.parse(connected.payload.data as string)).toEqual({ type: 'connected', connectionId: 'local-1' })
    // The browser's placeholder token never reached the local server
    expect(local.authTokens).toEqual(['local-token'])
    expect(local.received).toEqual([])
    browser.close()
  })

  it('pipes frames in both directions once open', async () => {
    await startConnector()
    const browser = await openChannel()

    browser.send('stream_data', { data: JSON.stringify({ type: 'input', text: 'hello' }) }, { channelId: 'c1' })
    await waitFor(() => local.received.length > 0)
    expect(JSON.parse(local.received[0])).toEqual({ type: 'input', text: 'hello' })

    local.broadcast({ type: 'claude_message', text: 'hi back' })
    const frame = await browser.waitForFrame(
      f => f.kind === 'stream_data' && String(f.payload.data).includes('claude_message'),
    )
    expect(JSON.parse(frame.payload.data as string)).toEqual({ type: 'claude_message', text: 'hi back' })
    browser.close()
  })

  it('closes the browser channel when the local socket goes away', async () => {
    await startConnector()
    const browser = await openChannel()

    local.sockets[0].close(1000, 'local server closed')
    const close = await browser.waitForFrame(f => f.kind === 'stream_close' && f.channelId === 'c1')
    expect(close.payload.code).toBe(1000)
    browser.close()
  })

  it('reports a rejected local credential as an auth failure', async () => {
    local.rejectAuth = true
    await startConnector()

    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')
    browser.send('stream_open', {}, { channelId: 'c1' })

    const close = await browser.waitForFrame(f => f.kind === 'stream_close' && f.channelId === 'c1')
    expect(close.payload.code).toBe(STREAM_CLOSE.localAuthFailed)
    browser.close()
  })

  it('closes the channel when the machine drops', async () => {
    await startConnector()
    const browser = await openChannel()

    connector!.stop()
    const close = await browser.waitForFrame(f => f.kind === 'stream_close' && f.channelId === 'c1')
    expect(close.payload.code).toBe(STREAM_CLOSE.machineGone)
    browser.close()
  })

  it('closes the local socket when the browser disconnects', async () => {
    await startConnector()
    const browser = await openChannel()
    expect(local.sockets).toHaveLength(1)

    browser.close()
    await waitFor(() => local.sockets[0].readyState === WebSocket.CLOSED)
  })

  it('refuses more channels than a client may hold', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    for (let i = 0; i < MAX_CHANNELS_PER_CLIENT; i++) {
      browser.send('stream_open', {}, { channelId: `c${i}` })
      await browser.waitForFrame(f => f.kind === 'event' && f.channelId === `c${i}`)
    }
    browser.send('stream_open', {}, { channelId: 'one-too-many' })

    const err = await browser.waitForFrame(f => f.kind === 'error' && f.channelId === 'one-too-many')
    expect(err.payload.code).toBe(RELAY_ERROR.tooManyChannels)
    browser.close()
  })

  it('scopes channel ids per browser, so one client cannot address another', async () => {
    await startConnector()
    const first = await openChannel('shared-id')
    const second = await openChannel('shared-id')

    // Both used the same local id; the hub gave the connector distinct ones
    expect(local.sockets).toHaveLength(2)

    second.send('stream_data', { data: JSON.stringify({ type: 'input', text: 'from second' }) }, { channelId: 'shared-id' })
    await waitFor(() => local.received.length > 0)

    // Exactly one local socket saw the frame
    expect(local.received).toHaveLength(1)
    first.close()
    second.close()
  })
})
