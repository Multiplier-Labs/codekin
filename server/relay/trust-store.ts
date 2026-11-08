/**
 * The machine's trust store (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §4.3):
 * the local list of device credentials allowed to control this machine
 * through the relay, and the machine's intent policy.
 *
 * File: ~/.config/codekin/relay-devices.json, mode 0600. Only the connector
 * and local surfaces (the local server's /api/relay/devices* routes and
 * `codekin relay devices`) write it. The relay can't reach any of them.
 *
 * Credentials are added by the enrolment ceremony (enrolment.ts), whose
 * requests wait in `pending` until the owner types the browser's code on
 * this machine. Nothing enforces the policy yet (slices 4 and 7).
 *
 * The connector and the local surfaces may be different processes (the CLI,
 * an unmanaged connector), so every read-modify-write holds a lock file.
 *
 * The store belongs to one pairing: a machine id that doesn't match relay.json
 * means the machine was re-paired, and re-pairing starts with an empty store
 * (§5.6). An unreadable file is never silently replaced: once enforcement
 * exists, resetting it would quietly drop the policy.
 */

import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { writeFileAtomic } from './relay-credential.js'
import { formatCode } from './enrolment-crypto.js'
import type { EnrolPasskey } from './enrolment-crypto.js'
import { grantIssuedAt } from './intent-actions.js'
import type { GrantRevocation } from './intent-actions.js'

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

/**
 * An enrolment request (spec §5.2). Created by `enrol_commit`, completed by
 * `enrol_reveal`, and decided on this machine: approved when the owner types
 * `reveal.code`, or rejected. The code never leaves this file.
 */
export interface PendingEnrolment {
  enrolId: string
  /** The relay user the request came from; must be the machine owner. */
  userId: string
  /** base64url commitment C. */
  commit: string
  /** base64url machine nonce. */
  nonceM: string
  createdAt: string
  expiresAt: string
  reveal?: {
    spki: string
    keyId: string
    label: string
    nonceB: string
    passkeys: EnrolPasskey[]
    /** The 8-character code, compared with what the owner types. */
    code: string
    /** The 6-character code shown after approval, for the owner to type in the browser. */
    confirmCode?: string
    revealedAt: string
  }
  outcome?: { state: 'approved' | 'rejected'; at: string }
}

export interface TrustStore {
  version: 1
  machineId: string
  /** The relay user who owns this machine, from pair/complete or the first hello_ack. */
  ownerUserId: string | null
  relayOrigin: string
  policy: IntentPolicy
  /**
   * "Only allow devices confirmed on this computer" (spec §5.4, D5): when set,
   * an enrolled passkey can't add a browser. Local surfaces only.
   */
  localConfirmationOnly?: boolean
  credentials: TrustedCredential[]
  /** Enrolment requests, until they expire. */
  pending: PendingEnrolment[]
  /** Share grants the owner revoked on this machine (§6.7). */
  revokedGrants: RevokedGrant[]
}

export class TrustStoreError extends Error {
  constructor(
    readonly code: 'unreadable' | 'not_found' | 'no_credentials' | 'invalid_policy' | 'wrong_machine' | 'busy',
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

function parsePending(value: unknown): PendingEnrolment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (!str(p.enrolId, 64) || !str(p.userId, 200) || !str(p.commit, 128) || !str(p.nonceM, 128)) return null
  if (!str(p.createdAt, 64) || !str(p.expiresAt, 64)) return null
  const entry: PendingEnrolment = {
    enrolId: p.enrolId, userId: p.userId, commit: p.commit, nonceM: p.nonceM, createdAt: p.createdAt, expiresAt: p.expiresAt,
  }
  if (p.reveal !== undefined) {
    const r = p.reveal as Record<string, unknown> | null
    if (!r || !str(r.spki, 1024) || !str(r.keyId, 64) || !str(r.label, 200) || !str(r.nonceB, 128) || !str(r.code, 16) || !str(r.revealedAt, 64)) return null
    if (!Array.isArray(r.passkeys)) return null
    entry.reveal = {
      spki: r.spki, keyId: r.keyId, label: r.label, nonceB: r.nonceB, code: r.code, revealedAt: r.revealedAt,
      passkeys: r.passkeys as EnrolPasskey[],
      ...(str(r.confirmCode, 16) ? { confirmCode: r.confirmCode } : {}),
    }
  }
  if (p.outcome !== undefined) {
    const o = p.outcome as Record<string, unknown> | null
    if (!o || (o.state !== 'approved' && o.state !== 'rejected') || !str(o.at, 64)) return null
    entry.outcome = { state: o.state, at: o.at }
  }
  return entry
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
    ...(v.localConfirmationOnly === true ? { localConfirmationOnly: true } : {}),
    credentials,
    // An unreadable request is only a request: dropping it is harmless.
    pending: Array.isArray(v.pending) ? v.pending.map(parsePending).filter((e): e is PendingEnrolment => e !== null) : [],
    revokedGrants: Array.isArray(v.revokedGrants)
      ? v.revokedGrants.filter((g): g is RevokedGrant => !!g && typeof g === 'object' && str((g as RevokedGrant).grantId, 200) && str((g as RevokedGrant).at, 64)
        && ((g as RevokedGrant).keep === undefined || str((g as RevokedGrant).keep, 200)))
      : [],
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

const LOCK_WAIT_MS = 3_000
const LOCK_STALE_MS = 10_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))

