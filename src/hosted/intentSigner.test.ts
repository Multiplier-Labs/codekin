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
import { channelSessionAfter, requestAction, requestPayload, requestSession } from '../../server/relay/intent-actions'
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

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-signer-'))
    storage = memoryStorage()
    key = await getOrCreateBrowserKey('u-owner', storage)
    await storage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: 'mk', keyId: key.keyId, pinnedAt: 'x' })
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
    expect(verifier.checkChannelOpen(OWNER, open.payload.intent).verdict).toBe('accepted')
    const data = ws.sent.filter(f => f.kind === 'stream_data')
    expect(data.map(f => f.payload.data)).toEqual(frames)
    // Replay the machine's channel tracking over what arrived.
    let session: string | null = null
    for (const f of data) {
      const frame = f.payload.data as string
      const verdict = verifier.checkFrame(OWNER, frame, f.payload.intent, session)
      expect(verdict.forward, frame).toBe(true)
      expect(verdict.verdict).toBe(frame.includes('ping') ? 'exempt' : 'accepted')
      session = channelSessionAfter(frame, session)
    }
    conn.close()
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
    const machineTime = Date.now() + 20 * 60_000
    ws.onmessage?.({ data: JSON.stringify({ kind: 'error', id: ws.sent.at(-1)!.id, payload: { code: 'not_permitted', message: 'stale', detail: 'intent_stale', machineTime } }) })
    await vi.waitFor(() => { expect(ws.sent.filter(f => f.kind === 'request')).toHaveLength(2) })
    expect(setOffset).toHaveBeenCalledWith(expect.any(Number))
    const retried = ws.sent.at(-1)!
    const body = JSON.parse((retried.payload.intent as { body: string }).body) as { ts: number }
    expect(Math.abs(body.ts - machineTime)).toBeLessThan(5_000)
    ws.onmessage?.({ data: JSON.stringify({ kind: 'response', id: retried.id, payload: { status: 200, headers: {} } }) })
    expect(await reply).toMatchObject({ status: 200 })
  })

  it('bounds clock corrections to an hour', () => {
    expect(clampOffset(2 * 60 * 60_000)).toBe(60 * 60_000)
    expect(clampOffset(-2 * 60 * 60_000)).toBe(-60 * 60_000)
    expect(clampOffset(Number.NaN)).toBe(0)
  })
})
