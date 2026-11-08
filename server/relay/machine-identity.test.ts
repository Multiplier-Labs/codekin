/** Tests for the machine relay identity key (signed-intents spec §4.1). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureMachineIdentity, generateMachineKeyPair, identityStoreAccount, keyIdForSpki, loadMachineSigningKey,
  parseP256Spki, readMachineIdentity, removeMachineIdentity, writeMachineIdentity,
} from './machine-identity.js'
import type { SecretStore } from './secret-store.js'

const quiet = { log: vi.fn(), warn: vi.fn() }

function memoryStore(): SecretStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    get: (a) => items.get(a) ?? null,
    set: (a, s) => { items.set(a, s) },
    delete: (a) => items.delete(a),
  }
}

describe('machine identity', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-identity-'))
    file = join(dir, 'relay-identity.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('derives the key id from the SPKI as the spec says', () => {
    const { publicKey } = generateMachineKeyPair()
    const expected = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url').slice(0, 22)
    expect(keyIdForSpki(publicKey)).toBe(expected)
    expect(expected).toHaveLength(22)
  })

  it('accepts only P-256 public keys', () => {
    const p256 = generateMachineKeyPair().publicKey
    expect(parseP256Spki(p256)).toBe(p256)
    const der = (k: ReturnType<typeof generateKeyPairSync>['publicKey']) => k.export({ format: 'der', type: 'spki' }).toString('base64url')
    expect(parseP256Spki(der(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey))).toBeNull()
    expect(parseP256Spki(der(generateKeyPairSync('ed25519').publicKey))).toBeNull()
    expect(parseP256Spki('not-a-key')).toBeNull()
    expect(parseP256Spki('a'.repeat(300))).toBeNull()
    expect(parseP256Spki('+/=')).toBeNull()
    expect(parseP256Spki(42)).toBeNull()
  })

  it('writes the private key to the file, mode 0600, when there is no secret store', () => {
    const pair = generateMachineKeyPair()
    const identity = writeMachineIdentity(file, 'm1', 'https://relay.test', pair, null, quiet)
    expect(identity).toMatchObject({ machineId: 'm1', relayOrigin: 'https://relay.test', publicKey: pair.publicKey, keyId: keyIdForSpki(pair.publicKey) })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw).toMatchObject({ version: 1, privateKey: pair.privateKey })
    expect(raw.privateKeyRef).toBeUndefined()
    expect(readMachineIdentity(file)).toEqual(identity)
  })

  it('keeps the private key in the secret store when one is configured', () => {
    const store = memoryStore()
    const pair = generateMachineKeyPair()
    writeMachineIdentity(file, 'm1', 'https://relay.test', pair, store, quiet)
    expect(readFileSync(file, 'utf8')).not.toContain(pair.privateKey)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ privateKeyRef: 'keychain' })
    expect(store.items.get(identityStoreAccount('m1'))).toBe(pair.privateKey)
    // The desktop helper only allows [A-Za-z0-9._-] accounts.
    expect(identityStoreAccount('0e166371-5045-4237')).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
    expect(loadMachineSigningKey(file, store)).not.toBeNull()
  })

  it('falls back to the file when the secret store refuses the key', () => {
    const store: SecretStore = { get: () => null, set: () => { throw new Error('locked') }, delete: () => false }
    const pair = generateMachineKeyPair()
    writeMachineIdentity(file, 'm1', 'https://relay.test', pair, store, quiet)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ privateKey: pair.privateKey })
    expect(quiet.warn).toHaveBeenCalled()
  })

  it('signs in the IEEE P1363 form browsers verify, with the advertised public key', () => {
    const identity = ensureMachineIdentity('m1', 'https://relay.test', { file, store: null, log: quiet })
    const key = loadMachineSigningKey(file, null)
    expect(key).not.toBeNull()
    const data = Buffer.from('ck-enrol-test')
    const signature = sign('sha256', data, { key: key!, dsaEncoding: 'ieee-p1363' })
    expect(signature).toHaveLength(64)
    const pub = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), format: 'der', type: 'spki' })
    expect(verify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
  })

  it('refuses a private key that does not match the public key on file', () => {
    writeMachineIdentity(file, 'm1', 'https://relay.test', generateMachineKeyPair(), null, quiet)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.privateKey = generateMachineKeyPair().privateKey
    writeFileSync(file, JSON.stringify(raw))
    expect(loadMachineSigningKey(file, null)).toBeNull()
  })

  it('reuses the identity for the same pairing and replaces it after a re-pair', () => {
    const store = memoryStore()
    const first = ensureMachineIdentity('m1', 'https://relay.test', { file, store, log: quiet })
    expect(ensureMachineIdentity('m1', 'https://relay.test', { file, store, log: quiet })).toEqual(first)
    const second = ensureMachineIdentity('m2', 'https://relay.test', { file, store, log: quiet })
    expect(second.machineId).toBe('m2')
    expect(second.publicKey).not.toBe(first.publicKey)
    // The old pairing's Keychain item goes with it.
    expect(store.items.has(identityStoreAccount('m1'))).toBe(false)
    expect(store.items.has(identityStoreAccount('m2'))).toBe(true)
  })

  it('replaces an unreadable identity file', () => {
    writeFileSync(file, '{ not json')
    expect(readMachineIdentity(file)).toBeNull()
    const identity = ensureMachineIdentity('m1', 'https://relay.test', { file, store: null, log: quiet })
    expect(readMachineIdentity(file)).toEqual(identity)
  })

  it('removes the file and its Keychain item', () => {
    const store = memoryStore()
    ensureMachineIdentity('m1', 'https://relay.test', { file, store, log: quiet })
    expect(removeMachineIdentity(file, store)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(store.items.size).toBe(0)
    expect(removeMachineIdentity(file, store)).toBe(false)
  })
})
