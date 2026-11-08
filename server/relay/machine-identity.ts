/**
 * The machine's relay identity key (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md
 * §4.1): one ECDSA P-256 signing key pair, made at pairing time, or on the
 * first connector start after an upgrade for machines paired before.
 *
 * File: ~/.config/codekin/relay-identity.json, mode 0600, beside relay.json.
 *
 *   {
 *     "version": 1,
 *     "machineId": "m_…",
 *     "relayOrigin": "https://app.codekin.ai",
 *     "createdAt": "2026-11-08T10:00:00.000Z",
 *     "publicKey": "<base64url SPKI DER>",
 *     "privateKey": "<base64url PKCS#8 DER>"      // or
 *     "privateKeyRef": "keychain"
 *   }
 *
 * With a secret store (the desktop app's Keychain), the private key lives
 * there under account `<machineId>.identity` and the file only points at it,
 * the same way relay.json does for the machine secret.
 *
 * The public key goes to the relay on pair/complete and in ConnectorHello,
 * but the relay's copy is only a hint: browsers trust the key they pin
 * during enrolment (§5.2). Nothing signs with this key yet; enrolment
 * (slice 3) is its first user.
 *
 * Re-pairing makes a new identity, so the file is bound to one machine id.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto'
import type { KeyObject } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileAtomic } from './relay-credential.js'
import { SECRET_REF_KEYCHAIN, secretStoreFromEnv } from './secret-store.js'
import type { SecretStore } from './secret-store.js'

export function relayIdentityPath(home = homedir()): string {
  return join(home, '.config', 'codekin', 'relay-identity.json')
}

/** The public half of the machine identity: safe to show and to send to the relay. */
export interface MachineIdentity {
  machineId: string
  relayOrigin: string
  createdAt: string
  /** base64url SPKI DER of the P-256 public key. */
  publicKey: string
  /** base64url(SHA-256(SPKI))[0:22], the same key id devices use (§4.2). */
  keyId: string
}

/** A fresh key pair, both halves base64url DER. */
export interface MachineKeyPair {
  publicKey: string
  privateKey: string
}

/** Longest SPKI accepted from a peer; a P-256 SPKI is 91 bytes (122 base64url chars). */
const MAX_SPKI_CHARS = 256

/** Key id for an SPKI (§4.2): base64url(SHA-256(SPKI))[0:22]. */
export function keyIdForSpki(spkiB64url: string): string {
  return createHash('sha256').update(Buffer.from(spkiB64url, 'base64url')).digest('base64url').slice(0, 22)
}

/**
 * Parse an untrusted base64url SPKI and accept it only if it is an EC P-256
 * public key. Returns the canonical re-encoding, or null.
 */
export function parseP256Spki(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_SPKI_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    return key.export({ format: 'der', type: 'spki' }).toString('base64url')
  } catch {
    return null
  }
}

export function generateMachineKeyPair(): MachineKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { publicKey: publicKey.toString('base64url'), privateKey: privateKey.toString('base64url') }
}

/** Keychain account for a machine's identity key; the helper allows [A-Za-z0-9._-]. */
export function identityStoreAccount(machineId: string): string {
  return `${machineId}.identity`
}

interface IdentityFile {
  version: 1
  machineId: string
  relayOrigin: string
  createdAt: string
  publicKey: string
  privateKey?: string
  privateKeyRef?: string
}

function readIdentityFile(file: string): IdentityFile | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Partial<IdentityFile>
  if (v.version !== 1 || typeof v.machineId !== 'string' || !v.machineId) return null
  if (typeof v.relayOrigin !== 'string' || typeof v.createdAt !== 'string') return null
  const publicKey = parseP256Spki(v.publicKey)
  if (!publicKey) return null
  if (typeof v.privateKey !== 'string' && v.privateKeyRef !== SECRET_REF_KEYCHAIN) return null
  return { ...v, publicKey } as IdentityFile
}

/** The machine identity on disk, or null when there is none or it is unreadable. */
export function readMachineIdentity(file = relayIdentityPath()): MachineIdentity | null {
  const parsed = readIdentityFile(file)
  if (!parsed) return null
  return {
    machineId: parsed.machineId,
    relayOrigin: parsed.relayOrigin,
    createdAt: parsed.createdAt,
    publicKey: parsed.publicKey,
    keyId: keyIdForSpki(parsed.publicKey),
  }
}

