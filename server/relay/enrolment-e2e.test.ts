/**
 * The enrolment ceremony end to end: a browser socket → BrowserHub →
 * ConnectorHub → RelayConnector → the machine's trust store, with the code
 * typed locally (signed-intents spec §5.2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { generateKeyPairSync, randomBytes } from 'crypto'
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
import { envelope, RELAY_ERROR } from './relay-protocol.js'
import type { SessionUser } from './relay-auth-routes.js'
import { listAuditEvents } from './audit.js'
import { listDeviceKeys } from './device-keys.js'
import { upsertShare } from './shares.js'
import { MachineEnrolment, approveEnrolment } from './enrolment.js'
import { POP_LABEL, commitment, shortAuthString, signP1363, transcript } from './enrolment-crypto.js'
import { ensureMachineIdentity } from './machine-identity.js'
import { emptyTrustStore, readTrustStore, writeTrustStore } from './trust-store.js'

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve() } else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')) }
    }, 20)
  })
}

interface Frame { kind: string; id?: string; payload: Record<string, unknown> }

class TestBrowser {
  readonly frames: Frame[] = []
  private ws: WebSocket
  private next = 0
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', data => { this.frames.push(JSON.parse(data.toString('utf-8')) as Frame) })
  }
  async hello(machineId: string): Promise<Frame> {
    await new Promise<void>((resolve, reject) => { this.ws.on('open', () => { resolve() }); this.ws.on('error', reject) })
    this.ws.send(JSON.stringify(envelope('hello', { machineId })))
    await waitFor(() => this.frames.some(f => f.kind === 'hello_ack'))
    return this.frames.find(f => f.kind === 'hello_ack')!
  }
  /** Send one enrol frame and wait for its answer (a reply kind or an error). */
  async call(kind: string, payload: unknown): Promise<Frame> {
    const id = `e${++this.next}`
    this.ws.send(JSON.stringify(envelope(kind as 'hello', payload, { id })))
    await waitFor(() => this.frames.some(f => f.id === id))
    return this.frames.find(f => f.id === id)!
  }
  close(): void { this.ws.close() }
}

