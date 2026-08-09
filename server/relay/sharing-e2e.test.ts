/**
 * A shared-in user, end to end: browser socket → hub → connector → local
 * server, with a real share in the database deciding what gets through.
 *
 * The point of these tests is that the *connector* refuses — the frames
 * never reach the local server — so the enforcement holds even if the hub
 * forwards something it should not have.
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
import { BrowserHub } from './browser-hub.js'
import { RelayConnector } from './connector.js'
import { envelope, RELAY_ERROR } from './relay-protocol.js'
import { SHARE_ROLES, deleteShare, upsertShare } from './shares.js'
import { listAuditEvents } from './audit.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { UserRow } from './control-plane-db.js'

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

/** Stand-in local Codekin server that records what actually reached it. */
class FakeLocalServer {
  readonly server: Server
  readonly received: string[] = []
  readonly sockets: WebSocket[] = []
  port = 0

  constructor() {
    this.server = createServer()
    const wss = new WebSocketServer({ server: this.server })
    wss.on('connection', socket => {
      this.sockets.push(socket)
      let authed = false
      socket.on('message', raw => {
        const text = raw.toString('utf-8')
        if (!authed) {
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

  send(payload: unknown): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close()
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
  }
}

class TestBrowser {
  readonly frames: Frame[] = []
  private ws: WebSocket

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', data => { this.frames.push(JSON.parse(data.toString('utf-8')) as Frame) })
  }

  get closeCode(): Promise<number> {
    return new Promise(resolve => this.ws.on('close', code => { resolve(code) }))
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

  close(): void { this.ws.close() }
}

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    login: row.login,
    displayName: null,
    avatarUrl: null,
    role: row.role,
    status: row.status,
  }
}


/** Calls the connector made to a given local path (it also polls sessions itself). */
function callsFor(mock: ReturnType<typeof vi.fn>, path: string): { headers: Record<string, string> }[] {
  return mock.mock.calls
    .filter(call => String(call[0]).includes(path))
    .map(call => call[1] as { headers: Record<string, string> })
}

describe('a shared-in user over the relay', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let browserHub: BrowserHub
  let server: Server
  let local: FakeLocalServer
  let browserUrl: string
  let machineId: string
  let owner: UserRow
  let guest: UserRow
  let connector: RelayConnector | null = null
  /** Which user the next /relay/browser upgrade authenticates as. */
  let connectingUser: SessionUser
  /** Stands in for the local server's HTTP side on the REST path. */
  let localFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    owner = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    )
    guest = upsertUserFromGithub(
      db,
      { id: 2, login: 'guest', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    )
    connectingUser = toSessionUser(guest)

    const { userCode, deviceCode } = startPairing(db, { hostname: 'box', platform: 'linux' })
    approvePairing(db, userCode, owner.id, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed')
    machineId = complete.machineId

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
        browserWss.handleUpgrade(req, socket, head, ws => { browserHub.handleConnection(ws, connectingUser) })
      } else {
        socket.destroy()
      }
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as AddressInfo).port
    browserUrl = `ws://127.0.0.1:${port}/relay/browser`

    // A fresh Response per call: a body can only be read once, and the
    // connector polls the session list itself on connect.
    localFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessions: [{ id: 's1', name: 'shared' }, { id: 's2', name: 'private' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    connector = new RelayConnector({
      relayUrl: `http://127.0.0.1:${port}`,
      machineId,
      machineSecret: complete.machineSecret,
      connectorVersion: 'test',
      localTarget: { origin: `http://127.0.0.1:${local.port}`, authToken: 'local-token' },
      fetchImpl: localFetch as never,
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))
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

  function share(permissions: string[], sessionId = 's1') {
    return upsertShare(db, {
      machineId,
      localSessionId: sessionId,
      sharedByUserId: owner.id,
      granteeUserId: guest.id,
      permissions: permissions as never,
    })
  }

  /** Connect, open a channel, and join the shared session. */
  async function joinedBrowser(sessionId = 's1'): Promise<TestBrowser> {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')
    browser.send('stream_open', {}, { channelId: 'c1' })
    await browser.waitForFrame(f => f.kind === 'event' && f.channelId === 'c1')
    browser.send('stream_data', { data: JSON.stringify({ type: 'join_session', sessionId }) }, { channelId: 'c1' })
    return browser
  }

  it('refuses a machine the user holds no share on', async () => {
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    expect(await browser.closeCode).toBe(4003)

    const denials = listAuditEvents(db, { machineId }).filter(e => e.kind === 'access_denied')
    expect(denials).toHaveLength(1)
  })

  it('admits a grantee and reports their role', async () => {
    share([...SHARE_ROLES.editor])
    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    const ack = await browser.waitForFrame(f => f.kind === 'hello_ack')

    expect(ack.payload.role).toBe('grantee')
    expect(Object.keys(ack.payload.grants as object)).toEqual(['s1'])
    browser.close()
  })

  it('forwards a prompt from an editor', async () => {
    share([...SHARE_ROLES.editor])
    const browser = await joinedBrowser()

    browser.send('stream_data', { data: JSON.stringify({ type: 'input', data: 'hello' }) }, { channelId: 'c1' })
    await waitFor(() => local.received.some(f => f.includes('"input"')))
    browser.close()
  })

  it('stops a viewer prompt at the connector, not the local server', async () => {
    share([...SHARE_ROLES.viewer])
    const browser = await joinedBrowser()

    browser.send('stream_data', { data: JSON.stringify({ type: 'input', data: 'hello' }) }, { channelId: 'c1' })
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.channelId === 'c1')

    expect(err.payload.code).toBe(RELAY_ERROR.notPermitted)
    expect(local.received.some(f => f.includes('"input"'))).toBe(false)
    browser.close()
  })

  it('refuses joining a session that was not shared', async () => {
    share([...SHARE_ROLES.editor], 's1')
    const browser = await joinedBrowser('s2')

    const err = await browser.waitForFrame(f => f.kind === 'error' && f.channelId === 'c1')
    expect(err.payload.code).toBe(RELAY_ERROR.notPermitted)
    expect(local.received.some(f => f.includes('join_session'))).toBe(false)
    browser.close()
  })

  it('refuses a shell approval for an editor but allows a read-only one', async () => {
    share([...SHARE_ROLES.editor])
    const browser = await joinedBrowser()
    await waitFor(() => local.received.some(f => f.includes('join_session')))

    local.send({ type: 'prompt', requestId: 'p1', promptType: 'permission', toolName: 'Read', question: '?', options: [] })
    local.send({ type: 'prompt', requestId: 'p2', promptType: 'permission', toolName: 'Bash', question: '?', options: [] })
    await browser.waitForFrame(f => f.kind === 'stream_data' && String(f.payload.data).includes('p2'))

    browser.send('stream_data', { data: JSON.stringify({ type: 'prompt_response', requestId: 'p1', value: 'yes' }) }, { channelId: 'c1' })
    await waitFor(() => local.received.some(f => f.includes('p1')))

    browser.send('stream_data', { data: JSON.stringify({ type: 'prompt_response', requestId: 'p2', value: 'yes' }) }, { channelId: 'c1' })
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.channelId === 'c1')
    expect(err.payload.code).toBe(RELAY_ERROR.notPermitted)
    expect(local.received.some(f => f.includes('p2'))).toBe(false)
    browser.close()
  })

  it('hides unshared sessions from a grantee listing them', async () => {
    share([...SHARE_ROLES.viewer], 's1')

    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browser.send('request', { method: 'GET', path: '/api/sessions/list' }, { id: 'r1' })
    const res = await browser.waitForFrame(f => f.kind === 'response' && f.id === 'r1')

    const body = JSON.parse(Buffer.from(res.payload.body as string, 'base64').toString()) as {
      sessions: { id: string; name: string }[]
    }
    // The local server returned both; only the shared one left the machine
    expect(body.sessions).toEqual([{ id: 's1', name: 'shared' }])
    browser.close()
  })

  it('refuses a machine-wide read to a grantee', async () => {
    share([...SHARE_ROLES.editor])

    const browser = new TestBrowser(browserUrl)
    await browser.open()
    browser.send('hello', { machineId })
    await browser.waitForFrame(f => f.kind === 'hello_ack')

    browser.send('request', { method: 'GET', path: '/api/repos' }, { id: 'r1' })
    const err = await browser.waitForFrame(f => f.kind === 'error' && f.id === 'r1')

    expect(err.payload.code).toBe(RELAY_ERROR.notPermitted)
    expect(callsFor(localFetch, '/api/repos')).toHaveLength(0)
    browser.close()
  })

  it('cuts off access as soon as the share is revoked', async () => {
    const created = share([...SHARE_ROLES.editor])
    const first = new TestBrowser(browserUrl)
    await first.open()
    first.send('hello', { machineId })
    await first.waitForFrame(f => f.kind === 'hello_ack')
    first.close()

    deleteShare(db, created.id)

    const second = new TestBrowser(browserUrl)
    await second.open()
    second.send('hello', { machineId })
    expect(await second.closeCode).toBe(4003)
  })

  it('still gives the owner unrestricted access', async () => {
    connectingUser = toSessionUser(owner)
    const browser = await joinedBrowser('any-session-at-all')

    browser.send('stream_data', { data: JSON.stringify({ type: 'set_model', model: 'x' }) }, { channelId: 'c1' })
    await waitFor(() => local.received.some(f => f.includes('set_model')))
    browser.close()
  })
})
