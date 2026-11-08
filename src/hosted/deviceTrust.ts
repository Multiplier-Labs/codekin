/**
 * This browser's side of device trust (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md
 * §4.2, §5.2): its signing key, the machine keys it has pinned, and the
 * enrolment ceremony that puts the key on a machine.
 *
 * STORAGE EXCEPTION: this is the one thing in the hosted app kept in browser
 * storage (IndexedDB), on purpose. Preferences moved to the server (#670,
 * #671) because they should follow the user; a signing key must never follow
 * the user, and keeping it server-side would defeat it. The private key is a
 * non-extractable WebCrypto key: script on this origin can use it but can't
 * read it out. Don't "fix" this by moving it to the server.
 *
 * The byte formats mirror server/relay/enrolment-crypto.ts exactly; a shared
 * test vector in both test files pins that.
 */

import {
  DEVICE_CERTIFY_ACTION, DEVICE_REVOKE_ACTION, INTENT_VERSION, PASSKEY_ANY, PASSKEY_PROOF_LABEL, certifyPayload, encodePasskeyProofs,
  intentChallengeInput, revokePayload,
} from '../../server/relay/intent-actions'

// --- Encoding ---------------------------------------------------------------

const utf8 = new TextEncoder()

export function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** T(label, ...fields): each field as a 4-byte big-endian length, then its bytes. */
export function transcript(label: string, ...parts: Array<Uint8Array | string>): Uint8Array {
  const encoded = [label, ...parts].map(p => (typeof p === 'string' ? utf8.encode(p) : p))
  const out = new Uint8Array(encoded.reduce((n, p) => n + 4 + p.length, 0))
  const view = new DataView(out.buffer)
  let offset = 0
  for (const p of encoded) {
    view.setUint32(offset, p.length)
    out.set(p, offset + 4)
    offset += 4 + p.length
  }
  return out
}

/** A passkey as the enrolment carries it (credential id, COSE key, RP ID). */
export interface PasskeyKey {
  credentialId: string
  cosePublicKey: string
  rpId: string
}

