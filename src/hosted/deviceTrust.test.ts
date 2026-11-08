/**
 * The browser side of enrolment (WebCrypto) against the machine side
 * (server/relay/enrolment.ts, Node crypto): the two must agree byte for byte.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  base32, commitment, defaultBrowserLabel, formatCode, fromB64url, getOrCreateBrowserKey, shortAuthString, startEnrolment,
  toB64url, transcript, EnrolmentFailure,
  type BrowserKey, type EnrolSend, type MachinePin, type TrustStorage,
} from './deviceTrust'
import { MachineEnrolment, approveEnrolment, rejectEnrolment } from '../../server/relay/enrolment'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { emptyTrustStore, readTrustStore, writeTrustStore } from '../../server/relay/trust-store'

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

describe('encoding', () => {
  it('matches the shared vector pinned in server/relay/enrolment.test.ts', async () => {
    const spkiM = fromB64url('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmachine')
    const spkiB = fromB64url('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbrowser')
    expect(toB64url(await commitment(spkiB, 'Test browser', new Uint8Array(32).fill(1)))).toBe('rshF4jI0Db8X2A08Dzd3YzszZRKd7S-vSaIqoRt0VEY')
    expect(await shortAuthString(spkiM, spkiB, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe('I2C3EOOP')
  })

  it('length-prefixes fields and encodes base32/base64url like the machine', () => {
    expect(Array.from(transcript('l', 'a'))).toEqual([0, 0, 0, 1, 0x6c, 0, 0, 0, 1, 0x61])
    expect(base32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI')
    const bytes = new Uint8Array([251, 255, 0, 1])
    expect(toB64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    expect(Array.from(fromB64url(toB64url(bytes)))).toEqual(Array.from(bytes))
    expect(formatCode('K7QM2XPA')).toBe('K7QM-2XPA')
  })

  it('names the browser in a form machines accept', () => {
    expect(defaultBrowserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone')
    expect(defaultBrowserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome · Mac')
    expect(defaultBrowserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox · Linux')
  })
})

describe('enrolment against the machine', () => {
  let dir: string
  let devicesFile: string
  let machine: MachineEnrolment
  let storage: ReturnType<typeof memoryStorage>
  let send: EnrolSend
  const owner = { userId: 'u-owner', role: 'owner' as const, grants: {} }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-browser-enrol-'))
    const identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u-owner'))
    machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null })
    storage = memoryStorage()
    // The relay in between: JSON both ways, as on the wire.
    send = async (kind, payload) => machine.handle(kind, owner, JSON.parse(JSON.stringify(payload))).payload
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('shows the same code the machine expects, and pins the machine key once approved', async () => {
    const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Firefox · Linux', storage })
    expect(enrolment.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(await enrolment.check()).toBeNull()

    // The owner types the browser's code on the machine.
    const added = approveEnrolment(enrolment.code, devicesFile, 'm1')
    const key = await getOrCreateBrowserKey('u-owner', storage)
    expect(added).toMatchObject({ keyId: key.keyId, spki: key.spki, label: 'Firefox · Linux' })

    expect(await enrolment.check()).toBe('approved')
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ keyId: key.keyId })
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
  })

  it('reports a rejection without pinning', async () => {
    const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage })
    rejectEnrolment(enrolment.enrolId, devicesFile, 'm1')
    expect(await enrolment.check()).toBe('rejected')
    expect(storage.pins.size).toBe(0)
  })

  it('reuses one browser key per user', async () => {
    const a = await getOrCreateBrowserKey('u-owner', storage)
    const b = await getOrCreateBrowserKey('u-owner', storage)
    expect(b.keyId).toBe(a.keyId)
    expect((await getOrCreateBrowserKey('u-other', storage)).keyId).not.toBe(a.keyId)
    // Non-extractable: script can sign with it but never read it out.
    expect(a.keyPair.privateKey.extractable).toBe(false)
  })

  it('refuses a machine whose key changed since this browser pinned it', async () => {
    await storage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: 'some-other-key', keyId: 'k', pinnedAt: 'x' })
    await expect(startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage }))
      .rejects.toMatchObject({ code: 'machine_key_changed' })
  })

  it('refuses a relay that answers in place of the machine', async () => {
    // A relay can't sign with the machine key, so its own challenge fails.
    const forging: EnrolSend = async (kind, payload) => {
      const real = await send(kind, payload) as Record<string, string>
      if (kind === 'enrol_commit') return { ...real, signature: toB64url(new Uint8Array(64)) }
      return real
    }
    await expect(startEnrolment(forging, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage }))
      .rejects.toBeInstanceOf(EnrolmentFailure)
  })

  it('refuses an unsigned approval', async () => {
    const enrolment = await startEnrolment(async (kind, payload) => {
      if (kind === 'enrol_status') return { enrolId: 'x', state: 'approved', signature: toB64url(new Uint8Array(64)) }
      return send(kind, payload)
    }, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage })
    await expect(enrolment.check()).rejects.toMatchObject({ code: 'bad_machine_signature' })
    expect(storage.pins.size).toBe(0)
  })
})