describe('enrolment over the relay', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let browserHub: BrowserHub
  let server: Server
  let relayUrl: string
  let browserUrl: string
  let machineId: string
  let machineSecret: string
  let owner: SessionUser
  let guest: SessionUser
  let socketUser: SessionUser
  let connector: RelayConnector | null = null
  let dir: string
  let devicesFile: string
  let identityFile: string

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const ownerRow = upsertUserFromGithub(db, { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    const guestRow = upsertUserFromGithub(db, { id: 2, login: 'guest', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    owner = { id: ownerRow.id, login: ownerRow.login, displayName: null, avatarUrl: null, status: ownerRow.status }
    guest = { id: guestRow.id, login: guestRow.login, displayName: null, avatarUrl: null, status: guestRow.status }
    socketUser = owner

    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, owner.id, BOOTSTRAP_WORKSPACE_ID, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed in setup')
    machineId = complete.machineId
    machineSecret = complete.machineSecret

    dir = mkdtempSync(join(tmpdir(), 'codekin-enrol-e2e-'))
    identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    ensureMachineIdentity(machineId, 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    writeTrustStore(devicesFile, emptyTrustStore(machineId, 'https://relay.test', owner.id))

    hub = new ConnectorHub(db)
    browserHub = new BrowserHub(db, hub)
    server = createServer()
    const connectorWss = new WebSocketServer({ noServer: true })
    connectorWss.on('connection', socket => { hub.handleConnection(socket) })
    const browserWss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/relay/connector') connectorWss.handleUpgrade(req, socket, head, ws => connectorWss.emit('connection', ws, req))
      else if (path === '/relay/browser') browserWss.handleUpgrade(req, socket, head, ws => { browserHub.handleConnection(ws, socketUser) })
      else socket.destroy()
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
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startConnector(withEnrolment = true): Promise<void> {
    connector = new RelayConnector({
      relayUrl, machineId, machineSecret, connectorVersion: '0.10.6-test',
      localTarget: { origin: 'http://127.0.0.1:1', authToken: 't' },
      fetchImpl: (() => Promise.resolve(new Response('{"sessions":[]}'))) as never,
      ...(withEnrolment ? { enrolment: new MachineEnrolment({ machineId, identityFile, devicesFile, secretStore: null }) } : {}),
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))
  }

  function browserKey(label = 'Firefox · Linux') {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spki = publicKey.export({ format: 'der', type: 'spki' })
    const nonceB = randomBytes(32)
    return { spki, privateKey: privateKey as KeyObject, nonceB, label, commit: commitment(spki, [], label, nonceB) }
  }

  it('enrols a browser: commit, reveal, code typed on the machine, approval polled', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.hello(machineId)
    const b = browserKey()

    const challenge = await browser.call('enrol_commit', { commit: b.commit.toString('base64url') })
    expect(challenge.kind).toBe('enrol_challenge')
    const { enrolId, nonceM, machineKey } = challenge.payload as { enrolId: string; nonceM: string; machineKey: string }

    const revealed = await browser.call('enrol_reveal', {
      enrolId, spki: b.spki.toString('base64url'), passkeys: [], label: b.label, nonceB: b.nonceB.toString('base64url'),
      pop: signP1363(b.privateKey, transcript(POP_LABEL, enrolId, Buffer.from(nonceM, 'base64url'))).toString('base64url'),
    })
    expect(revealed).toMatchObject({ kind: 'enrol_result', payload: { enrolId, state: 'awaiting_code' } })

    // The relay registry learned the key; the audit names it, nothing else.
    expect(listDeviceKeys(db, owner.id)).toEqual([expect.objectContaining({ label: b.label, spki: b.spki.toString('base64url') })])
    expect(listAuditEvents(db, { machineId, kinds: ['device_enrolment_requested'] })).toHaveLength(1)

    expect((await browser.call('enrol_status', { enrolId })).payload.state).toBe('awaiting_code')
    const code = shortAuthString(Buffer.from(machineKey, 'base64url'), b.spki, [], b.nonceB, Buffer.from(nonceM, 'base64url'))
    approveEnrolment(code, devicesFile, machineId)
    const done = await browser.call('enrol_status', { enrolId })
    expect(done).toMatchObject({ kind: 'enrol_result', payload: { state: 'approved' } })
    expect(readTrustStore(devicesFile)?.credentials).toEqual([expect.objectContaining({ userId: owner.id, label: b.label })])
    browser.close()
  })

  it('a grantee can not enrol, at the hub', async () => {
    await startConnector()
    upsertShare(db, { machineId, localSessionId: 's1', sharedByUserId: owner.id, granteeUserId: guest.id, permissions: ['view'] as never })
    socketUser = guest
    const browser = new TestBrowser(browserUrl)
    expect((await browser.hello(machineId)).payload.role).toBe('grantee')
    const reply = await browser.call('enrol_commit', { commit: browserKey().commit.toString('base64url') })
    expect(reply).toMatchObject({ kind: 'error', payload: { code: RELAY_ERROR.notPermitted } })
    expect(readTrustStore(devicesFile)?.pending).toEqual([])
    browser.close()
  })

  it('passes the machine refusal back to the browser', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.hello(machineId)
    const reply = await browser.call('enrol_reveal', {
      enrolId: 'no-such-request', spki: browserKey().spki.toString('base64url'), passkeys: [], label: 'x',
      nonceB: randomBytes(32).toString('base64url'), pop: randomBytes(64).toString('base64url'),
    })
    expect(reply).toMatchObject({ kind: 'error', payload: { code: RELAY_ERROR.enrolRefused } })
    expect(listDeviceKeys(db, owner.id)).toEqual([])
    browser.close()
  })

  it('answers at once for a connector that predates enrolment', async () => {
    await startConnector(false)
    const browser = new TestBrowser(browserUrl)
    await browser.hello(machineId)
    const reply = await browser.call('enrol_commit', { commit: browserKey().commit.toString('base64url') })
    expect(reply).toMatchObject({ kind: 'error', payload: { code: RELAY_ERROR.connectorUpdateRequired } })
    browser.close()
  })

  it('refuses malformed enrol frames at the hub', async () => {
    await startConnector()
    const browser = new TestBrowser(browserUrl)
    await browser.hello(machineId)
    // Not base64url: the hub drops the socket as it does any invalid frame.
    const closed = new Promise<number>(resolve => { (browser as unknown as { ws: WebSocket }).ws.on('close', code => { resolve(code) }) })
    ;(browser as unknown as { ws: WebSocket }).ws.send(JSON.stringify(envelope('enrol_commit' as 'hello', { commit: '<script>' }, { id: 'bad' })))
    expect(await closed).toBe(1008)
  })
})