/** P in the transcripts: UTF-8 JSON of [credentialId, cosePublicKey, rpId] triples. */
function encodePasskeys(passkeys: readonly PasskeyKey[]): string {
  return JSON.stringify(passkeys.map(p => [p.credentialId, p.cosePublicKey, p.rpId]))
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function commitment(spkiB: Uint8Array, label: string, nonceB: Uint8Array, passkeys: readonly PasskeyKey[] = []): Promise<Uint8Array> {
  return sha256(transcript('ck-enrol-commit-v1', spkiB, encodePasskeys(passkeys), label, nonceB))
}

export async function shortAuthString(spkiM: Uint8Array, spkiB: Uint8Array, nonceB: Uint8Array, nonceM: Uint8Array, passkeys: readonly PasskeyKey[] = []): Promise<string> {
  return base32(await sha256(transcript('ck-sas-v1', spkiM, spkiB, encodePasskeys(passkeys), nonceB, nonceM))).slice(0, 8)
}

/** The 6-character code the machine shows once it has approved this browser. */
export async function confirmationCode(spkiM: Uint8Array, spkiB: Uint8Array, nonceB: Uint8Array, nonceM: Uint8Array, passkeys: readonly PasskeyKey[] = []): Promise<string> {
  return base32(await sha256(transcript('ck-enrol-confirm-v1', spkiM, spkiB, encodePasskeys(passkeys), nonceB, nonceM))).slice(0, 6)
}

/** "K7QM2XPA" → "K7QM-2XPA"; "ABC234" → "ABC-234". */
export function formatCode(code: string): string {
  const half = code.length / 2
  return `${code.slice(0, half)}-${code.slice(half)}`
}

/** base64url(SHA-256(SPKI))[0:22], the key id machines and the relay use. */
export async function keyIdForSpki(spki: Uint8Array): Promise<string> {
  return toB64url(await sha256(spki)).slice(0, 22)
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

/** Verify a P1363 ECDSA P-256 signature with a public key given as SPKI. False on anything malformed. */
export async function verifyWith(spki: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', spki as BufferSource, ECDSA, false, ['verify'])
    return await crypto.subtle.verify(SIGN, key, signature as BufferSource, data as BufferSource)
  } catch {
    return false
  }
}

// --- Storage ----------------------------------------------------------------

/** This browser's signing key for one relay user. */
export interface BrowserKey {
  userId: string
  keyPair: CryptoKeyPair
  /** base64url SPKI of the public key. */
  spki: string
  keyId: string
  createdAt: string
}

/** A machine key this browser pinned when the machine confirmed it. */
export interface MachinePin {
  userId: string
  machineId: string
  /** base64url SPKI of the machine identity key. */
  machineKey: string
  /** This browser's key id the machine confirmed. */
  keyId: string
  pinnedAt: string
  /**
   * How the machine key was learned: `code` (the finishing code was typed
   * back, §5.2) or `passkey` (device_certify: taken on first use, not
   * confirmed by the user).
   */
  via?: 'code' | 'passkey'
  /** This user's passkeys the machine trusts, for step-up (§6.6). A hint. */
  passkeys?: Array<{ credentialId: string; keyId: string }>
}

export interface TrustStorage {
  getKey(userId: string): Promise<BrowserKey | undefined>
  putKey(key: BrowserKey): Promise<void>
  getPin(userId: string, machineId: string): Promise<MachinePin | undefined>
  putPin(pin: MachinePin): Promise<void>
  deletePin(userId: string, machineId: string): Promise<void>
  /** Grant revocations not yet confirmed by the machine (§6.7). Optional: storages without it don't persist them. */
  getRevocations?(userId: string, machineId: string): Promise<string[]>
  putRevocations?(userId: string, machineId: string, grantIds: string[]): Promise<void>
  /** The owner's own record of the share grants this browser issued (§6.7, grants.ts). */
  getIssuedGrants?(userId: string, machineId: string): Promise<IssuedGrant[]>
  putIssuedGrants?(userId: string, machineId: string, issued: IssuedGrant[]): Promise<void>
}

/**
 * One share as the owner's browser knows it: what the owner chose, the grant
 * it currently stands behind, and every id it ever issued. This, not the
 * relay's listing, is what renewal and revocation work from.
 */
export interface IssuedGrant {
  shareId: string
  role: 'viewer' | 'editor'
  /** The share's end as the owner chose it (ms), or null. */
  notAfter: number | null
  /** The grant text currently signed for this share, or null before the first. */
  current: { grantId: string; grant: string } | null
  /** Every grant id signed for this share. */
  issuedIds: string[]
  /** The owner revoked the share: never renew or re-sign it. Kept for good. */
  revoked: boolean
}

/** Fired on window whenever a machine pin is saved or removed (signers reload their key). */
export const DEVICE_TRUST_CHANGED = 'codekin:device-trust-changed'

function trustChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEVICE_TRUST_CHANGED))
}

const DB_NAME = 'codekin-device-trust'
const KEYS = 'keys'
const PINS = 'pins'
const REVOCATIONS = 'revocations'
const ISSUED = 'issued'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

