/** Integration tests: RelayConnector ↔ ConnectorHub over a real WebSocket server. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, listMachines } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { RelayConnector, connectorWsUrl } from './connector.js'
import { envelope } from './relay-protocol.js'

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

describe('connector hub', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let server: Server
  let relayUrl: string
  let machineId: string
  let machineSecret: string

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const userId = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      { ownerGithubLogin: 'alari76', allowedGithubLogins: [] },
    ).id

    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, userId, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed in setup')
    machineId = complete.machineId
    machineSecret = complete.machineSecret

    hub = new ConnectorHub(db)
    server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', socket => { hub.handleConnection(socket); })
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/relay/connector') {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
      } else {
        socket.destroy()
      }
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    hub.close()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  it('converts the relay origin to the connector wss url', () => {
    expect(connectorWsUrl('https://app.codekin.ai')).toBe('wss://app.codekin.ai/relay/connector')
    expect(connectorWsUrl('http://127.0.0.1:32360')).toBe('ws://127.0.0.1:32360/relay/connector')
  })

  it('a paired connector goes online, heartbeats, and goes offline on stop', async () => {
    const statuses: string[] = []
    const connector = new RelayConnector({
      relayUrl,
      machineId,
      machineSecret,
      connectorVersion: '0.8.0-test',
      onStatus: s => { statuses.push(s) },
    })
    connector.start()

    // The hub marks the machine online when it reads hello, before it sends
    // hello_ack — so isOnline alone does not mean the connector has seen the
    // ack that makes it report 'connected'. Gate on both signals.
    await waitFor(() => hub.isOnline(machineId) && statuses.includes('connected'))
    expect(statuses).toContain('connected')
    expect(listMachines(db)[0].status).toBe('online')
    expect(listMachines(db)[0].connector_version).toBe('0.8.0-test')

    connector.stop()
    await waitFor(() => !hub.isOnline(machineId))
    expect(listMachines(db)[0].status).toBe('offline')
  })

  it('rejects a bad credential with 4001 and the connector does not retry', async () => {
    const statuses: string[] = []
    const connector = new RelayConnector({
      relayUrl,
      machineId,
      machineSecret: 'wrong-secret',
      connectorVersion: '0.0.0',
      onStatus: s => { statuses.push(s) },
    })
    connector.start()

    await waitFor(() => statuses.includes('auth_failed'))
    expect(hub.isOnline(machineId)).toBe(false)
    expect(statuses).not.toContain('reconnect_scheduled')
  })

  it('rejects non-hello first frames', async () => {
    const ws = new WebSocket(connectorWsUrl(relayUrl))
    const closed = new Promise<number>(resolve => ws.on('close', code => { resolve(code) }))
    ws.on('open', () => {
      ws.send(JSON.stringify(envelope('ping', {})))
    })
    expect(await closed).toBe(4001)
  })

  it('destroys upgrades on unknown paths', async () => {
    const ws = new WebSocket(`${relayUrl.replace('http', 'ws')}/relay/other`)
    const failed = new Promise<boolean>(resolve => {
      ws.on('error', () => { resolve(true) })
      ws.on('open', () => { resolve(false) })
    })
    expect(await failed).toBe(true)
  })

  it('a second connection for the same machine replaces the first', async () => {
    const firstStatuses: string[] = []
    const first = new RelayConnector({
      relayUrl, machineId, machineSecret, connectorVersion: '1',
      onStatus: s => { firstStatuses.push(s) },
    })
    first.start()
    await waitFor(() => hub.isOnline(machineId))

    const second = new RelayConnector({
      relayUrl, machineId, machineSecret, connectorVersion: '2',
    })
    second.start()
    await waitFor(() => listMachines(db)[0].connector_version === '2')
    expect(hub.onlineCount).toBe(1)

    // The replaced connector stands down instead of taking the slot back:
    // two that both reconnect would trade it forever.
    await waitFor(() => firstStatuses.includes('replaced'))
    expect(firstStatuses).not.toContain('reconnect_scheduled')

    second.stop()
    first.stop()
  })

  it('the survivor keeps the machine online after a replacement', async () => {
    const first = new RelayConnector({ relayUrl, machineId, machineSecret, connectorVersion: '1' })
    first.start()
    await waitFor(() => hub.isOnline(machineId))

    const second = new RelayConnector({ relayUrl, machineId, machineSecret, connectorVersion: '2' })
    second.start()
    await waitFor(() => listMachines(db)[0].connector_version === '2')

    // Give the loser time to have flapped, if it were going to
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(hub.onlineCount).toBe(1)
    expect(listMachines(db)[0].status).toBe('online')

    second.stop()
    first.stop()
  })
})