/**
 * Run `fn` holding relay-devices.json.lock. The lock file holds a random
 * token: a holder only removes a lock that still has its token, and a lock
 * older than LOCK_STALE_MS (left by a crashed process) is taken over by
 * renaming it aside first, which only one waiter can do.
 */
export function withTrustStoreLock<T>(file: string, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try { writeSync(fd, token) } finally { closeSync(fd) }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        const aside = `${lock}.stale-${token}`
        renameSync(lock, aside) // throws if another waiter got there first
        // Between the stat and the rename, someone may have replaced the
        // stale lock with a live one: if so, put it back.
        if (Date.now() - statSync(aside).mtimeMs <= LOCK_STALE_MS) {
          try { linkSync(aside, lock) } catch { /* a newer lock is already in place */ }
        }
        rmSync(aside, { force: true })
        continue
      }
    } catch { continue }
    if (Date.now() > deadline) throw new TrustStoreError('busy', 'The device list is being changed by another process; try again')
    Atomics.wait(sleeper, 0, 0, 20)
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(lock, 'utf-8') === token) rmSync(lock, { force: true })
    } catch { /* already gone */ }
  }
}

/**
 * A grant the owner revoked on this machine (§6.7). Kept for good: a browser
 * of the owner's that never heard of the revocation may still re-sign the
 * old grant with a fresh date, so letting the entry lapse would let it back.
 */
export interface RevokedGrant extends GrantRevocation {
  at: string
}

/** A bound on the list; entries coalesce to at most one per share, so this is a lot of shares. */
export const MAX_REVOKED_GRANTS = 10_000

/**
 * Record a revocation (owner-signed grant_revoke), coalescing with what is
 * there: a full revocation of an id covers any supersede of it, and of two
 * supersedes the one keeping the later grant covers the other.
 */
export function addRevokedGrant(revocation: GrantRevocation, file: string, machineId: string, now = Date.now()): void {
  mutateTrustStore(file, machineId, store => {
    store.revokedGrants = withRevocation(store.revokedGrants, revocation, now)
  }, now)
}

export function withRevocation(list: RevokedGrant[], revocation: GrantRevocation, now = Date.now()): RevokedGrant[] {
  const { grantId, keep } = revocation
  const same = list.filter(r => r.grantId === grantId)
  // Already covered: a full revocation, or a supersede keeping something no
  // earlier than this one's kept grant (which that supersede then revokes).
  const covered = same.some(r => r.keep === undefined || (keep !== undefined && (r.keep === keep || isEarlier(keep, r.keep, grantId))))
  if (covered) return list
  const entry: RevokedGrant = keep === undefined ? { grantId, at: new Date(now).toISOString() } : { grantId, keep, at: new Date(now).toISOString() }
  const next = [...list.filter(r => r.grantId !== grantId), entry]
  return next.length > MAX_REVOKED_GRANTS ? next.slice(next.length - MAX_REVOKED_GRANTS) : next
}

/** Whether grant `a` was issued before grant `b` (both under `shareId`). */
function isEarlier(a: string, b: string, shareId: string): boolean {
  const ta = grantIssuedAt(a, shareId)
  const tb = grantIssuedAt(b, shareId)
  return ta !== null && tb !== null && ta < tb
}

/** Drop requests past their expiry. Returns true when any were dropped. */
export function prunePending(store: TrustStore, now = Date.now()): boolean {
  const kept = store.pending.filter(p => Date.parse(p.expiresAt) > now)
  if (kept.length === store.pending.length) return false
  store.pending = kept
  return true
}

/**
 * Read, change and write the store under the lock. `fn` edits the store it
 * is given; it is written back afterwards unless `fn` throws. Expired
 * enrolment requests are dropped on the way.
 */