/** IndexedDB, under this relay's origin. CryptoKey objects are stored as they are. */
export function indexedDbTrustStorage(): TrustStorage {
  let db: Promise<IDBDatabase> | null = null
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3)
      req.onupgradeneeded = event => {
        if (event.oldVersion < 1) {
          req.result.createObjectStore(KEYS, { keyPath: 'userId' })
          req.result.createObjectStore(PINS, { keyPath: ['userId', 'machineId'] })
        }
        if (event.oldVersion < 2) req.result.createObjectStore(REVOCATIONS, { keyPath: ['userId', 'machineId'] })
        if (event.oldVersion < 3) req.result.createObjectStore(ISSUED, { keyPath: ['userId', 'machineId'] })
      }
      req.onsuccess = () => { resolve(req.result) }
      req.onerror = () => { db = null; reject(req.error ?? new Error('IndexedDB unavailable')) }
    })
    return db
  }
  const store = async (name: string, mode: IDBTransactionMode) => (await open()).transaction(name, mode).objectStore(name)
  return {
    getKey: async userId => request((await store(KEYS, 'readonly')).get(userId) as IDBRequest<BrowserKey | undefined>),
    putKey: async key => { await request((await store(KEYS, 'readwrite')).put(key)) },
    getPin: async (userId, machineId) => request((await store(PINS, 'readonly')).get([userId, machineId]) as IDBRequest<MachinePin | undefined>),
    putPin: async pin => { await request((await store(PINS, 'readwrite')).put(pin)); trustChanged() },
    deletePin: async (userId, machineId) => { await request((await store(PINS, 'readwrite')).delete([userId, machineId])); trustChanged() },
    getRevocations: async (userId, machineId) => {
      const row = await request((await store(REVOCATIONS, 'readonly')).get([userId, machineId]) as IDBRequest<{ grantIds?: string[] } | undefined>)
      return row?.grantIds ?? []
    },
    putRevocations: async (userId, machineId, grantIds) => {
      await request((await store(REVOCATIONS, 'readwrite')).put({ userId, machineId, grantIds }))
    },
    getIssuedGrants: async (userId, machineId) => {
      const row = await request((await store(ISSUED, 'readonly')).get([userId, machineId]) as IDBRequest<{ issued?: IssuedGrant[] } | undefined>)
      return row?.issued ?? []
    },
    putIssuedGrants: async (userId, machineId, issued) => {
      await request((await store(ISSUED, 'readwrite')).put({ userId, machineId, issued }))
    },
  }
}

let defaultStorage: TrustStorage | null = null
export function trustStorage(): TrustStorage {
  defaultStorage ??= indexedDbTrustStorage()
  return defaultStorage
}

/** Whether this browser can hold a signing key at all. */
export function deviceTrustSupported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle
}

/** This browser's key for `userId`, made on first use. One per browser profile per user (§4.2). */
export async function getOrCreateBrowserKey(userId: string, storage: TrustStorage = trustStorage()): Promise<BrowserKey> {
  const existing = await storage.getKey(userId)
  if (existing) return existing
  const keyPair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const key: BrowserKey = { userId, keyPair, spki: toB64url(spki), keyId: await keyIdForSpki(spki), createdAt: new Date().toISOString() }
  await storage.putKey(key)
  return key
}

export async function machinePin(userId: string, machineId: string, storage: TrustStorage = trustStorage()): Promise<MachinePin | undefined> {
  return storage.getPin(userId, machineId)
}

/** "Safari · iPhone"-style name for this browser; machines show it in their device list. */
export function defaultBrowserLabel(ua: string = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
          : 'Browser'
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : 'computer'
  return `${browser} · ${device}`
}

let cachedUserId: Promise<string | null> | null = null
/** The signed-in relay user's id, from /api/me. */
export function currentUserId(): Promise<string | null> {
  cachedUserId ??= fetch('/api/me', { credentials: 'include' })
    .then(res => (res.ok ? res.json() as Promise<{ user?: { id?: unknown } | null }> : { user: null }))
    .then(body => (typeof body.user?.id === 'string' ? body.user.id : null))
    .catch(() => null)
    .then(id => { if (id === null) cachedUserId = null; return id })
  return cachedUserId
}

// --- The ceremony ------------------------------------------------------------

/** Sends one enrol frame to the machine and resolves with its reply payload. */
export type EnrolSend = (kind: 'enrol_commit' | 'enrol_reveal' | 'enrol_status' | 'enrol_certify' | 'enrol_revoke', payload: unknown) => Promise<unknown>

