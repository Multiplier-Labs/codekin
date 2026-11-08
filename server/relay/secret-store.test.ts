/**
 * Tests for keeping the machine secret out of relay.json: the helper store
 * (against a fake helper that speaks the same protocol as the desktop app),
 * reading, writing, migrating and removing Keychain-backed credentials.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HelperSecretStore, KEYCHAIN_SERVICE, secretStoreFromEnv } from './secret-store.js'
import { migrateCredentialToStore, readRelayCredential } from './relay-credential.js'
import { removeRelayCredential, writeRelayCredential } from './pairing-client.js'

const SECRET = 'q7Zr2bX9mK4vT1nL8pW3sYc6dF0hJ5gA-machine-secret'

/** A stand-in for `Codekin --codekin-secrets`: same argv, stdin/stdout and exit codes; a JSON file as the Keychain. */
function fakeHelper(dir: string, { failSet = false } = {}): { path: string; items: () => Record<string, string>; argvLog: () => string } {
  const db = join(dir, 'keychain.json')
  const log = join(dir, 'argv.log')
  const path = join(dir, 'helper.mjs')
  writeFileSync(path, `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
const [flag, op, service, account] = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
if (flag !== '--codekin-secrets' || !service.startsWith('ai.codekin.')) process.exit(2)
const items = existsSync(${JSON.stringify(db)}) ? JSON.parse(readFileSync(${JSON.stringify(db)}, 'utf8')) : {}
const key = service + '/' + account
if (op === 'get') { if (!(key in items)) process.exit(1); process.stdout.write(items[key]); process.exit(0) }
if (op === 'set') {
  if (${failSet}) { process.stderr.write('keychain locked'); process.exit(3) }
  items[key] = readFileSync(0, 'utf8'); writeFileSync(${JSON.stringify(db)}, JSON.stringify(items)); process.exit(0)
}
if (op === 'delete') { if (!(key in items)) process.exit(1); delete items[key]; writeFileSync(${JSON.stringify(db)}, JSON.stringify(items)); process.exit(0) }
process.exit(2)
`)
  chmodSync(path, 0o755)
  return {
    path,
    items: () => (existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) as Record<string, string> : {}),
    argvLog: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  }
}

describe('secret store', () => {
  let dir: string
  let file: string
  const quiet = { warn: vi.fn(), log: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-'))
    file = join(dir, 'relay.json')
    quiet.warn.mockClear()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is off unless CODEKIN_SECRET_HELPER is set', () => {
    expect(secretStoreFromEnv({})).toBeNull()
    expect(secretStoreFromEnv({ CODEKIN_SECRET_HELPER: '  ' })).toBeNull()
    expect(secretStoreFromEnv({ CODEKIN_SECRET_HELPER: '/Applications/Codekin.app/Contents/MacOS/Codekin' })).toBeInstanceOf(HelperSecretStore)
  })

  it('stores, reads and deletes through the helper, never putting the secret in argv', () => {
    const helper = fakeHelper(dir)
    const store = new HelperSecretStore(helper.path)
    expect(store.get('m1')).toBeNull()
    store.set('m1', SECRET)
    expect(store.get('m1')).toBe(SECRET)
    expect(helper.items()).toEqual({ [`${KEYCHAIN_SERVICE}/m1`]: SECRET })
    expect(store.delete('m1')).toBe(true)
    expect(store.delete('m1')).toBe(false)
    expect(helper.argvLog()).not.toContain(SECRET)
  })

  it('surfaces helper failures as errors, not as "no secret"', () => {
    const store = new HelperSecretStore(fakeHelper(dir, { failSet: true }).path)
    expect(() => { store.set('m1', SECRET) }).toThrow('keychain locked')
    expect(() => new HelperSecretStore(join(dir, 'missing')).get('m1')).toThrow('failed to run')
  })

  it('pairing writes only a reference to the file when a store is configured', () => {
    const helper = fakeHelper(dir)
    const store = new HelperSecretStore(helper.path)
    writeRelayCredential(file, 'https://relay.example.com', { machineId: 'm1', machineSecret: SECRET }, true, store)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw)).toEqual({ url: 'https://relay.example.com', machineId: 'm1', secretRef: 'keychain', managed: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readRelayCredential(file, store)).toEqual({ url: 'https://relay.example.com', machineId: 'm1', machineSecret: SECRET, managed: true })
    // Without the store (e.g. a plain terminal), the reference can't be resolved.
    expect(readRelayCredential(file, null)).toBeNull()
  })

  it('falls back to the file when the Keychain refuses, so a pairing is never lost', () => {
    const store = new HelperSecretStore(fakeHelper(dir, { failSet: true }).path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeRelayCredential(file, 'https://relay.example.com', { machineId: 'm1', machineSecret: SECRET }, true, store)
    warn.mockRestore()
    expect(JSON.parse(readFileSync(file, 'utf8')).machineSecret).toBe(SECRET)
  })

  it('migrates a plaintext secret: store, verify, then rewrite the file without it', () => {
    const helper = fakeHelper(dir)
    const store = new HelperSecretStore(helper.path)
    writeRelayCredential(file, 'https://relay.example.com', { machineId: 'm1', machineSecret: SECRET }, true, null)
    expect(readFileSync(file, 'utf8')).toContain(SECRET)

    expect(migrateCredentialToStore(file, store, quiet)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    expect(readRelayCredential(file, store)?.machineSecret).toBe(SECRET)
    // Already migrated: nothing to do.
    expect(migrateCredentialToStore(file, store, quiet)).toBe(false)
  })

  it('leaves the file untouched when migration cannot be verified', () => {
    const store = new HelperSecretStore(fakeHelper(dir, { failSet: true }).path)
    writeRelayCredential(file, 'https://relay.example.com', { machineId: 'm1', machineSecret: SECRET }, true, null)
    const before = readFileSync(file, 'utf8')
    expect(migrateCredentialToStore(file, store, quiet)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('Kept the machine secret'))
  })

  it('unpairing removes the Keychain item along with the file', () => {
    const helper = fakeHelper(dir)
    const store = new HelperSecretStore(helper.path)
    writeRelayCredential(file, 'https://relay.example.com', { machineId: 'm1', machineSecret: SECRET }, true, store)
    expect(removeRelayCredential(file, store)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(helper.items()).toEqual({})
  })
})
