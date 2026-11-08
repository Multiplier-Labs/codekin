/**
 * GitHub webhooks through the relay, end to end: owner endpoints, the public
 * receiver, a real ConnectorHub and a real RelayConnector, with the local
 * server stubbed at the fetch boundary.
 */
import { signInFully } from './__fixtures__/auth.js'
import { BOOTSTRAP_WORKSPACE_ID, openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import { createServer } from 'http'
import type { Server } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import type Database from 'better-sqlite3'
import { startPairing, approvePairing, completePairing, removeMachine } from './pairing.js'
import { ConnectorHub } from './connector-hub.js'
import { RelayConnector } from './connector.js'
import { WebhookReplayGuard, WEBHOOK_RETENTION_MS } from './connector-webhook-guard.js'
import { createMachineWebhookRouter, createWebhookIngressRouter } from './machine-webhook-routes.js'
import { listAuditEvents } from './audit.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { FetchLike } from './connector-proxy.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve() }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')) }
    }, 20)
  })
}

interface LocalCall { url: string; headers: Record<string, string>; body: Buffer }

describe('GitHub webhooks through the relay', () => {
  let db: Database.Database
  let hub: ConnectorHub
  let server: Server
  let baseUrl: string
  let machineId: string
  let machineSecret: string
  let owner: SessionUser
  let other: SessionUser
  let connector: RelayConnector | null = null
  let localCalls: LocalCall[]
  let localStatus: number
  let ingressClose: () => void

  beforeEach(async () => {
    db = openControlPlaneDb(':memory:')
    const ownerRow = upsertUserFromGithub(db, { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    const otherRow = upsertUserFromGithub(db, { id: 2, login: 'someone', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2] })
    owner = { id: ownerRow.id, login: ownerRow.login, displayName: null, avatarUrl: null, status: ownerRow.status }
    other = { id: otherRow.id, login: otherRow.login, displayName: null, avatarUrl: null, status: otherRow.status }

    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    approvePairing(db, userCode, owner.id, BOOTSTRAP_WORKSPACE_ID, 'Dev box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed in setup')
    machineId = complete.machineId
    machineSecret = complete.machineSecret

    hub = new ConnectorHub(db)
    const ingress = createWebhookIngressRouter(db, hub)
    ingressClose = () => { ingress.close() }
    const app = express()
    app.use(ingress)
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const who = req.headers['x-test-user'] === 'owner' ? owner : req.headers['x-test-user'] === 'other' ? other : null
      if (who) { req.session.user = who; signInFully(db, req.session, who.id) }
      next()
    })
    app.use(createMachineWebhookRouter(db, { publicUrl: 'https://relay.example.com', ownerGithubId: 1 }))

    server = createServer(app)
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', socket => { hub.handleConnection(socket) })
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    localCalls = []
    localStatus = 202
  })

  afterEach(async () => {
    connector?.stop()
    connector = null
    hub.close()
    ingressClose()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  async function connect(guard = new WebhookReplayGuard(null)): Promise<void> {
    const fetchImpl: FetchLike = (url, init) => {
      const headers = init.headers as Record<string, string>
      localCalls.push({ url, headers, body: Buffer.from(init.body as unknown as Uint8Array) })
      return Promise.resolve(new Response(JSON.stringify({ accepted: true }), {
        status: localStatus, headers: { 'content-type': 'application/json' },
      }))
    }
    connector = new RelayConnector({
      relayUrl: baseUrl,
      machineId,
      machineSecret,
      connectorVersion: '0.10.6-test',
      localTarget: { origin: 'http://local.invalid', authToken: 'local-token' },
      fetchImpl,
      webhookGuard: guard,
      onStatus: () => {},
    })
    connector.start()
    await waitFor(() => hub.isOnline(machineId))
  }

  async function enable(as = 'owner'): Promise<Response> {
    return fetch(`${baseUrl}/api/machines/${machineId}/webhook`, { method: 'POST', headers: { 'x-test-user': as } })
  }

  async function enabledUrlPath(): Promise<string> {
    const res = await enable()
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url.startsWith('https://relay.example.com/api/hooks/github/')).toBe(true)
    return new URL(url).pathname
  }

  // One fixed event: a replay resends exactly the same signed bytes.
  const EVENT_AT = new Date().toISOString()

  function deliver(path: string, opts: { delivery?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const body = opts.body ?? JSON.stringify({ action: 'completed', workflow_run: { id: 1, updated_at: EVENT_AT } })
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'workflow_run',
        'x-github-delivery': opts.delivery ?? 'd-1',
        'x-hub-signature-256': 'sha256=abc123',
        'x-not-forwarded': 'nope',
        ...opts.headers,
      },
      body,
    })
  }

  it('only the owner can turn a receiver on or see its URL', async () => {
    expect((await enable('other')).status).toBe(403)
    const path = await enabledUrlPath()
    const status = await fetch(`${baseUrl}/api/machines/${machineId}/webhook`, { headers: { 'x-test-user': 'owner' } })
    const summary = (await status.json()) as { enabled: boolean; url: string | null }
    expect(summary.enabled).toBe(true)
    expect(summary.url).toBe(`https://relay.example.com${path}`)
    const asOther = await fetch(`${baseUrl}/api/machines/${machineId}/webhook`, { headers: { 'x-test-user': 'other' } })
    expect(asOther.status).toBe(403)
    expect(await asOther.text()).not.toContain(path.split('/').pop())
  })

  it('forwards the exact body and only the delivery headers, and relays the answer', async () => {
    await connect()
    const path = await enabledUrlPath()
    // Whitespace and key order matter to the HMAC: the bytes must not be re-serialized.
    const body = '{ "workflow_run" : {"updated_at":"' + new Date().toISOString() + '"},  "action":"completed" }'
    const res = await deliver(path, { body })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: true })

    expect(localCalls).toHaveLength(1)
    const call = localCalls[0]
    expect(call.url).toBe('http://local.invalid/api/webhooks/github')
    expect(call.body.toString('utf-8')).toBe(body)
    expect(call.headers['x-github-event']).toBe('workflow_run')
    expect(call.headers['x-github-delivery']).toBe('d-1')
    expect(call.headers['x-hub-signature-256']).toBe('sha256=abc123')
    expect(call.headers['x-not-forwarded']).toBeUndefined()

    const audit = listAuditEvents(db, { workspaceId: BOOTSTRAP_WORKSPACE_ID }).filter(e => e.kind === 'webhook_delivered')
    expect(audit).toHaveLength(1)
  })

  it('refuses a replayed delivery without calling the local server', async () => {
    await connect()
    const path = await enabledUrlPath()
    expect((await deliver(path)).status).toBe(202)
    const replay = await deliver(path)
    expect(replay.status).toBe(403)
    expect(localCalls).toHaveLength(1)
  })

  it('lets a delivery through again when the local server did not accept it', async () => {
    await connect()
    const path = await enabledUrlPath()
    localStatus = 400
    expect((await deliver(path)).status).toBe(400)
    localStatus = 202
    expect((await deliver(path)).status).toBe(202)
    expect(localCalls).toHaveLength(2)
  })

  it('refuses an event older than the replay window', async () => {
    await connect()
    const path = await enabledUrlPath()
    const old = new Date(Date.now() - WEBHOOK_RETENTION_MS - 60_000).toISOString()
    const res = await deliver(path, { body: JSON.stringify({ workflow_run: { updated_at: old } }) })
    expect(res.status).toBe(403)
    expect(localCalls).toHaveLength(0)
  })

  it('answers 404 for unknown, rotated, disabled and removed receivers', async () => {
    await connect()
    expect((await deliver('/api/hooks/github/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)

    const first = await enabledUrlPath()
    const second = await enabledUrlPath()
    expect((await deliver(first, { delivery: 'r-1' })).status).toBe(404)
    expect((await deliver(second, { delivery: 'r-2' })).status).toBe(202)

    await fetch(`${baseUrl}/api/machines/${machineId}/webhook`, { method: 'DELETE', headers: { 'x-test-user': 'owner' } })
    expect((await deliver(second, { delivery: 'r-3' })).status).toBe(404)

    const third = await enabledUrlPath()
    connector?.stop()
    connector = null
    removeMachine(db, machineId)
    expect((await deliver(third, { delivery: 'r-4' })).status).toBe(404)
  })

  it('reports an offline machine as 503', async () => {
    const path = await enabledUrlPath()
    expect((await deliver(path)).status).toBe(503)
  })

  it('rejects deliveries GitHub would not send', async () => {
    await connect()
    const path = await enabledUrlPath()
    expect((await deliver(path, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect((await deliver(path, { headers: { 'x-hub-signature-256': '' } })).status).toBe(400)
    expect(localCalls).toHaveLength(0)
  })

  it('answers 413 for a delivery larger than the local receiver accepts', async () => {
    await connect()
    const path = await enabledUrlPath()
    const res = await deliver(path, { body: JSON.stringify({ pad: 'x'.repeat(6 * 1024 * 1024) }) })
    expect(res.status).toBe(413)
    expect(localCalls).toHaveLength(0)
  })

  it('keeps accepted deliveries across connector restarts, keyed on the signed body', () => {
    let cleanup: string | null = null
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ck-webhook-guard-'))
      cleanup = dir
      const file = join(dir, 'deliveries.json')
      const dated = Buffer.from(JSON.stringify({ workflow_run: { updated_at: new Date().toISOString() } }))
      const first = new WebhookReplayGuard(file)
      const verdict = first.check({ 'x-github-delivery': 'persist-1' }, dated)
      expect(verdict.ok).toBe(true)
      if (verdict.ok) first.record(verdict.deliveryId)
      const second = new WebhookReplayGuard(file)
      expect(second.check({ 'x-github-delivery': 'persist-1' }, dated).ok).toBe(false)
      // The delivery id isn't covered by GitHub's HMAC: a fresh one doesn't help a replay.
      expect(second.check({ 'x-github-delivery': 'fresh-id' }, dated).ok).toBe(false)
      vi.setSystemTime(Date.now() + WEBHOOK_RETENTION_MS + 1000)
      // Forgotten by now, but by now the event itself is too old.
      expect(second.check({ 'x-github-delivery': 'persist-1' }, dated)).toMatchObject({ ok: false, reason: expect.stringContaining('older') })
    } finally {
      vi.useRealTimers()
      if (cleanup) rmSync(cleanup, { recursive: true, force: true })
    }
  })

  it('never ages out an undated delivery', () => {
    vi.useFakeTimers()
    try {
      const guard = new WebhookReplayGuard(null)
      const push = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }))
      const verdict = guard.check({ 'x-github-delivery': 'p-1' }, push)
      expect(verdict.ok).toBe(true)
      if (verdict.ok) guard.record(verdict.deliveryId)
      vi.setSystemTime(Date.now() + 2 * WEBHOOK_RETENTION_MS)
      expect(guard.check({ 'x-github-delivery': 'p-2' }, push).ok).toBe(false)
      // A different body is a different delivery.
      expect(guard.check({ 'x-github-delivery': 'p-3' }, Buffer.from('{"ref":"refs/heads/dev"}')).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

})