/** A passkey assertion over `challenge`, from one of `credentialIds` (src/hosted/passkeys.ts assertWithPasskey). */
export type AssertPasskey = (challenge: Uint8Array, credentialIds: string[]) => Promise<{
  credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string
}>

export type EnrolOutcome = 'approved' | 'rejected' | 'expired'

export class EnrolmentFailure extends Error {
  readonly code: 'machine_key_changed' | 'bad_machine_signature' | 'protocol'
  constructor(code: EnrolmentFailure['code'], message: string) {
    super(message)
    this.name = 'EnrolmentFailure'
    this.code = code
  }
}

export interface Enrolment {
  enrolId: string
  /** "K7QM-2XPA": the owner types this on the machine. */
  code: string
  /** The machine identity key id, to show next to the code. */
  machineKeyId: string
  /**
   * Ask the machine once whether the code was typed. Null while it is still
   * waiting. 'approved' is news, not proof: a relay could forge it on a first
   * enrolment, so it never pins anything. `confirm` does.
   */
  check: () => Promise<EnrolOutcome | null>
  /**
   * The owner typed the code the machine showed after approving. Pins the
   * machine key when it matches; false when it doesn't.
   */
  confirm: (typed: string) => Promise<boolean>
}

/** What a person typed, as a 6-character code; null unless it could be one. */
export function normalizeConfirmCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-7]{6}$/.test(code) ? code : null
}

interface Challenge { enrolId: string; machineKey: string; nonceM: string; signature: string }
interface Result {
  enrolId: string
  state: 'awaiting_code' | EnrolOutcome
  keyId?: string
  signature?: string
  machineKey?: string
  passkeys?: Array<{ credentialId: string; keyId: string }>
}

function isChallenge(v: unknown): v is Challenge {
  const c = v as Partial<Challenge> | null
  return !!c && typeof c.enrolId === 'string' && typeof c.machineKey === 'string' && typeof c.nonceM === 'string' && typeof c.signature === 'string'
}

/**
 * Start confirming this browser on `machineId`: commit to the key, check the
 * machine signed the challenge, reveal, and compute the code. The returned
 * `check()` polls for the decision and pins the machine key on approval.
 */
