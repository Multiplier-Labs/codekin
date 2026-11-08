/** Tests for the machine's trust store, relay-devices.json (signed-intents spec §4.3). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  describeTrustStore, emptyTrustStore, ensureTrustStore, parseTrustStore, readTrustStore, recordOwnerUserId,
  revokeCredential, setIntentPolicy, TrustStoreError, writeTrustStore,
} from './trust-store.js'
import type { TrustStore, TrustedCredential } from './trust-store.js'

const quiet = { log: vi.fn(), warn: vi.fn() }

const BROWSER: TrustedCredential = {
  keyId: 'q3aaaaaaaaaaaaaaaaaaaa', kind: 'browser', userId: 'u1', spki: 'MFkw', label: 'Safari · iPhone',
  addedAt: '2026-11-08T10:00:00Z', addedBy: 'local', lastUsedAt: '2026-11-08T12:31:00Z',
}
const PASSKEY: TrustedCredential = {
  keyId: 'p7aaaaaaaaaaaaaaaaaaaa', kind: 'passkey', userId: 'u1', credentialId: 'cred', cosePublicKey: 'cose',
  rpId: 'relay.example.com', label: 'iCloud Keychain', addedAt: '2026-11-08T10:00:00Z', addedBy: 'local',
}

function storeWith(credentials: TrustedCredential[], extra: Partial<TrustStore> = {}): TrustStore {
  return { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials, ...extra }
}

describe('trust store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-trust-'))
    file = join(dir, 'relay-devices.json')
    quiet.log.mockClear(); quiet.warn.mockClear()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty with policy off, mode 0600', () => {
    const store = ensureTrustStore('m1', 'https://relay.test', { file, ownerUserId: 'u1', log: quiet })
    expect(store).toEqual({
      version: 1, machineId: 'm1', ownerUserId: 'u1', relayOrigin: 'https://relay.test',
      policy: 'off', credentials: [], pending: [], revokedGrants: [],
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readTrustStore(file)).toEqual(store)
  })

  it('returns null when there is no file', () => {
    expect(readTrustStore(file)).toBeNull()
  })

  it('round-trips the spec example shape, both credential kinds', () => {
    const store = storeWith([BROWSER, PASSKEY], { policy: 'required', pending: [{ enrolId: 'e1' }], revokedGrants: ['g1'] })
    writeTrustStore(file, store)
    expect(readTrustStore(file)).toEqual(store)
  })

  it('keeps the list for the same pairing and starts over after a re-pair', () => {
    writeTrustStore(file, storeWith([BROWSER]))
    expect(ensureTrustStore('m1', 'https://relay.test', { file, log: quiet }).credentials).toHaveLength(1)
    const fresh = ensureTrustStore('m2', 'https://relay.test', { file, log: quiet })
    expect(fresh).toMatchObject({ machineId: 'm2', credentials: [], policy: 'off', ownerUserId: null })
  })

  it('never replaces an unreadable file', () => {
    writeFileSync(file, '{ "version": 1, "machineId": "m1"')
    expect(() => ensureTrustStore('m1', 'https://relay.test', { file, log: quiet })).toThrow(TrustStoreError)
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1, "machineId": "m1"')
  })

  it('treats a credential entry it cannot read as an unreadable file, not a revocation', () => {
    const raw = JSON.stringify({ ...storeWith([BROWSER]), credentials: [BROWSER, { keyId: 'x', kind: 'mystery' }] })
    expect(() => parseTrustStore(raw)).toThrow(/credential entry/)
    expect(() => parseTrustStore(JSON.stringify({ ...storeWith([]), policy: 'lenient' }))).toThrow(/policy/)
    expect(() => parseTrustStore(JSON.stringify({ ...storeWith([]), version: 2 }))).toThrow(/version/)
  })

  it('records the owner once and never replaces it from the relay', () => {
    ensureTrustStore('m1', 'https://relay.test', { file, log: quiet })
    expect(recordOwnerUserId('m1', 'u1', file, quiet)).toBe(true)
    expect(readTrustStore(file)?.ownerUserId).toBe('u1')
    expect(recordOwnerUserId('m1', 'u-other', file, quiet)).toBe(false)
    expect(readTrustStore(file)?.ownerUserId).toBe('u1')
    expect(quiet.warn).toHaveBeenCalled()
    // A list from another pairing is not touched.
    expect(recordOwnerUserId('m2', 'u2', file, quiet)).toBe(false)
  })

  it('fills in the owner on ensure when the list has none yet', () => {
    ensureTrustStore('m1', 'https://relay.test', { file, log: quiet })
    expect(ensureTrustStore('m1', 'https://relay.test', { file, ownerUserId: 'u1', log: quiet }).ownerUserId).toBe('u1')
  })

  it('revokes a device by key id', () => {
    writeTrustStore(file, storeWith([BROWSER, PASSKEY]))
    expect(revokeCredential(BROWSER.keyId, file, 'm1')).toEqual(BROWSER)
    expect(readTrustStore(file)?.credentials).toEqual([PASSKEY])
    expect(() => revokeCredential(BROWSER.keyId, file, 'm1')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => revokeCredential(PASSKEY.keyId, file, 'm2')).toThrow(expect.objectContaining({ code: 'wrong_machine' }))
  })

  it('sets the policy, but not to required without an owner device', () => {
    writeTrustStore(file, storeWith([]))
    expect(setIntentPolicy('warn', file, 'm1').policy).toBe('warn')
    expect(() => setIntentPolicy('required', file, 'm1')).toThrow(expect.objectContaining({ code: 'no_credentials' }))
    expect(() => setIntentPolicy('lenient', file, 'm1')).toThrow(expect.objectContaining({ code: 'invalid_policy' }))
    // A grantee's key is not an owner device.
    writeTrustStore(file, storeWith([{ ...BROWSER, userId: 'u-grantee' }]))
    expect(() => setIntentPolicy('required', file, 'm1')).toThrow(expect.objectContaining({ code: 'no_credentials' }))
    writeTrustStore(file, storeWith([BROWSER]))
    expect(setIntentPolicy('required', file, 'm1').policy).toBe('required')
    expect(setIntentPolicy('off', file, 'm1').policy).toBe('off')
  })

  it('describes the list without key material', () => {
    const view = describeTrustStore(storeWith([BROWSER, PASSKEY], { pending: [{}, {}] }))
    expect(view.pendingCount).toBe(2)
    const text = JSON.stringify(view)
    for (const secretish of ['MFkw', 'cose', 'cred']) expect(text).not.toContain(`"${secretish}"`)
    expect(view.credentials[0]).toEqual({
      keyId: BROWSER.keyId, kind: 'browser', userId: 'u1', label: 'Safari · iPhone',
      addedAt: BROWSER.addedAt, addedBy: 'local', lastUsedAt: BROWSER.lastUsedAt,
    })
  })
})
