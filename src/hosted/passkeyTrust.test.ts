/**
 * Passkeys between the browser (deviceTrust, intentSigner) and the machine
 * (enrolment, intent-verify), with a software authenticator standing in for
 * the user's (signed-intents spec §5.2, §5.4, §5.6, §6.6).
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { softPasskey } from '../../server/relay/__fixtures__/authenticator'
import type { SoftPasskey } from '../../server/relay/__fixtures__/authenticator'

const fake = vi.hoisted(() => ({ passkey: null as SoftPasskey | null, asserted: 0 }))
vi.mock('./deviceTrust', async importOriginal => ({
  ...(await importOriginal<typeof import('./deviceTrust')>()),
  currentUserId: () => Promise.resolve('u-owner'),
}))
vi.mock('./passkeys', () => ({
  passkeysSupported: () => true,
  assertWithPasskey: async (challenge: Uint8Array, ids: string[]) => {
    const p = fake.passkey!
    if (!ids.includes(p.credentialId)) throw Object.assign(new Error('no credential'), { name: 'NotAllowedError' })
    fake.asserted += 1
    return { credentialId: p.credentialId, ...p.assert(challenge) }
  },
}))

import {
  certifyWithPasskey, getOrCreateBrowserKey, removeFromMachine, startEnrolment,
  type BrowserKey, type EnrolSend, type MachinePin, type TrustStorage,
} from './deviceTrust'
import { assertWithPasskey } from './passkeys'
import { createIntentSigner } from './intentSigner'
import { MachineEnrolment, approveEnrolment } from '../../server/relay/enrolment'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { emptyTrustStore, readTrustStore, setPasskeyForBypass, writeTrustStore } from '../../server/relay/trust-store'
import { channelSessionAfter, frameAction, framePayload, frameSession, frameStepUpReason } from '../../server/relay/intent-actions'
import { PASSKEY_STEP_UP_EVENT, type PasskeyStepUpDetail } from './intentSigner'
import { keyIdForCoseKey } from '../../server/relay/webauthn-verify'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

const OWNER: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }

function memoryStorage(): TrustStorage & { pins: Map<string, MachinePin> } {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  return {
    pins,
    getKey: async id => keys.get(id),
    putKey: async k => { keys.set(k.userId, k) },
    getPin: async (u, m) => pins.get(`${u}:${m}`),
    putPin: async p => { pins.set(`${p.userId}:${p.machineId}`, p) },
    deletePin: async (u, m) => { pins.delete(`${u}:${m}`) },
  }
}

describe('passkeys from the browser to the machine', () => {
  let dir: string
  let devicesFile: string
  let machine: MachineEnrolment
  let verifier: IntentVerifier
  let send: EnrolSend
  let passkey: SoftPasskey
  const candidates = () => [{ credentialId: passkey.credentialId, cosePublicKey: passkey.cosePublicKey, rpId: 'relay.test' }]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-passkey-trust-'))
    const identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required' })
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile })
    machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    send = async (kind, payload) => machine.handle(kind, OWNER, JSON.parse(JSON.stringify(payload))).payload
    passkey = softPasskey()
    fake.passkey = passkey
    fake.asserted = 0
    vi.stubGlobal('window', { addEventListener: () => {}, dispatchEvent: () => true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Confirm a browser (and its passkey) with the two codes. */
  async function enrolWithCodes(storage: TrustStorage) {
    const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Firefox · Linux', storage, passkeys: { candidates: candidates(), assert: assertWithPasskey } })
    const added = approveEnrolment(enrolment.code, devicesFile, 'm1')
    expect(await enrolment.check()).toBe('approved')
    expect(await enrolment.confirm(added.confirmCode)).toBe(true)
  }

  it('confirms the passkey along with the browser, and remembers it for step-up', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    expect(fake.asserted).toBe(1)
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind).sort()).toEqual(['browser', 'passkey'])
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ via: 'code', passkeys: [{ credentialId: passkey.credentialId, keyId: keyIdForCoseKey(passkey.cosePublicKey) }] })
  })

  it('adds a second browser with the passkey alone; its pin is marked as taken on first use', async () => {
    await enrolWithCodes(memoryStorage())
    const phone = memoryStorage()
    await certifyWithPasskey(send, { userId: 'u-owner', machineId: 'm1', candidates: candidates(), assert: assertWithPasskey, label: 'Chrome · Android', storage: phone })
    const key = await getOrCreateBrowserKey('u-owner', phone)
    expect(readTrustStore(devicesFile)?.credentials.find(c => c.keyId === key.keyId)?.addedBy).toMatch(/^passkey:/)
    expect(phone.pins.get('u-owner:m1')).toMatchObject({ via: 'passkey', keyId: key.keyId })
  })

  it('signs a privileged action with the passkey, which the machine requires once one is enrolled', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    const token = 'A'.repeat(22)
    const opened = verifier.checkChannelOpen(OWNER, await signer.sign({ action: 'channel:open', sessionId: null, payload: new Uint8Array(), channel: token }))
    expect(opened.decision.verdict).toBe('accepted')
    const always = '{"type":"prompt_response","value":"always_allow","requestId":"r1"}'
    const before = fake.asserted
    const intent = await signer.sign({ action: frameAction(always), sessionId: null, payload: framePayload(always), channel: token, seq: 1, stepUp: true })
    expect(fake.asserted).toBe(before + 1)
    expect(verifier.checkFrame(OWNER, always, intent, opened.channel)).toMatchObject({ forward: true, verdict: 'accepted' })
    // Without step-up the browser key alone is refused, naming the passkey.
    const plain = await signer.sign({ action: frameAction(always), sessionId: null, payload: framePayload(always), channel: token, seq: 2 })
    expect(verifier.checkFrame(OWNER, always, plain, opened.channel).stepUpPasskeys).toHaveLength(1)
  })

  it('starts bypass sessions without a passkey by default, and learns when a machine asks for one', async () => {
    vi.stubGlobal('window', { addEventListener: () => {}, dispatchEvent: () => true })
    vi.stubGlobal('CustomEvent', class<T> { constructor(readonly type: string, init: { detail: T }) { this.detail = init.detail } detail: T })
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    const token = 'C'.repeat(22)
    const opened = verifier.checkChannelOpen(OWNER, await signer.sign({ action: 'channel:open', sessionId: null, payload: new Uint8Array(), channel: token }))
    let seq = 0
    const toBypass = '{"type":"set_permission_mode","permissionMode":"bypassPermissions"}'
    const send = async () => {
      seq += 1
      const intent = await signer.sign({ action: frameAction(toBypass), sessionId: null, payload: framePayload(toBypass), channel: token, seq, stepUp: true, stepUpReason: 'bypass' })
      return verifier.checkFrame(OWNER, toBypass, intent, opened.channel)
    }
    const before = fake.asserted
    expect((await send()).verdict).toBe('accepted')
    expect(fake.asserted).toBe(before)
    // The owner turns the strict setting on: the browser is refused once, learns, then asks.
    setPasskeyForBypass(true, devicesFile, 'm1')
    const refused = await send()
    expect(refused.reason).toBe('intent_step_up_required')
    await signer.learnPasskeys(refused.stepUpPasskeys!, 'bypass')
    expect(storage.pins.get('u-owner:m1')?.passkeyForBypass).toBe(true)
    expect((await send()).verdict).toBe('accepted')
    expect(fake.asserted).toBe(before + 1)
  })

  it('asks for the passkey once for bypass sessions, then not again on this browser for a while (§6.6b)', async () => {
    const events: PasskeyStepUpDetail[] = []
    vi.stubGlobal('window', { addEventListener: () => {}, dispatchEvent: (e: CustomEvent<PasskeyStepUpDetail>) => { if (e.type === PASSKEY_STEP_UP_EVENT) events.push(e.detail); return true } })
    vi.stubGlobal('CustomEvent', class<T> { constructor(readonly type: string, init: { detail: T }) { this.detail = init.detail } detail: T })
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    // A machine that asks for the passkey for bypass, and a browser that learned so.
    setPasskeyForBypass(true, devicesFile, 'm1')
    storage.pins.set('u-owner:m1', { ...storage.pins.get('u-owner:m1')!, passkeyForBypass: true })
    const signer = createIntentSigner('m1', storage)
    const token = 'B'.repeat(22)
    const opened = verifier.checkChannelOpen(OWNER, await signer.sign({ action: 'channel:open', sessionId: null, payload: new Uint8Array(), channel: token }))
    let session: string | null = null
    let seq = 0
    const send = async (frame: string, extra: { stepUp?: boolean } = { stepUp: true }) => {
      seq += 1
      const reason = frameStepUpReason(frame)
      const intent = await signer.sign({
        action: frameAction(frame), sessionId: frameSession(frame, session), payload: framePayload(frame), channel: token, seq,
        ...extra, ...(extra.stepUp && reason ? { stepUpReason: reason } : {}),
      })
      const decision = verifier.checkFrame(OWNER, frame, intent, opened.channel)
      if (decision.forward) session = channelSessionAfter(frame, session, seq)
      return { intent, decision }
    }
    const bypass = '{"type":"create_session","name":"n","workingDir":"/w","permissionMode":"bypassPermissions"}'

    const before = fake.asserted
    const first = await send(bypass)
    expect(fake.asserted).toBe(before + 1)
    expect(first.decision).toMatchObject({ forward: true, verdict: 'accepted' })
    // The app was told why, around the prompt.
    expect(events).toEqual([{ active: true, reason: 'bypass' }, { active: false, reason: 'bypass' }])
    expect(storage.pins.get('u-owner:m1')?.passkeyStepUpAt).toBeTypeOf('number')

    // The next bypass session: no prompt, the browser key, and the machine agrees.
    const second = await send(bypass)
    expect(fake.asserted).toBe(before + 1)
    expect(second.intent).toHaveProperty('sig')
    expect(second.decision).toMatchObject({ forward: true, verdict: 'accepted' })

    // A refusal (the machine's window ended first) clears ours: the passkey again next time.
    await signer.learnPasskeys([{ credentialId: passkey.credentialId, keyId: keyIdForCoseKey(passkey.cosePublicKey) }])
    expect(storage.pins.get('u-owner:m1')?.passkeyStepUpAt).toBeUndefined()
    await send(bypass)
    expect(fake.asserted).toBe(before + 2)
  })

  it('always asks for the passkey for actions without a session reason (grants, device changes)', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    await storage.putPin({ ...storage.pins.get('u-owner:m1')!, passkeyStepUpAt: Date.now() })
    const signer = createIntentSigner('m1', storage)
    const before = fake.asserted
    await signer.sign({ action: 'grant', sessionId: 's1', payload: new Uint8Array(), stepUp: true })
    expect(fake.asserted).toBe(before + 1)
  })

  it('asks for the passkey for standing authority inside a window, and opens none', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const openedAt = Date.now()
    await storage.putPin({ ...storage.pins.get('u-owner:m1')!, passkeyStepUpAt: openedAt })
    const signer = createIntentSigner('m1', storage)
    const before = fake.asserted
    const intent = await signer.sign({
      action: 'rest:POST /api/orchestrator/automations', sessionId: null, payload: new Uint8Array(), stepUp: true, stepUpReason: 'automation', standing: true,
    })
    expect(fake.asserted).toBe(before + 1)
    // The passkey intent doesn't name this browser, and the window isn't restarted.
    expect(JSON.parse((intent as { body: string }).body)).not.toHaveProperty('browserKeyId')
    expect(storage.pins.get('u-owner:m1')?.passkeyStepUpAt).toBe(openedAt)
  })

  it('lets the codes replace a machine key taken on first use, which never vouches for the clock', async () => {
    const storage = memoryStorage()
    // A pin from device_certify, possibly the relay's key.
    await storage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: 'not-the-real-key', keyId: 'k', pinnedAt: 'x', via: 'passkey' })
    expect(await createIntentSigner('m1', storage).verifyMachineTime('n', 1, 'sig')).toBe(false)
    await enrolWithCodes(storage)
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ via: 'code' })
    expect(storage.pins.get('u-owner:m1')?.machineKey).not.toBe('not-the-real-key')
  })

  it('adds passkey hints to what it knows, and ignores an empty list', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    await signer.learnPasskeys([])
    expect(storage.pins.get('u-owner:m1')?.passkeys).toHaveLength(1)
    await signer.learnPasskeys([{ credentialId: 'other', keyId: 'k2' }])
    expect(storage.pins.get('u-owner:m1')?.passkeys?.map(p => p.credentialId)).toEqual(['other', passkey.credentialId])
  })

  it('removes this browser from the machine with a stepped-up device_revoke', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    await removeFromMachine(send, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind)).toEqual(['passkey'])
    expect(storage.pins.size).toBe(0)
  })

  it('keeps the pin and pending state after an unauthenticated removal reply', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    await expect(removeFromMachine(async () => ({ state: 'approved' }), intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })).rejects.toThrow()
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ removalPending: true })
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind)).toContain('browser')
  })

  it('recovers a lost removal acknowledgement with a signed proof of absence', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    const lost: EnrolSend = async (kind, payload) => { await send(kind, payload); throw new Error('lost reply') }
    await expect(removeFromMachine(lost, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })).rejects.toThrow('lost reply')
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind)).toEqual(['passkey'])
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ removalPending: true })
    await removeFromMachine(send, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })
    expect(storage.pins.size).toBe(0)
  })

  it('rejects a valid removal acknowledgement from a different attempt', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    let oldReply: unknown
    const lost: EnrolSend = async (kind, payload) => { oldReply = await send(kind, payload); throw new Error('lost reply') }
    await expect(removeFromMachine(lost, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })).rejects.toThrow()
    await expect(removeFromMachine(async () => oldReply, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })).rejects.toThrow()
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ removalPending: true })
  })

})
