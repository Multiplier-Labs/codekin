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
  base32, commitment, confirmationCode, defaultBrowserLabel, formatCode, fromB64url, getOrCreateBrowserKey, newTrustSecret, shortAuthString, startEnrolment,
  toB64url, transcript, trustCommand, trustResultMac, trustRevealMac, trustTokenId, EnrolmentFailure,
  type BrowserKey, type EnrolSend, type MachinePin, type TrustStorage,
} from './deviceTrust'
import { MachineEnrolment, approveEnrolment, approveTrustToken, rejectEnrolment } from '../../server/relay/enrolment'
import * as machineCrypto from '../../server/relay/enrolment-crypto'
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
    expect(await confirmationCode(spkiM, spkiB, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe('KBYPER')
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
  let identityFile: string
  let machine: MachineEnrolment
  let storage: ReturnType<typeof memoryStorage>
  let send: EnrolSend
  const owner = { userId: 'u-owner', role: 'owner' as const, grants: {} }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-browser-enrol-'))
    identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u-owner'))
    machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null })
    storage = memoryStorage()
    // The relay in between: JSON both ways, as on the wire.
    send = async (kind, payload) => machine.handle(kind, owner, JSON.parse(JSON.stringify(payload))).payload
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('shows the code the machine expects, and pins only once the machine’s finishing code is typed back', async () => {
    const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Firefox · Linux', storage })
    expect(enrolment.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(await enrolment.check()).toBeNull()

    // The owner types the browser's code on the machine; the machine shows a finishing code.
    const added = approveEnrolment(enrolment.code, devicesFile, 'm1')
    const key = await getOrCreateBrowserKey('u-owner', storage)
    expect(added).toMatchObject({ keyId: key.keyId, spki: key.spki, label: 'Firefox · Linux' })
    expect(added.confirmCode).toMatch(/^[A-Z2-7]{3}-[A-Z2-7]{3}$/)

    // An approval alone pins nothing.
    expect(await enrolment.check()).toBe('approved')
    expect(storage.pins.size).toBe(0)

    expect(await enrolment.confirm('AAA-AAA')).toBe(added.confirmCode === 'AAA-AAA')
    expect(storage.pins.size).toBe(0)
    expect(await enrolment.confirm(added.confirmCode.toLowerCase().replace('-', ' '))).toBe(true)
    expect(storage.pins.get('u-owner:m1')).toMatchObject({ keyId: key.keyId })
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
  })

  it('defeats a relay that answers as the machine on a first enrolment', async () => {
    // The relay runs the real machine's ceremony on one side and its own key
    // towards the browser on the other, and forges the approval.
    const { generateKeyPairSync, sign } = await import('crypto')
    const fake = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const fakeSpki = fake.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const signFake = (data: Uint8Array) => toB64url(sign('sha256', data, { key: fake.privateKey, dsaEncoding: 'ieee-p1363' }))
    let commitB64 = ''
    let realNonceM = ''
    let spkiB = new Uint8Array()
    const mitm: EnrolSend = async (kind, payload) => {
      const p = payload as Record<string, string>
      if (kind === 'enrol_commit') {
        commitB64 = p.commit
        const real = await send(kind, payload) as Record<string, string>
        realNonceM = real.nonceM
        // Same nonce, so the browser's proof of possession still works on the real machine.
        return { ...real, machineKey: fakeSpki, signature: signFake(transcript('ck-enrol-challenge-v1', real.enrolId, fromB64url(commitB64), fromB64url(real.nonceM))) }
      }
      if (kind === 'enrol_reveal') {
        spkiB = fromB64url(p.spki)
        return send(kind, payload)
      }
      return { enrolId: p.enrolId, state: 'approved', signature: signFake(transcript('ck-enrol-result-v1', p.enrolId, spkiB, 'approved')) }
    }
    const enrolment = await startEnrolment(mitm, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage })
    // The forged approval looks valid…
    expect(await enrolment.check()).toBe('approved')
    // …but the code the browser shows was made with the relay's key, so the
    // machine refuses it and has no finishing code to show.
    expect(() => approveEnrolment(enrolment.code, devicesFile, 'm1')).toThrow(/No browser is waiting/)
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
    // The only code the relay could offer is its own; the owner reads codes off the machine.
    expect(storage.pins.size).toBe(0)
    expect(realNonceM).not.toBe('')
  })

  describe('trust token: one pasted command instead of two codes (§5.2b)', () => {
    const paste = (secret: Uint8Array) =>
      approveTrustToken(trustCommand(secret).split(' ').pop()!, { devicesFile, identityFile }, { machineId: 'm1', relayOrigin: 'https://relay.test' })

    it('agrees with the machine on the token id and both MACs', async () => {
      const secret = new Uint8Array(16).fill(7)
      const spkiM = fromB64url('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmachine')
      const spkiB = fromB64url('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbrowser')
      const n1 = new Uint8Array(32).fill(1)
      const n2 = new Uint8Array(32).fill(2)
      expect(await trustTokenId(secret)).toBe(machineCrypto.trustTokenId(secret))
      expect(toB64url(await trustRevealMac(secret, 'e1', spkiM, spkiB, [], 'L', n1, n2)))
        .toBe(machineCrypto.trustRevealMac(secret, 'e1', spkiM, spkiB, [], 'L', n1, n2).toString('base64url'))
      expect(toB64url(await trustResultMac(secret, 'e1', spkiM, spkiB, [])))
        .toBe(machineCrypto.trustResultMac(secret, 'e1', spkiM, spkiB, []).toString('base64url'))
      expect(trustCommand(secret)).toMatch(/^codekin relay devices trust [A-Za-z0-9_-]{22}$/)
    })

    it('confirms and pins once the command is pasted on the machine, with nothing typed back', async () => {
      const secret = newTrustSecret()
      const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: secret })
      expect(enrolment.trustOffered).toBe(true)
      expect(await enrolment.check()).toBeNull()
      const outcome = paste(secret)
      expect(outcome).toMatchObject({ kind: 'approved', added: { label: 'Chrome · Mac', addedBy: 'local' } })
      expect(await enrolment.check()).toBe('confirmed')
      const key = await getOrCreateBrowserKey('u-owner', storage)
      expect(storage.pins.get('u-owner:m1')).toMatchObject({ keyId: key.keyId, via: 'code' })
      expect(readTrustStore(devicesFile)?.policy).toBe('required')
    })

    it('confirms at once when the command was pasted before the browser asked (the install)', async () => {
      const secret = newTrustSecret()
      expect(paste(secret)).toMatchObject({ kind: 'waiting' })
      expect(readTrustStore(devicesFile)?.trustTokens).toHaveLength(1)
      const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: secret })
      expect(await enrolment.check()).toBe('confirmed')
      expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
      // Spent: a second browser offering the same token gets nothing.
      expect(readTrustStore(devicesFile)?.trustTokens).toBeUndefined()
    })

    it('never confirms with someone else’s token', async () => {
      const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: newTrustSecret() })
      expect(paste(newTrustSecret())).toMatchObject({ kind: 'waiting' })
      expect(await enrolment.check()).toBeNull()
      expect(readTrustStore(devicesFile)?.credentials).toEqual([])
    })

    it('defeats a relay that swaps the machine key, and one that forges the approval', async () => {
      const { generateKeyPairSync, sign } = await import('crypto')
      const fake = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      const fakeSpki = fake.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
      const signFake = (data: Uint8Array) => toB64url(sign('sha256', data, { key: fake.privateKey, dsaEncoding: 'ieee-p1363' }))
      let spkiB = new Uint8Array()
      const mitm: EnrolSend = async (kind, payload) => {
        const p = payload as Record<string, string>
        if (kind === 'enrol_commit') {
          const real = await send(kind, payload) as Record<string, string>
          return { ...real, machineKey: fakeSpki, signature: signFake(transcript('ck-enrol-challenge-v1', real.enrolId, fromB64url(p.commit), fromB64url(real.nonceM))) }
        }
        if (kind === 'enrol_reveal') {
          spkiB = fromB64url(p.spki)
          return send(kind, payload)
        }
        // A forged approval: signed by the relay's key, with a made-up MAC.
        return { enrolId: p.enrolId, state: 'approved', trustMac: toB64url(new Uint8Array(32)), signature: signFake(transcript('ck-enrol-result-v1', p.enrolId, spkiB, 'approved')) }
      }
      const secret = newTrustSecret()
      const enrolment = await startEnrolment(mitm, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: secret })
      // The browser's MAC covers the relay's key, so the real machine refuses it.
      expect(paste(secret)).toEqual({ kind: 'refused' })
      expect(readTrustStore(devicesFile)?.credentials).toEqual([])
      // And the relay can't make the MAC that would pin its key.
      expect(await enrolment.check()).toBe('approved')
      expect(storage.pins.size).toBe(0)
    })

    it('ignores a relay that copies the token id into a request of its own', async () => {
      const secret = newTrustSecret()
      expect(paste(secret)).toMatchObject({ kind: 'waiting' })
      // The relay saw the id go by and front-runs with its own key and a made-up MAC.
      const id = await trustTokenId(secret)
      const forged: EnrolSend = async (kind, payload) => {
        if (kind === 'enrol_reveal') return send(kind, { ...(payload as object), trust: { id, mac: toB64url(new Uint8Array(32)) } })
        return send(kind, payload)
      }
      await expect(startEnrolment(forged, { userId: 'u-owner', machineId: 'm1', label: 'Relay', storage: memoryStorage() })).rejects.toThrow(/did not prove/)
      // The token survived: the honest browser is still confirmed with it.
      const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: secret })
      expect(await enrolment.check()).toBe('confirmed')
      expect(readTrustStore(devicesFile)?.credentials.map(c => c.label)).toEqual(['Chrome · Mac'])
    })

    it('approves the honest request when a relay copied the id into another one first', async () => {
      const secret = newTrustSecret()
      const id = await trustTokenId(secret)
      const forged: EnrolSend = async (kind, payload) => {
        if (kind === 'enrol_reveal') return send(kind, { ...(payload as object), trust: { id, mac: toB64url(new Uint8Array(32)) } })
        return send(kind, payload)
      }
      await startEnrolment(forged, { userId: 'u-owner', machineId: 'm1', label: 'Relay', storage: memoryStorage() })
      const enrolment = await startEnrolment(send, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: secret })
      expect(paste(secret)).toMatchObject({ kind: 'approved', added: { label: 'Chrome · Mac' } })
      expect(await enrolment.check()).toBe('confirmed')
      expect(readTrustStore(devicesFile)?.credentials.map(c => c.label)).toEqual(['Chrome · Mac'])
    })

    it('falls back to codes against a machine that does not take tokens', async () => {
      const old: EnrolSend = async (kind, payload) => {
        const reply = await send(kind, payload) as Record<string, unknown>
        if (kind === 'enrol_commit') delete reply.trustTokens
        if (kind === 'enrol_reveal') expect((payload as Record<string, unknown>).trust).toBeUndefined()
        return reply
      }
      const enrolment = await startEnrolment(old, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage, trustSecret: newTrustSecret() })
      expect(enrolment.trustOffered).toBe(false)
    })
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
    // (Approvals pin nothing either way; a bad signature is still reported.)
    const enrolment = await startEnrolment(async (kind, payload) => {
      if (kind === 'enrol_status') return { enrolId: 'x', state: 'approved', signature: toB64url(new Uint8Array(64)) }
      return send(kind, payload)
    }, { userId: 'u-owner', machineId: 'm1', label: 'Chrome · Mac', storage })
    await expect(enrolment.check()).rejects.toMatchObject({ code: 'bad_machine_signature' })
    expect(storage.pins.size).toBe(0)
  })
})
