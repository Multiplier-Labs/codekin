/**
 * The connector reports its intent policy (signed-intents spec §6.8) only to
 * a relay that understands the report, and shows the relay's verdict on
 * "Require confirmed devices" in its status.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { RelayConnector } from './connector.js'
import { envelope, parseEnvelope } from './relay-protocol.js'
import type { ConnectorHelloAck } from './relay-protocol.js'

let wss: WebSocketServer | null = null
let connector: RelayConnector | null = null

afterEach(async () => {
  connector?.stop()
  connector = null
  await new Promise<void>(resolve => { if (wss) wss.close(() => { resolve() }); else resolve() })
  wss = null
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A relay that answers hello with `ack` and records every frame kind it gets. */
async function relay(ack: Partial<ConnectorHelloAck>): Promise<{ url: string; kinds: string[]; hello: () => Record<string, unknown> | null; socket: () => WebSocket | null }> {
  const kinds: string[] = []
  let hello: Record<string, unknown> | null = null
  let socket: WebSocket | null = null
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', ws => {
    socket = ws
    ws.on('message', data => {
      const msg = parseEnvelope(String(data))
      if (!msg) return
      kinds.push(msg.kind)
      if (msg.kind === 'hello') {
        hello = msg.payload as Record<string, unknown>
        ws.send(JSON.stringify(envelope('hello_ack', { machineId: 'm1', displayName: 'Dev box', ...ack })))
      }
    })
  })
  await new Promise<void>(resolve => { wss!.once('listening', () => { resolve() }) })
  return { url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, kinds, hello: () => hello, socket: () => socket }
}

function start(url: string, policyOf: () => 'off' | 'warn' | 'required', statuses: Array<{ status: string; detail?: string }> = []) {
  connector = new RelayConnector({
    relayUrl: url, machineId: 'm1', machineSecret: 's', connectorVersion: '0.10.6', policyWatchMs: 10,
    intents: { checkRequest: () => ({}) as never, checkChannelOpen: () => ({}) as never, checkFrame: () => ({}) as never, policy: policyOf },
    onStatus: (status, detail) => { statuses.push({ status, detail }) },
  })
  connector.start()
}

describe('connector policy reports', () => {
  it('reports its policy in hello, and changes only to a relay that announced it understands them', async () => {
    const old = await relay({})
    let policy: 'off' | 'warn' | 'required' = 'off'
    start(old.url, () => policy)
    await sleep(80)
    expect(old.hello()?.intentPolicy).toBe('off')
    policy = 'required'
    await sleep(80)
    // An older relay would close the socket on the unknown kind.
    expect(old.kinds).not.toContain('intent_policy')
  })

  it('sends a change within the watch interval to a relay that announced it', async () => {
    const current = await relay({ policyReports: true })
    let policy: 'off' | 'warn' | 'required' = 'off'
    start(current.url, () => policy)
    await sleep(60)
    policy = 'required'
    await sleep(80)
    expect(current.kinds.filter(k => k === 'intent_policy')).toHaveLength(1)
  })

  it('shows the relay refusing it for unconfirmed devices, and recovering, without hiding an update requirement', async () => {
    const r = await relay({ policyReports: true, unconfirmed: true })
    const statuses: Array<{ status: string; detail?: string }> = []
    start(r.url, () => 'off', statuses)
    await sleep(60)
    expect(statuses.at(-1)?.status).toBe('devices_unconfirmed')
    r.socket()!.send(JSON.stringify(envelope('event', { unconfirmed: false })))
    await sleep(40)
    expect(statuses.at(-1)).toEqual({ status: 'connected', detail: 'Dev box' })
  })

  it('keeps an update requirement in its status whatever the relay says about devices', async () => {
    const r = await relay({ updateRequired: { minimum: '0.11.0', missing: [], reason: 'too old' } })
    const statuses: Array<{ status: string; detail?: string }> = []
    start(r.url, () => 'off', statuses)
    await sleep(60)
    r.socket()!.send(JSON.stringify(envelope('event', { unconfirmed: false })))
    await sleep(40)
    expect(statuses.at(-1)?.status).toBe('update_required')
  })
})