export async function startEnrolment(
  send: EnrolSend,
  opts: {
    userId: string
    machineId: string
    label?: string
    storage?: TrustStorage
    /** Also enrol one of these passkeys: the user picks it, and it proves itself (§5.2 as built). */
    passkeys?: { candidates: PasskeyKey[]; assert: AssertPasskey }
  },
): Promise<Enrolment> {
  const storage = opts.storage ?? trustStorage()
  const key = await getOrCreateBrowserKey(opts.userId, storage)
  const spkiB = fromB64url(key.spki)
  const label = (opts.label ?? defaultBrowserLabel()).slice(0, 64).trim()
  const nonceB = crypto.getRandomValues(new Uint8Array(32))

  // A passkey's public key comes from the relay, so the passkey proves
  // itself first: an assertion bound to this browser key and nonce.
  let passkeys: PasskeyKey[] = []
  let passkeyProofs: Array<{ credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }> = []
  if (opts.passkeys && opts.passkeys.candidates.length > 0) {
    const proofChallenge = await sha256(transcript(PASSKEY_PROOF_LABEL, spkiB, nonceB))
    try {
      const proof = await opts.passkeys.assert(proofChallenge, opts.passkeys.candidates.map(c => c.credentialId))
      const chosen = opts.passkeys.candidates.find(c => c.credentialId === proof.credentialId)
      if (chosen) {
        passkeys = [chosen]
        passkeyProofs = [proof]
      }
    } catch {
      // Cancelled or unavailable: confirm the browser alone.
    }
  }
  const commit = await commitment(spkiB, label, nonceB, passkeys)

  const challenge = await send('enrol_commit', { commit: toB64url(commit) })
  if (!isChallenge(challenge)) throw new EnrolmentFailure('protocol', 'The computer sent an unexpected reply')
  const spkiM = fromB64url(challenge.machineKey)
  const nonceM = fromB64url(challenge.nonceM)

  // A key confirmed earlier for this machine must not change behind our
  // back. One taken on first use (device_certify) may be replaced by a
  // key the user now confirms with the codes.
  const pinned = await storage.getPin(opts.userId, opts.machineId)
  if (pinned && pinned.via !== 'passkey' && pinned.machineKey !== challenge.machineKey) {
    throw new EnrolmentFailure('machine_key_changed',
      "This computer's identity key is not the one this browser confirmed before. If Codekin was reinstalled there, forget the old key and try again; otherwise, don't continue.")
  }
  if (!await verifyWith(spkiM, transcript('ck-enrol-challenge-v1', challenge.enrolId, commit, nonceM), fromB64url(challenge.signature))) {
    throw new EnrolmentFailure('bad_machine_signature', "The computer's answer was not signed by its key")
  }

  // The proof of possession also covers the passkey proofs, so they can't be swapped on the way.
  const pop = new Uint8Array(await crypto.subtle.sign(SIGN, key.keyPair.privateKey,
    transcript('ck-enrol-pop-v1', challenge.enrolId, nonceM, encodePasskeyProofs(passkeyProofs)) as BufferSource))
  await send('enrol_reveal', {
    enrolId: challenge.enrolId, spki: key.spki, passkeys, passkeyProofs, label, nonceB: toB64url(nonceB), pop: toB64url(pop),
  })
  const sas = await shortAuthString(spkiM, spkiB, nonceB, nonceM, passkeys)
  let passkeyHint: Result['passkeys']

  const check = async (): Promise<EnrolOutcome | null> => {
    const result = await send('enrol_status', { enrolId: challenge.enrolId }) as Result
    if (result.state === 'awaiting_code') return null
    if (result.state === 'expired') return 'expired'
    // Approvals and refusals count only when the machine key signed them.
    const signed = typeof result.signature === 'string' && await verifyWith(
      spkiM, transcript('ck-enrol-result-v1', challenge.enrolId, spkiB, result.state), fromB64url(result.signature))
    if (!signed) throw new EnrolmentFailure('bad_machine_signature', "The computer's answer was not signed by its key")
    if (Array.isArray(result.passkeys)) passkeyHint = result.passkeys
    return result.state
  }

  // The machine shows this only after the owner typed `sas` there and it
  // added this key. If a relay had answered with its own key, the machine
  // would have refused the code and shown nothing to type here.
  const expected = await confirmationCode(spkiM, spkiB, nonceB, nonceM, passkeys)
  const confirm = async (typed: string): Promise<boolean> => {
    const code = normalizeConfirmCode(typed)
    if (code === null || code.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < code.length; i++) diff |= code.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff !== 0) return false
    await storage.putPin({
      userId: opts.userId, machineId: opts.machineId, machineKey: challenge.machineKey, keyId: key.keyId, pinnedAt: new Date().toISOString(),
      via: 'code',
      // The passkey enrolled just now, or whatever the machine said it trusts.
      passkeys: passkeyHint ?? await Promise.all(passkeys.map(async p => ({ credentialId: p.credentialId, keyId: await keyIdForCose(p.cosePublicKey) }))),
    })
    return true
  }

  return { enrolId: challenge.enrolId, code: formatCode(sas), machineKeyId: await keyIdForSpki(spkiM), check, confirm }
}

/**
 * device_revoke (§5.6): ask a machine to drop this browser's key, with an
 * intent the signer makes (passkey-signed when the machine wants step-up),
 * then forget the machine's pin here.
 */
