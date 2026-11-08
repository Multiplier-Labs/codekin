/** Tests for the machine side of the enrolment ceremony (signed-intents spec §5.2, §11). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CHALLENGE_LABEL, POP_LABEL, RESULT_LABEL, base32, commitment, confirmationCode, formatCode, normalizeCode, shortAuthString, signP1363,
  transcript, verifyP1363, checkLabel,
} from './enrolment-crypto.js'
import { approveEnrolment, ENROL_TTL_MS, EnrolmentError, MachineEnrolment, MAX_ENROLMENTS_PER_WINDOW, MAX_PENDING_ENROLMENTS, rejectEnrolment } from './enrolment.js'
import { ensureMachineIdentity } from './machine-identity.js'
import { describeTrustStore, emptyTrustStore, readTrustStore, TrustStoreError, writeTrustStore } from './trust-store.js'
import type { RelayPrincipal } from './relay-protocol.js'

const OWNER: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
const quiet = { log: vi.fn(), warn: vi.fn() }

/** A browser, played with Node crypto: the same bytes WebCrypto would produce. */
function browser(label = 'Safari · iPhone') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const nonceB = randomBytes(32)
  const commit = commitment(spki, [], label, nonceB)
  return { spki, privateKey, nonceB, label, commit }
}

function reveal(b: ReturnType<typeof browser>, enrolId: string, nonceM: string, override: Partial<Record<string, unknown>> = {}) {
  return {
    enrolId,
    spki: b.spki.toString('base64url'),
    passkeys: [],
    label: b.label,
    nonceB: b.nonceB.toString('base64url'),
    pop: signP1363(b.privateKey as KeyObject, transcript(POP_LABEL, enrolId, Buffer.from(nonceM, 'base64url'), '[]')).toString('base64url'),
    ...override,
  }
}

