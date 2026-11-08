/**
 * The machine's trust store (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §4.3):
 * the local list of device credentials allowed to control this machine
 * through the relay, and the machine's intent policy.
 *
 * File: ~/.config/codekin/relay-devices.json, mode 0600. Only the connector
 * and local surfaces (the local server's /api/relay/devices* routes and
 * `codekin relay devices`) write it. The relay can't reach any of them.
 *
 * Slice 2 creates the file and lets the owner read it, revoke entries and set
 * the policy. Nothing adds credentials yet (enrolment is slice 3) and nothing
 * enforces the policy yet (slices 4 and 7).
 *
 * The store belongs to one pairing: a machine id that doesn't match relay.json
 * means the machine was re-paired, and re-pairing starts with an empty store
 * (§5.6). An unreadable file is never silently replaced: once enforcement
 * exists, resetting it would quietly drop the policy.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileAtomic } from './relay-credential.js'

export function relayDevicesPath(home = homedir()): string {
  return join(home, '.config', 'codekin', 'relay-devices.json')
}

export const INTENT_POLICIES = ['off', 'warn', 'required'] as const
export type IntentPolicy = (typeof INTENT_POLICIES)[number]

export function isIntentPolicy(value: unknown): value is IntentPolicy {
  return typeof value === 'string' && (INTENT_POLICIES as readonly string[]).includes(value)
}

interface CredentialBase {
  keyId: string
  userId: string
  label: string
  addedAt: string
  /** `local` (confirmed on this machine) or `passkey:<keyId>` (certified by an enrolled passkey). */
  addedBy: string
  lastUsedAt?: string
}

export interface BrowserCredential extends CredentialBase {
  kind: 'browser'
  /** base64url SPKI DER. */
  spki: string
}

export interface PasskeyCredential extends CredentialBase {
  kind: 'passkey'
  credentialId: string
  cosePublicKey: string
  rpId: string
}

export type TrustedCredential = BrowserCredential | PasskeyCredential

export interface TrustStore {
  version: 1
  machineId: string
  /** The relay user who owns this machine, from pair/complete or the first hello_ack. */
  ownerUserId: string | null
  relayOrigin: string
  policy: IntentPolicy
  credentials: TrustedCredential[]
  /** Enrolment requests awaiting a code (slice 3). Kept as written. */
  pending: unknown[]
  /** Share grants revoked here (slice 6). Kept as written. */
  revokedGrants: unknown[]
}

export class TrustStoreError extends Error {
  constructor(
    readonly code: 'unreadable' | 'not_found' | 'no_credentials' | 'invalid_policy' | 'wrong_machine',
    message: string,
  ) {
    super(message)
    this.name = 'TrustStoreError'
  }
}

export function emptyTrustStore(machineId: string, relayOrigin: string, ownerUserId: string | null = null): TrustStore {
  return {
    version: 1,
    machineId,
    ownerUserId,
    relayOrigin,
    policy: 'off',
    credentials: [],
    pending: [],
    revokedGrants: [],
  }
}

const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

function parseCredential(value: unknown): TrustedCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Record<string, unknown>
  if (!str(c.keyId, 64) || !str(c.userId, 200) || typeof c.label !== 'string' || !str(c.addedAt, 64) || !str(c.addedBy, 128)) return null
  const base: CredentialBase = {
    keyId: c.keyId,
    userId: c.userId,
    label: c.label.slice(0, 200),
    addedAt: c.addedAt,
    addedBy: c.addedBy,
    ...(str(c.lastUsedAt, 64) ? { lastUsedAt: c.lastUsedAt } : {}),
  }
  if (c.kind === 'browser' && str(c.spki, 1024)) return { ...base, kind: 'browser', spki: c.spki }
  if (c.kind === 'passkey' && str(c.credentialId, 1024) && str(c.cosePublicKey, 2048) && str(c.rpId, 253)) {
    return { ...base, kind: 'passkey', credentialId: c.credentialId, cosePublicKey: c.cosePublicKey, rpId: c.rpId }
  }
  return null
}

/**
 * Parse a trust store. Throws TrustStoreError('unreadable') on anything it
 * can't fully account for, including a credential entry it doesn't
 * understand: dropping one silently would look like a revocation.
 */
export function parseTrustStore(text: string): TrustStore {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new TrustStoreError('unreadable', 'relay-devices.json is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrustStoreError('unreadable', 'relay-devices.json is not an object')
  }
  const v = value as Record<string, unknown>
  if (v.version !== 1) throw new TrustStoreError('unreadable', `relay-devices.json has unsupported version ${String(v.version)}`)
  if (!str(v.machineId, 200) || !str(v.relayOrigin, 2048)) {
    throw new TrustStoreError('unreadable', 'relay-devices.json is missing machineId or relayOrigin')
  }
  if (!isIntentPolicy(v.policy)) throw new TrustStoreError('unreadable', 'relay-devices.json has an unknown policy')
  if (v.ownerUserId !== null && v.ownerUserId !== undefined && !str(v.ownerUserId, 200)) {
    throw new TrustStoreError('unreadable', 'relay-devices.json has an invalid ownerUserId')
  }
  if (!Array.isArray(v.credentials)) throw new TrustStoreError('unreadable', 'relay-devices.json has no credentials list')
  const credentials: TrustedCredential[] = []
  for (const entry of v.credentials) {
    const parsed = parseCredential(entry)
    if (!parsed) throw new TrustStoreError('unreadable', 'relay-devices.json has a credential entry it cannot read')
    credentials.push(parsed)
  }
  return {
    version: 1,
    machineId: v.machineId,
    ownerUserId: typeof v.ownerUserId === 'string' ? v.ownerUserId : null,
    relayOrigin: v.relayOrigin,
    policy: v.policy,
    credentials,
    pending: Array.isArray(v.pending) ? v.pending : [],
    revokedGrants: Array.isArray(v.revokedGrants) ? v.revokedGrants : [],
  }
}

