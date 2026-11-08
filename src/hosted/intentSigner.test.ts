/**
 * The browser's signing (WebCrypto, RelayConnection) against the machine's
 * verification (server/relay/intent-verify.ts): honest intents must verify,
 * in the order they were sent, bound to the right session.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./deviceTrust', async importOriginal => ({
  ...(await importOriginal<typeof import('./deviceTrust')>()),
  currentUserId: () => Promise.resolve('u-owner'),
}))

import { createIntentSigner, clampOffset } from './intentSigner'
import { getOrCreateBrowserKey, type BrowserKey, type MachinePin, type TrustStorage } from './deviceTrust'
import { RelayConnection } from '../lib/transport/relay-client'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { MACHINE_TIME_LABEL, requestAction, requestPayload, requestSession } from '../../server/relay/intent-actions'
import { signP1363, transcript } from '../../server/relay/enrolment-crypto'
import { generateKeyPairSync } from 'crypto'
import type { KeyObject } from 'crypto'
import { emptyTrustStore, writeTrustStore } from '../../server/relay/trust-store'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

const OWNER: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }

function memoryStorage(): TrustStorage {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  return {
    getKey: async id => keys.get(id),
    putKey: async k => { keys.set(k.userId, k) },
    getPin: async (u, m) => pins.get(`${u}:${m}`),
    putPin: async p => { pins.set(`${p.userId}:${p.machineId}`, p) },
    deletePin: async (u, m) => { pins.delete(`${u}:${m}`) },
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  readyState = 0
  sent: Array<{ kind: string; id?: string; channelId?: string; payload: Record<string, unknown> }> = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() { FakeWebSocket.instances.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw) as FakeWebSocket['sent'][number]) }
  close() { this.readyState = 3 }
}

describe('browser intents verified by the machine', () => {
  let dir: string
  let storage: TrustStorage
  let verifier: IntentVerifier
  let key: BrowserKey
  let machineKey: KeyObject
  /** What the machine sends with an intent_stale refusal. */
  const signedTime = (nonce: string, machineTime: number) =>
    signP1363(machineKey, transcript(MACHINE_TIME_LABEL, nonce, String(machineTime))).toString('base64url')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-signer-'))
    storage = memoryStorage()
    key = await getOrCreateBrowserKey('u-owner', storage)
    const machinePair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    machineKey = machinePair.privateKey
    const machineSpki = machinePair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    await storage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: machineSpki, keyId: key.keyId, pinnedAt: 'x' })
    const devicesFile = join(dir, 'relay-devices.json')
    writeTrustStore(devicesFile, {
      ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'),
      policy: 'required',
      credentials: [{ keyId: key.keyId, kind: 'browser', userId: 'u-owner', spki: key.spki, label: 'Firefox', addedAt: 'x', addedBy: 'local' }],
    })
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile })
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', { protocol: 'https:', host: 'relay.test' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signs requests the machine accepts, query string and body included', async () => {
    const signer = createIntentSigner('m1', storage)
    const body = new TextEncoder().encode('{"name":"x"}')
    const path = '/api/sessions/s1/rename?force=1'
    const intent = await signer.sign({ action: requestAction('PATCH', path), sessionId: requestSession(path), payload: requestPayload('PATCH', path, 'application/json', body) })
    expect(intent).not.toBeNull()
    const request = { method: 'PATCH', path, contentType: 'application/json', body: Buffer.from(body).toString('base64'), principal: OWNER, intent }
    expect(verifier.checkRequest(request)).toMatchObject({ forward: true, verdict: 'accepted' })
    // The relay changing the body breaks it.
    expect(verifier.checkRequest({ ...request, body: Buffer.from('{"name":"y"}').toString('base64') }).reason).toBe('intent_wrong_payload')
  })

  it('does not sign for a machine this browser is not confirmed on', async () => {
    expect(await createIntentSigner('m-other', storage).sign({ action: 'ws:input', sessionId: null, payload: new Uint8Array() })).toBeNull()
  })

  it('sends channel frames in order, each signed for the session the machine will see', async () => {
    const signer = createIntentSigner('m1', storage)
    // Make signing finish out of order: later frames sign faster.
    let delay = 30
    const slowSigner = { ...signer, sign: async (i: Parameters<typeof signer.sign>[0]) => {
      const d = (delay -= 10); await new Promise(r => setTimeout(r, Math.max(d, 0))); return signer.sign(i)
    } }
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer: slowSigner })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true, serverTime: Date.now() } }) })

    conn.openChannel('c1', { onReady: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} })
    const frames = ['{"type":"join_session","sessionId":"s1"}', '{"type":"input","data":"ls"}', '{"type":"ping"}', '{"type":"leave_session"}', '{"type":"get_diff"}']
    for (const f of frames) conn.sendChannelData('c1', f)
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'stream_data')).toHaveLength(frames.length) })

    const open = ws.sent.find(f => f.kind === 'stream_open')!
    const opened = verifier.checkChannelOpen(OWNER, open.payload.intent)
    expect(opened.decision.verdict).toBe('accepted')
    const data = ws.sent.filter(f => f.kind === 'stream_data')
    expect(data.map(f => f.payload.data)).toEqual(frames)
    // The machine tracks the channel itself (token, order, session) over what arrived.
    for (const f of data) {
      const frame = f.payload.data as string
      const verdict = opened && verifier.checkFrame(OWNER, frame, f.payload.intent, opened.channel)
      expect(verdict.forward, frame).toBe(true)
      expect(verdict.verdict).toBe(frame.includes('ping') ? 'exempt' : 'accepted')
    }
    expect(opened.channel.lastSeq).toBe(4)
    conn.close()
  })

  it('agrees with the machine on the session after create_session', async () => {
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer: createIntentSigner('m1', storage) })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true } }) })
    conn.openChannel('c1', { onReady: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} })
    const frames = ['{"type":"join_session","sessionId":"A"}', '{"type":"create_session","name":"n","workingDir":"/w"}', '{"type":"input","data":"y"}']
    for (const f of frames) conn.sendChannelData('c1', f)
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'stream_data')).toHaveLength(3) })
    const opened = verifier.checkChannelOpen(OWNER, ws.sent.find(f => f.kind === 'stream_open')!.payload.intent)
    for (const f of ws.sent.filter(x => x.kind === 'stream_data')) {
      expect(verifier.checkFrame(OWNER, f.payload.data as string, f.payload.intent, opened.channel).verdict).toBe('accepted')
    }
    const lastBody = JSON.parse((ws.sent.at(-1)!.payload.intent as { body: string }).body) as { sessionId: string }
    expect(lastBody.sessionId).toBe('@created:2')
    conn.close()
  })

  it('sends frames still being signed when the channel closes, then the close', async () => {
    const signer = createIntentSigner('m1', storage)
    const slow = { ...signer, sign: async (i: Parameters<typeof signer.sign>[0]) => { await new Promise(r => setTimeout(r, 20)); return signer.sign(i) } }
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer: slow })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true } }) })
    conn.openChannel('c1', { onReady: () => {}, onData: () => {}, onClose: () => {}, onError: () => {} })
    conn.sendChannelData('c1', '{"type":"leave_session"}')
    conn.closeChannel('c1')
    await vi.waitFor(() => { expect(ws.sent.some(f => f.kind === 'stream_close')).toBe(true) })
    expect(ws.sent.map(f => f.kind)).toEqual(['hello', 'stream_open', 'stream_data', 'stream_close'])
  })

  it('retries a request once with the machine clock after a stale refusal', async () => {
    const signer = createIntentSigner('m1', storage)
    const setOffset = vi.spyOn(signer, 'setClockOffset')
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true } }) })
    const reply = conn.request('GET', '/api/health')
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(1) })
    const first = ws.sent.at(-1)!
    const machineTime = Date.now() + 20 * 60_000
    const firstNonce = (JSON.parse((first.payload.intent as { body: string }).body) as { nonce: string }).nonce
    ws.onmessage?.({ data: JSON.stringify({ kind: 'error', id: first.id, payload: {
      code: 'not_permitted', message: 'stale', detail: 'intent_stale', machineTime, intentNonce: firstNonce, machineTimeSig: signedTime(firstNonce, machineTime),
    } }) })
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(2) })
    expect(setOffset).toHaveBeenCalledWith(expect.any(Number))
    const retried = ws.sent.at(-1)!
    const body = JSON.parse((retried.payload.intent as { body: string }).body) as { ts: number; nonce: string }
    const firstBody = JSON.parse((first.payload.intent as { body: string }).body) as { nonce: string }
    expect(Math.abs(body.ts - machineTime)).toBeLessThan(5_000)
    // Same nonce: if the relay forged the "stale" reply after the first one ran, the retry is a replay.
    expect(body.nonce).toBe(firstBody.nonce)
    ws.onmessage?.({ data: JSON.stringify({ kind: 'response', id: retried.id, payload: { status: 200, headers: {} } }) })
    expect(await reply).toMatchObject({ status: 200 })

    // From now on the relay's hello_ack can't move the clock back.
    setOffset.mockClear()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true, serverTime: Date.now() - 50 * 60_000 } }) })
    expect(setOffset).not.toHaveBeenCalled()
  })

  it('a relay forging "stale" cannot move the clock or get a retry', async () => {
    const signer = createIntentSigner('m1', storage)
    const setOffset = vi.spyOn(signer, 'setClockOffset')
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true } }) })
    const reply = conn.request('POST', '/api/sessions/create', btoa('{"name":"x"}'), 'application/json')
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(1) })
    const first = ws.sent.at(-1)!
    const nonce = (JSON.parse((first.payload.intent as { body: string }).body) as { nonce: string }).nonce
    // No signature, or one the relay made itself.
    ws.onmessage?.({ data: JSON.stringify({ kind: 'error', id: first.id, payload: {
      code: 'not_permitted', message: 'stale', detail: 'intent_stale', machineTime: Date.now() + 50 * 60_000, intentNonce: nonce,
      machineTimeSig: Buffer.alloc(64).toString('base64url'),
    } }) })
    await expect(reply).rejects.toMatchObject({ detail: 'intent_stale' })
    expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(1)
    expect(setOffset).not.toHaveBeenCalled()
  })

  it('even an honest stale retry of a request that ran is refused as a replay', async () => {
    const signer = createIntentSigner('m1', storage)
    const conn = new RelayConnection({ machineId: 'm1', url: 'wss://relay.test/relay/browser', signer })
    conn.connect()
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'hello_ack', payload: { online: true } }) })
    const reply = conn.request('POST', '/api/sessions/create', btoa('{"name":"x"}'), 'application/json')
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(1) })
    const first = ws.sent.at(-1)!
    const asRequest = (f: typeof first) => ({ method: 'POST', path: '/api/sessions/create', contentType: 'application/json', body: f.payload.body as string, principal: OWNER, intent: f.payload.intent })
    // The relay forwards it (it runs), then tells the browser it was stale.
    expect(verifier.checkRequest(asRequest(first)).verdict).toBe('accepted')
    const nonce = (JSON.parse((first.payload.intent as { body: string }).body) as { nonce: string }).nonce
    const machineTime = Date.now()
    ws.onmessage?.({ data: JSON.stringify({ kind: 'error', id: first.id, payload: {
      code: 'not_permitted', message: 'stale', detail: 'intent_stale', machineTime, intentNonce: nonce, machineTimeSig: signedTime(nonce, machineTime),
    } }) })
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(2) })
    expect(verifier.checkRequest(asRequest(ws.sent.at(-1)!))).toMatchObject({ forward: false, reason: 'intent_replayed' })
    ws.onmessage?.({ data: JSON.stringify({ kind: 'error', id: ws.sent.at(-1)!.id, payload: { code: 'not_permitted', message: 'replayed', detail: 'intent_replayed' } }) })
    await expect(reply).rejects.toMatchObject({ detail: 'intent_replayed' })
  })

  it('bounds clock corrections to an hour', () => {
    expect(clampOffset(2 * 60 * 60_000)).toBe(60 * 60_000)
    expect(clampOffset(-2 * 60 * 60_000)).toBe(-60 * 60_000)
    expect(clampOffset(Number.NaN)).toBe(0)
  })
})