export function mutateTrustStore<T>(
  file: string,
  machineId: string | undefined,
  fn: (store: TrustStore) => T,
  now = Date.now(),
  /** How long to wait for the lock; 0 gives up at once (callers on a hot path). */
  waitMs = LOCK_WAIT_MS,
): T {
  return withTrustStoreLock(file, () => {
    const store = requireStore(file, machineId)
    prunePending(store, now)
    const result = fn(store)
    writeTrustStore(file, store)
    return result
  }, waitMs)
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
  return withTrustStoreLock(file, () => {
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
  })
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
  return withTrustStoreLock(file, () => {
    const store = readTrustStore(file)
    if (!store || store.machineId !== machineId) return false
    if (store.ownerUserId === userId) return true
    if (store.ownerUserId !== null) {
      log.warn(`[relay] The relay named a different owner for this machine than the one recorded at pairing; keeping ${store.ownerUserId}.`)
      return false
    }
    writeTrustStore(file, { ...store, ownerUserId: userId })
    return true
  })
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
  return mutateTrustStore(file, machineId, store => {
    const removed = store.credentials.find(c => c.keyId === keyId)
    if (!removed) throw new TrustStoreError('not_found', `No device with key id ${keyId}`)
    store.credentials = store.credentials.filter(c => c.keyId !== keyId)
    return removed
  })
}

/**
 * Set the intent policy. Local surfaces may set any value (§6.8), but
 * `required` with no owner credential would refuse every browser, so it
 * needs at least one.
 */
export function setIntentPolicy(policy: unknown, file = relayDevicesPath(), machineId?: string): TrustStore {
  if (!isIntentPolicy(policy)) throw new TrustStoreError('invalid_policy', `Policy must be one of ${INTENT_POLICIES.join(', ')}`)
  return mutateTrustStore(file, machineId, store => {
    if (policy === 'required' && !store.credentials.some(c => store.ownerUserId !== null && c.userId === store.ownerUserId)) {
      throw new TrustStoreError('no_credentials', 'Confirm at least one of your devices on this computer before requiring confirmed devices')
    }
    store.policy = policy
    return store
  })
}

/** Turn passkey-added browsers off (true) or on (false) for this machine. Local surfaces only. */
export function setLocalConfirmationOnly(value: boolean, file = relayDevicesPath(), machineId?: string): TrustStore {
  return mutateTrustStore(file, machineId, store => {
    if (value) store.localConfirmationOnly = true
    else delete store.localConfirmationOnly
    return store
  })
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
  localConfirmationOnly: boolean
  credentials: Array<Pick<TrustedCredential, 'keyId' | 'kind' | 'userId' | 'label' | 'addedAt' | 'addedBy' | 'lastUsedAt'>>
  /**
   * Requests waiting for their code, newest first. The code itself is never
   * shown here: the owner must read it off the browser, or the check is void.
   */
  pending: Array<{ enrolId: string; userId: string; label: string; createdAt: string; expiresAt: string }>
  pendingCount: number
  /**
   * Browsers approved here in the last hour, with the code to type in each
   * to finish. Showing it is safe: the machine shows it only once it has
   * approved, which is the point.
   */
  approved: Array<{ enrolId: string; label: string; confirmCode: string; approvedAt: string }>
}

/** How long a just-approved browser's finishing code stays listed. */
const APPROVED_LISTED_MS = 60 * 60_000

/** Requests that have a code and no decision yet. */
export function awaitingCode(store: TrustStore, now = Date.now()): PendingEnrolment[] {
  return store.pending.filter(p => p.reveal && !p.outcome && Date.parse(p.expiresAt) > now)
}

export function describeTrustStore(store: TrustStore, now = Date.now()): TrustStoreView {
  return {
    machineId: store.machineId,
    ownerUserId: store.ownerUserId,
    policy: store.policy,
    localConfirmationOnly: store.localConfirmationOnly === true,
    credentials: store.credentials.map(c => ({
      keyId: c.keyId,
      kind: c.kind,
      userId: c.userId,
      label: c.label,
      addedAt: c.addedAt,
      addedBy: c.addedBy,
      ...(c.lastUsedAt ? { lastUsedAt: c.lastUsedAt } : {}),
    })),
    pending: awaitingCode(store, now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(p => ({ enrolId: p.enrolId, userId: p.userId, label: p.reveal?.label ?? '', createdAt: p.createdAt, expiresAt: p.expiresAt })),
    pendingCount: awaitingCode(store, now).length,
    approved: store.pending
      .filter(p => p.outcome?.state === 'approved' && p.reveal?.confirmCode && Date.parse(p.outcome.at) > now - APPROVED_LISTED_MS)
      .sort((a, b) => (b.outcome?.at ?? '').localeCompare(a.outcome?.at ?? ''))
      .map(p => ({ enrolId: p.enrolId, label: p.reveal?.label ?? '', confirmCode: formatCode(p.reveal?.confirmCode ?? ''), approvedAt: p.outcome?.at ?? '' })),
  }
}