/**
 * Write the identity for `machineId`, replacing any previous one. The
 * private key goes to the secret store when there is one and it reads back
 * intact; otherwise into the file. A Keychain hiccup must not lose the key.
 */
export function writeMachineIdentity(
  file: string,
  machineId: string,
  relayOrigin: string,
  pair: MachineKeyPair,
  store: SecretStore | null = secretStoreFromEnv(),
  log: Pick<Console, 'warn'> = console,
  now: () => Date = () => new Date(),
): MachineIdentity {
  const publicKey = parseP256Spki(pair.publicKey)
  if (!publicKey) throw new Error('machine identity public key is not a P-256 SPKI')
  mkdirSync(dirname(file), { recursive: true })
  const content: IdentityFile = {
    version: 1,
    machineId,
    relayOrigin,
    createdAt: now().toISOString(),
    publicKey,
  }
  let stored = false
  if (store) {
    const account = identityStoreAccount(machineId)
    try {
      store.set(account, pair.privateKey)
      stored = store.get(account) === pair.privateKey
    } catch (err) {
      log.warn(`[relay] Keeping the machine identity key in ${file}: the Keychain refused it (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (stored) content.privateKeyRef = SECRET_REF_KEYCHAIN
  else content.privateKey = pair.privateKey
  writeFileAtomic(file, JSON.stringify(content, null, 2) + '\n')
  return {
    machineId,
    relayOrigin,
    createdAt: content.createdAt,
    publicKey,
    keyId: keyIdForSpki(publicKey),
  }
}

export interface EnsureIdentityOptions {
  file?: string
  store?: SecretStore | null
  log?: Pick<Console, 'log' | 'warn'>
}

/**
 * The identity for `machineId`, creating one if the file is missing,
 * unreadable or belongs to another pairing (re-paired machines get a new
 * identity, §4.1).
 */
export function ensureMachineIdentity(
  machineId: string,
  relayOrigin: string,
  opts: EnsureIdentityOptions = {},
): MachineIdentity {
  const file = opts.file ?? relayIdentityPath()
  const existing = readMachineIdentity(file)
  if (existing && existing.machineId === machineId) return existing
  const store = opts.store !== undefined ? opts.store : secretStoreFromEnv()
  const log = opts.log ?? console
  if (existing) {
    // The old pairing's Keychain item is useless now; best effort.
    try { store?.delete(identityStoreAccount(existing.machineId)) } catch { /* ignore */ }
  }
  const identity = writeMachineIdentity(file, machineId, relayOrigin, generateMachineKeyPair(), store, log)
  log.log(`[relay] Created this machine's relay identity key ${identity.keyId}`)
  return identity
}

/**
 * The private signing key, for the code that signs enrolment transcripts
 * (slice 3). Null when there is no identity or its key can't be read.
 */
export function loadMachineSigningKey(
  file = relayIdentityPath(),
  store: SecretStore | null = secretStoreFromEnv(),
): KeyObject | null {
  const parsed = readIdentityFile(file)
  if (!parsed) return null
  let pkcs8: string | null = parsed.privateKey ?? null
  if (pkcs8 === null && parsed.privateKeyRef === SECRET_REF_KEYCHAIN) {
    try { pkcs8 = store?.get(identityStoreAccount(parsed.machineId)) ?? null } catch { return null }
  }
  if (!pkcs8) return null
  try {
    const key = createPrivateKey({ key: Buffer.from(pkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
    // The private key must belong to the public key the relay and browsers see.
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url')
    return spki === parsed.publicKey ? key : null
  } catch {
    return null
  }
}

/** Delete the identity file and its Keychain item. Returns false when there was no file. */
export function removeMachineIdentity(
  file = relayIdentityPath(),
  store: SecretStore | null = secretStoreFromEnv(),
): boolean {
  if (!existsSync(file)) return false
  const parsed = readIdentityFile(file)
  if (parsed?.privateKeyRef === SECRET_REF_KEYCHAIN) {
    try { store?.delete(identityStoreAccount(parsed.machineId)) } catch { /* the file goes regardless */ }
  }
  rmSync(file, { force: true })
  return true
}