describe('enrolment crypto', () => {
  it('length-prefixes every field so different splits never collide', () => {
    expect(transcript('x', 'ab', 'c').equals(transcript('x', 'a', 'bc'))).toBe(false)
    expect(transcript('l', 'a').toString('hex')).toBe('000000016c' + '0000000161')
  })

  it('matches the RFC 4648 base32 test vectors', () => {
    expect(base32(Buffer.from(''))).toBe('')
    expect(base32(Buffer.from('f'))).toBe('MY')
    expect(base32(Buffer.from('fooba'))).toBe('MZXW6YTB')
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('pins a fixed vector shared with the browser implementation', () => {
    // Same inputs as src/hosted/deviceTrust.test.ts; both must produce these.
    const spkiM = Buffer.from('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmachine', 'base64url')
    const spkiB = Buffer.from('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbrowser', 'base64url')
    const nonceB = Buffer.alloc(32, 1)
    const nonceM = Buffer.alloc(32, 2)
    expect(commitment(spkiB, [], 'Test browser', nonceB).toString('base64url')).toBe(VECTOR.commit)
    expect(shortAuthString(spkiM, spkiB, [], nonceB, nonceM)).toBe(VECTOR.sas)
    expect(confirmationCode(spkiM, spkiB, [], nonceB, nonceM)).toBe(VECTOR.confirm)
  })

  it('normalizes typed codes and refuses anything else', () => {
    expect(normalizeCode('k7qm-2xpa')).toBe('K7QM2XPA')
    expect(normalizeCode(' K7QM 2XPA ')).toBe('K7QM2XPA')
    expect(normalizeCode('K7QM-2XP')).toBeNull()
    expect(normalizeCode('K7QM-2XP1')).toBeNull() // 1 is not base32
    expect(formatCode('K7QM2XPA')).toBe('K7QM-2XPA')
  })

  it('accepts labels only as sent', () => {
    expect(checkLabel('Safari · iPhone')).toBe('Safari · iPhone')
    expect(checkLabel(' padded')).toBeNull()
    expect(checkLabel('evil‮abc')).toBeNull()
    expect(checkLabel('line\nbreak')).toBeNull()
    expect(checkLabel('x'.repeat(65))).toBeNull()
    expect(checkLabel('')).toBeNull()
  })
})

/** Fixed outputs for the shared vector, computed once and pinned on both sides. */
const VECTOR = {
  commit: 'rshF4jI0Db8X2A08Dzd3YzszZRKd7S-vSaIqoRt0VEY',
  sas: 'I2C3EOOP',
  confirm: 'KBYPER',
}

describe('MachineEnrolment', () => {
  let dir: string
  let identityFile: string
  let devicesFile: string
  let now: number
  let machineSpki: Buffer
  let enrolment: MachineEnrolment

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-enrol-'))
    identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    now = Date.parse('2026-11-08T12:00:00Z')
    machineSpki = Buffer.from(ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: quiet }).publicKey, 'base64url')
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u-owner'))
    enrolment = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, now: () => now, log: quiet })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Run commit + reveal; returns what the browser would show. */
  function startCeremony(b = browser()) {
    const challenge = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
    const result = enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM))
    const code = shortAuthString(Buffer.from(challenge.machineKey, 'base64url'), b.spki, [], b.nonceB, Buffer.from(challenge.nonceM, 'base64url'))
    return { b, challenge, result, code }
  }

  it('runs the whole ceremony: commit, reveal, code typed here, signed approval', () => {
    const b = browser()
    const challenge = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
    // The browser checks the machine signed its commitment and nonce.
    expect(challenge.machineKey).toBe(machineSpki.toString('base64url'))
    expect(verifyP1363(machineSpki, transcript(CHALLENGE_LABEL, challenge.enrolId, b.commit, Buffer.from(challenge.nonceM, 'base64url')),
      Buffer.from(challenge.signature, 'base64url'))).toBe(true)

    expect(enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM))).toEqual({ enrolId: challenge.enrolId, state: 'awaiting_code' })
    expect(enrolment.status(OWNER, { enrolId: challenge.enrolId })).toEqual({ enrolId: challenge.enrolId, state: 'awaiting_code' })

    // The local UI lists the request, but never its code.
    const view = describeTrustStore(readTrustStore(devicesFile)!, now)
    expect(view.pending).toEqual([expect.objectContaining({ enrolId: challenge.enrolId, label: b.label, userId: 'u-owner' })])
    const code = shortAuthString(machineSpki, b.spki, [], b.nonceB, Buffer.from(challenge.nonceM, 'base64url'))
    expect(JSON.stringify(view)).not.toContain(code)

    const added = approveEnrolment(formatCode(code).toLowerCase(), devicesFile, 'm1', () => now)
    expect(added).toMatchObject({ kind: 'browser', userId: 'u-owner', label: b.label, addedBy: 'local', spki: b.spki.toString('base64url') })
    // The finishing code for the browser, shown here only now that it is approved.
    const nonceM = Buffer.from(challenge.nonceM, 'base64url')
    expect(added.confirmCode).toBe(formatCode(confirmationCode(machineSpki, b.spki, [], b.nonceB, nonceM)))
    expect(describeTrustStore(readTrustStore(devicesFile)!, now).approved).toEqual([
      { enrolId: challenge.enrolId, label: b.label, confirmCode: added.confirmCode, approvedAt: expect.any(String) },
    ])
    expect(readTrustStore(devicesFile)!.credentials[0]).not.toHaveProperty('confirmCode')
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)

    const status = enrolment.status(OWNER, { enrolId: challenge.enrolId })
    expect(status).toMatchObject({ state: 'approved', keyId: added.keyId })
    expect(verifyP1363(machineSpki, transcript(RESULT_LABEL, challenge.enrolId, b.spki, 'approved'), Buffer.from(status.signature!, 'base64url'))).toBe(true)
  })

  it('refuses a reveal whose key differs from the committed one (a swapped key)', () => {
    const honest = browser()
    const swapped = browser()
    const challenge = enrolment.commit(OWNER, { commit: honest.commit.toString('base64url') })
    expect(() => enrolment.reveal(OWNER, reveal(swapped, challenge.enrolId, challenge.nonceM, { nonceB: honest.nonceB.toString('base64url') })))
      .toThrow(/commitment/)
    // The request is spent: a second try can't grind against it, and it keeps
    // counting against the machine's budget until it expires.
    expect(() => enrolment.reveal(OWNER, reveal(honest, challenge.enrolId, challenge.nonceM))).toThrow(/already used/)
    expect(readTrustStore(devicesFile)?.pending).toHaveLength(1)
  })

  it('refuses a reveal whose label differs from the committed one', () => {
    const b = browser()
    const challenge = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
    expect(() => enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM, { label: 'Something else' }))).toThrow(/commitment/)
  })

  it('refuses a reveal without proof of possession', () => {
    const b = browser()
    const challenge = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
    const other = browser()
    const forged = signP1363(other.privateKey as KeyObject, transcript(POP_LABEL, challenge.enrolId, Buffer.from(challenge.nonceM, 'base64url'), '[]'))
    expect(() => enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM, { pop: forged.toString('base64url') }))).toThrow(/prove/)
  })

  it('refuses anyone but the recorded owner', () => {
    const b = browser()
    const commit = { commit: b.commit.toString('base64url') }
    expect(() => enrolment.commit({ userId: 'u-other', role: 'owner', grants: {} }, commit)).toThrow(EnrolmentError)
    expect(() => enrolment.commit({ userId: 'u-owner', role: 'grantee', grants: {} }, commit)).toThrow(/owner/)
    expect(() => enrolment.commit(undefined, commit)).toThrow(/owner/)
    const challenge = enrolment.commit(OWNER, commit)
    expect(() => enrolment.reveal({ userId: 'u-other', role: 'owner', grants: {} }, reveal(b, challenge.enrolId, challenge.nonceM))).toThrow(/owner/)
  })

  it('needs to know its owner before enrolling', () => {
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', null))
    expect(() => enrolment.commit(OWNER, { commit: browser().commit.toString('base64url') }))
      .toThrow(expect.objectContaining({ code: 'enrol_unavailable' }))
  })

  it('holds at most three undecided requests, replacing the oldest', () => {
    const ids: string[] = []
    for (let i = 0; i <= MAX_PENDING_ENROLMENTS; i++) {
      now += 1000
      ids.push(enrolment.commit(OWNER, { commit: browser().commit.toString('base64url') }).enrolId)
    }
    const kept = readTrustStore(devicesFile)!.pending.map(p => p.enrolId)
    expect(kept).toEqual(ids.slice(1))
  })

  it('bounds attempts per window, failed ones included', () => {
    for (let i = 0; i < MAX_ENROLMENTS_PER_WINDOW; i++) {
      const b = browser()
      const ch = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
      // A relay grinding for a code: reveal a key that fails the commitment.
      expect(() => enrolment.reveal(OWNER, reveal(browser(), ch.enrolId, ch.nonceM, { nonceB: b.nonceB.toString('base64url') }))).toThrow()
    }
    expect(() => enrolment.commit(OWNER, { commit: browser().commit.toString('base64url') })).toThrow(/Too many attempts/)
    now += ENROL_TTL_MS + 1
    expect(() => enrolment.commit(OWNER, { commit: browser().commit.toString('base64url') })).not.toThrow()
  })

  it('still reports an approval to a browser that comes back hours later', () => {
    const { challenge, code } = startCeremony()
    approveEnrolment(code, devicesFile, 'm1', () => now)
    now += 6 * 60 * 60_000
    expect(enrolment.status(OWNER, { enrolId: challenge.enrolId }).state).toBe('approved')
  })

  it('does not reread an unreadable identity key on every relay frame', () => {
    const get = vi.fn(() => null)
    const raw = JSON.parse(readFileSync(identityFile, 'utf8')) as Record<string, unknown>
    delete raw.privateKey
    raw.privateKeyRef = 'keychain'
    writeFileSync(identityFile, JSON.stringify(raw))
    const locked = new MachineEnrolment({
      machineId: 'm1', identityFile, devicesFile, secretStore: { get, set: vi.fn(), delete: vi.fn() }, now: () => now, log: quiet,
    })
    for (let i = 0; i < 5; i++) expect(() => locked.commit(OWNER, { commit: browser().commit.toString('base64url') })).toThrow(/could not be read/)
    expect(get).toHaveBeenCalledTimes(1)
    now += 61_000
    expect(() => locked.commit(OWNER, { commit: browser().commit.toString('base64url') })).toThrow()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('refuses passkeys without proof, malformed input, and a reused request', () => {
    const b = browser()
    const challenge = enrolment.commit(OWNER, { commit: b.commit.toString('base64url') })
    expect(() => enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM, { passkeys: [{ credentialId: 'x', cosePublicKey: 'y', rpId: 'z' }] })))
      .toThrow(/Malformed/)
    expect(() => enrolment.commit(OWNER, { commit: 'short' })).toThrow(/Malformed/)
    expect(() => enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM, { spki: 'AAAA' }))).toThrow(/Malformed/)
    enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM))
    expect(() => enrolment.reveal(OWNER, reveal(b, challenge.enrolId, challenge.nonceM))).toThrow(/already used/)
  })

  it('does not accept a wrong code, a code before the reveal, or an expired request', () => {
    const { code } = startCeremony()
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
    expect(() => approveEnrolment(wrong, devicesFile, 'm1', () => now)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => approveEnrolment('not a code', devicesFile, 'm1', () => now)).toThrow(TrustStoreError)
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])

    // A request that never revealed has no code to match.
    enrolment.commit(OWNER, { commit: browser().commit.toString('base64url') })
    now += ENROL_TTL_MS + 1
    expect(() => approveEnrolment(code, devicesFile, 'm1', () => now)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
  })

  it('reports expiry to the browser', () => {
    const { challenge } = startCeremony()
    now += ENROL_TTL_MS + 1
    expect(enrolment.status(OWNER, { enrolId: challenge.enrolId })).toEqual({ enrolId: challenge.enrolId, state: 'expired' })
  })

  it('reports a rejection made on this machine, signed', () => {
    const { b, challenge } = startCeremony()
    rejectEnrolment(challenge.enrolId, devicesFile, 'm1', () => now)
    const status = enrolment.status(OWNER, { enrolId: challenge.enrolId })
    expect(status.state).toBe('rejected')
    expect(verifyP1363(machineSpki, transcript(RESULT_LABEL, challenge.enrolId, b.spki, 'rejected'), Buffer.from(status.signature!, 'base64url'))).toBe(true)
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
    expect(() => rejectEnrolment(challenge.enrolId, devicesFile, 'm1', () => now)).toThrow(TrustStoreError)
  })

  it('re-confirming a listed browser replaces its entry instead of duplicating it', () => {
    const b = browser()
    approveEnrolment(startCeremony(b).code, devicesFile, 'm1', () => now)
    const again = { ...b, nonceB: randomBytes(32) }
    again.commit = commitment(again.spki, [], again.label, again.nonceB)
    approveEnrolment(startCeremony(again).code, devicesFile, 'm1', () => now)
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
  })

  it('never writes the code anywhere but the 0600 device list', () => {
    const { code } = startCeremony()
    expect(readFileSync(devicesFile, 'utf8')).toContain(code)
    expect(quiet.log.mock.calls.flat().join(' ')).not.toContain(code)
  })
})