/** The trust store on disk, or null when there is none. Throws TrustStoreError when unreadable. */
export function readTrustStore(file = relayDevicesPath()): TrustStore | null {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new TrustStoreError('unreadable', `relay-devices.json could not be read (${(err as Error).message})`)
  }
  return parseTrustStore(text)
}

export function writeTrustStore(file: string, store: TrustStore): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify(store, null, 2) + '\n')
}

export interface EnsureTrustStoreOptions {
  file?: string
  /** Known at pairing; for older pairings it arrives with the first hello_ack. */
  ownerUserId?: string | null
  log?: Pick<Console, 'log' | 'warn'>
}

/**
 * The trust store for `machineId`, created empty (policy `off`, §6.8) when
 * missing or left over from an earlier pairing. Throws TrustStoreError when
 * the existing file can't be read; it is left as it is for the owner to fix
 * or remove.
 */
export function ensureTrustStore(machineId: string, relayOrigin: string, opts: EnsureTrustStoreOptions = {}): TrustStore {
  const file = opts.file ?? relayDevicesPath()
  const log = opts.log ?? console
  const existing = readTrustStore(file)
  if (existing && existing.machineId === machineId) {
    if (existing.ownerUserId === null && opts.ownerUserId) {
      const updated = { ...existing, ownerUserId: opts.ownerUserId }
      writeTrustStore(file, updated)
      return updated
    }
    return existing
  }
  if (existing) {
    log.log(`[relay] This machine was re-paired (${existing.machineId} → ${machineId}); starting an empty device list.`)
  }
  const fresh = emptyTrustStore(machineId, relayOrigin, opts.ownerUserId ?? null)
  writeTrustStore(file, fresh)
  return fresh
}

/**
 * Record the owner's relay user id the first time the relay names it. An
 * owner id that is already recorded is never replaced from the relay's word:
 * ownership changes revoke the machine credential and force a re-pair, which
 * starts a new store. Returns true when the store now holds `userId`.
 */
export function recordOwnerUserId(
  machineId: string,
  userId: string,
  file = relayDevicesPath(),
  log: Pick<Console, 'warn'> = console,
): boolean {
  const store = readTrustStore(file)
  if (!store || store.machineId !== machineId) return false
  if (store.ownerUserId === userId) return true
  if (store.ownerUserId !== null) {
    log.warn(`[relay] The relay named a different owner for this machine than the one recorded at pairing; keeping ${store.ownerUserId}.`)
    return false
  }
  writeTrustStore(file, { ...store, ownerUserId: userId })
  return true
}

function requireStore(file: string, machineId?: string): TrustStore {
  const store = readTrustStore(file)
  if (!store) throw new TrustStoreError('not_found', 'This machine has no device list yet')
  if (machineId !== undefined && store.machineId !== machineId) {
    throw new TrustStoreError('wrong_machine', 'The device list belongs to an earlier pairing of this machine')
  }
  return store
}

/** Remove a credential. Returns the removed entry. */
export function revokeCredential(keyId: string, file = relayDevicesPath(), machineId?: string): TrustedCredential {
  const store = requireStore(file, machineId)
  const removed = store.credentials.find(c => c.keyId === keyId)
  if (!removed) throw new TrustStoreError('not_found', `No device with key id ${keyId}`)
  writeTrustStore(file, { ...store, credentials: store.credentials.filter(c => c.keyId !== keyId) })
  return removed
}

/**
 * Set the intent policy. Local surfaces may set any value (§6.8), but
 * `required` with no owner credential would refuse every browser, so it
 * needs at least one.
 */
export function setIntentPolicy(policy: unknown, file = relayDevicesPath(), machineId?: string): TrustStore {
  if (!isIntentPolicy(policy)) throw new TrustStoreError('invalid_policy', `Policy must be one of ${INTENT_POLICIES.join(', ')}`)
  const store = requireStore(file, machineId)
  if (policy === 'required' && !store.credentials.some(c => store.ownerUserId !== null && c.userId === store.ownerUserId)) {
    throw new TrustStoreError('no_credentials', 'Confirm at least one of your devices on this computer before requiring confirmed devices')
  }
  const updated = { ...store, policy }
  writeTrustStore(file, updated)
  return updated
}

/** Delete the trust store (on unpair). Returns false when there was none. */
export function removeTrustStore(file = relayDevicesPath()): boolean {
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** What local surfaces show: no key material beyond ids. */
export interface TrustStoreView {
  machineId: string
  ownerUserId: string | null
  policy: IntentPolicy
  credentials: Array<Pick<TrustedCredential, 'keyId' | 'kind' | 'userId' | 'label' | 'addedAt' | 'addedBy' | 'lastUsedAt'>>
  pendingCount: number
}

export function describeTrustStore(store: TrustStore): TrustStoreView {
  return {
    machineId: store.machineId,
    ownerUserId: store.ownerUserId,
    policy: store.policy,
    credentials: store.credentials.map(c => ({
      keyId: c.keyId,
      kind: c.kind,
      userId: c.userId,
      label: c.label,
      addedAt: c.addedAt,
      addedBy: c.addedBy,
      ...(c.lastUsedAt ? { lastUsedAt: c.lastUsedAt } : {}),
    })),
    pendingCount: store.pending.length,
  }
}