export async function removeFromMachine(
  send: EnrolSend,
  sign: (intent: { action: string; sessionId: null; payload: Uint8Array; stepUp: true }) => Promise<unknown>,
  opts: { userId: string; machineId: string; storage?: TrustStorage },
): Promise<void> {
  const storage = opts.storage ?? trustStorage()
  const key = await storage.getKey(opts.userId)
  if (!key) return
  const intent = await sign({ action: DEVICE_REVOKE_ACTION, sessionId: null, payload: revokePayload(key.keyId), stepUp: true })
  if (!intent) throw new EnrolmentFailure('protocol', 'This browser is not confirmed on that computer')
  await send('enrol_revoke', { keyId: key.keyId, intent })
  await storage.deletePin(opts.userId, opts.machineId)
}

/** A passkey's key id: base64url(SHA-256(COSE_Key))[0:22], as machines compute it. */
export async function keyIdForCose(cosePublicKey: string): Promise<string> {
  return toB64url(await sha256(fromB64url(cosePublicKey))).slice(0, 22)
}

/**
 * device_certify (§5.4): add this browser to a machine with a passkey the
 * machine already trusts, without a code. The machine key is then taken on
 * first use (`via: 'passkey'`): nothing the user saw confirmed it, which is
 * fine for signed intents but not proof enough for end-to-end encryption.
 */
export async function certifyWithPasskey(
  send: EnrolSend,
  opts: { userId: string; machineId: string; candidates: PasskeyKey[]; assert: AssertPasskey; label?: string; storage?: TrustStorage },
): Promise<void> {
  const storage = opts.storage ?? trustStorage()
  const key = await getOrCreateBrowserKey(opts.userId, storage)
  const label = (opts.label ?? defaultBrowserLabel()).slice(0, 64).trim()
  const nonce = toB64url(crypto.getRandomValues(new Uint8Array(16)))
  const body = JSON.stringify({
    v: INTENT_VERSION, machineId: opts.machineId, sessionId: null, action: DEVICE_CERTIFY_ACTION,
    payloadHash: toB64url(await sha256(certifyPayload(key.spki, label))), nonce, ts: Date.now(), keyId: PASSKEY_ANY,
  })
  const assertion = await opts.assert(await sha256(intentChallengeInput(body)), opts.candidates.map(c => c.credentialId))
  const result = await send('enrol_certify', { spki: key.spki, label, intent: { body, webauthn: assertion } }) as Result
  if (result.state !== 'approved' || typeof result.machineKey !== 'string' || typeof result.signature !== 'string') {
    throw new EnrolmentFailure('protocol', 'The computer did not add this browser')
  }
  const pinned = await storage.getPin(opts.userId, opts.machineId)
  if (pinned && pinned.via !== 'passkey' && pinned.machineKey !== result.machineKey) {
    throw new EnrolmentFailure('machine_key_changed', "This computer's identity key is not the one this browser confirmed before.")
  }
  const signed = await verifyWith(fromB64url(result.machineKey),
    transcript('ck-enrol-result-v1', `certify:${nonce}`, fromB64url(key.spki), 'approved'), fromB64url(result.signature))
  if (!signed) throw new EnrolmentFailure('bad_machine_signature', "The computer's answer was not signed by its key")
  await storage.putPin({
    userId: opts.userId, machineId: opts.machineId, machineKey: result.machineKey, keyId: key.keyId, pinnedAt: new Date().toISOString(),
    // A code-confirmed key stays code-confirmed; anything else was taken on first use.
    via: pinned?.via === 'code' && pinned.machineKey === result.machineKey ? 'code' : 'passkey',
    // An unsigned hint: add it to what is known, never replace it.
    passkeys: [
      ...(Array.isArray(result.passkeys) ? result.passkeys : []),
      ...(pinned?.passkeys ?? []).filter(k => !(result.passkeys ?? []).some(p => p.credentialId === k.credentialId)),
    ].slice(0, 10),
  })
}
