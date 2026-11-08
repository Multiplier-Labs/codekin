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
import { emptyTrustStore, readTrustStore, writeTrustStore } from '../../server/relay/trust-store'
import { frameAction, framePayload } from '../../server/relay/intent-actions'
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

  it('removes this browser from the machine with a stepped-up device_revoke', async () => {
    const storage = memoryStorage()
    await enrolWithCodes(storage)
    const signer = createIntentSigner('m1', storage)
    await removeFromMachine(send, intent => signer.sign(intent), { userId: 'u-owner', machineId: 'm1', storage })
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind)).toEqual(['passkey'])
    expect(storage.pins.size).toBe(0)
  })
})
