/**
 * Two-factor authentication (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 3).
 *
 * GitHub sign-in is the first factor. The second is one of:
 * - an authenticator app (TOTP, RFC 6238: SHA-1, 6 digits, 30 s steps, ±1
 *   step of drift), with the secret encrypted at rest and each time step
 *   accepted at most once;
 * - a passkey (WebAuthn with user verification, already possession plus
 *   biometric/PIN — a passkey sign-in on its own satisfies 2FA);
 * - a single-use recovery code.
 *
 * Who must have one: the platform operator, every owner or admin of a
 * workspace, and every member of a workspace that requires it. Anyone who has
 * enrolled a factor is always challenged for it after GitHub sign-in.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'
import { sha256Hex } from './pairing.js'
import type { UserRow } from './control-plane-db.js'
import type { RelayConfig } from './relay-config.js'

/** A sensitive action needs a second-factor check at most this old. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000
/** A half-signed-in session (second factor or enrollment outstanding) lasts this long. */
export const PARTIAL_SESSION_TTL_MS = 10 * 60 * 1000
/** An authenticator-app enrollment must be confirmed within this window. */
export const TOTP_ENROLLMENT_TTL_MS = 10 * 60 * 1000
export const RECOVERY_CODE_COUNT = 10

const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
const TOTP_DRIFT_STEPS = 1
const ISSUER = 'Codekin'

// ---------------------------------------------------------------------------
// Encryption of TOTP secrets
// ---------------------------------------------------------------------------

/** Ciphertext format version, so the key or algorithm can be rotated later. */
const CIPHER_VERSION = 'v1'

export function encryptSecret(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [CIPHER_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

export function decryptSecret(key: Buffer, stored: string): Buffer {
  const [version, iv, tag, ct] = stored.split(':')
  if (version !== CIPHER_VERSION || !iv || !tag || !ct) throw new Error('Unrecognized TOTP secret format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()])
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238 over RFC 4226)
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

/** The matching time step for a code, or null. Constant-time per candidate. */
export function matchTotp(secret: Buffer, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const current = totpStep(nowMs)
  let matched: number | null = null
  for (let delta = -TOTP_DRIFT_STEPS; delta <= TOTP_DRIFT_STEPS; delta++) {
    const step = current + delta
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) matched = step
  }
  return matched
}

export function otpauthUri(secretBase32: string, accountName: string): string {
  const label = encodeURIComponent(`${ISSUER}:${accountName}`)
  const params = new URLSearchParams({ secret: secretBase32, issuer: ISSUER, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}

interface TotpRow {
  user_id: string
  secret_enc: string
  confirmed_at: string | null
  last_used_step: number | null
  created_at: number
}

function getTotpRow(db: Database.Database, userId: string): TotpRow | undefined {
  return db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as TotpRow | undefined
}

export function hasTotp(db: Database.Database, userId: string): boolean {
  return getTotpRow(db, userId)?.confirmed_at != null
}

export type BeginTotpResult = { ok: true; secret: string; uri: string } | { ok: false; reason: 'already_enabled' }

/** Start (or restart) an enrollment: a fresh secret, unconfirmed. */
export function beginTotpEnrollment(db: Database.Database, key: Buffer, user: Pick<UserRow, 'id' | 'login'>): BeginTotpResult {
  if (hasTotp(db, user.id)) return { ok: false, reason: 'already_enabled' }
  const secret = randomBytes(20)
  db.prepare(
    `INSERT INTO user_totp (user_id, secret_enc, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = excluded.created_at,
       confirmed_at = NULL, last_used_step = NULL`,
  ).run(user.id, encryptSecret(key, secret), Date.now())
  const encoded = base32Encode(secret)
  return { ok: true, secret: encoded, uri: otpauthUri(encoded, user.login) }
}

export type ConfirmTotpResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: 'no_enrollment' | 'invalid_code' }

/**
 * Finish enrollment with a code from the app. Also issues a fresh set of
 * recovery codes (returned once), replacing any earlier set.
 */
export function confirmTotpEnrollment(db: Database.Database, key: Buffer, userId: string, code: string): ConfirmTotpResult {
  const row = getTotpRow(db, userId)
  if (!row || row.confirmed_at !== null || Date.now() - row.created_at > TOTP_ENROLLMENT_TTL_MS) {
    return { ok: false, reason: 'no_enrollment' }
  }
  const step = matchTotp(decryptSecret(key, row.secret_enc), code.trim())
  if (step === null) return { ok: false, reason: 'invalid_code' }
  return db.transaction((): ConfirmTotpResult => {
    db.prepare(`UPDATE user_totp SET confirmed_at = datetime('now'), last_used_step = ? WHERE user_id = ?`).run(step, userId)
    return { ok: true, recoveryCodes: issueRecoveryCodes(db, userId) }
  })()
}

export function disableTotp(db: Database.Database, userId: string): boolean {
  return db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId).changes > 0
}

/**
 * Check a TOTP code and burn its time step in the same statement: a code
 * accepted once cannot be replayed, even within its 30 seconds.
 */
function useTotp(db: Database.Database, key: Buffer, userId: string, code: string): boolean {
  const row = getTotpRow(db, userId)
  if (!row || row.confirmed_at === null) return false
  const step = matchTotp(decryptSecret(key, row.secret_enc), code)
  if (step === null) return false
  return (
    db
      .prepare(
        `UPDATE user_totp SET last_used_step = ?
         WHERE user_id = ? AND confirmed_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step < ?)`,
      )
      .run(step, userId, step).changes > 0
  )
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Crockford-style alphabet: no 0/O or 1/I/L confusion when read off paper. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

function newRecoveryCode(): string {
  const bytes = randomBytes(10)
  const chars = [...bytes].map(b => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('')
  return `${chars.slice(0, 5)}-${chars.slice(5)}`
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Replace the user's recovery codes; returns the new ones (shown once). */
export function issueRecoveryCodes(db: Database.Database, userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  db.transaction(() => {
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId)
    const insert = db.prepare('INSERT INTO user_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)')
    for (const code of codes) insert.run(randomUUID(), userId, sha256Hex(normalizeRecoveryCode(code)))
  })()
  return codes
}

export function recoveryCodesRemaining(db: Database.Database, userId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as {
      n: number
    }
  ).n
}

/** Consume one recovery code; the conditional UPDATE makes each usable once. */
function useRecoveryCode(db: Database.Database, userId: string, code: string): boolean {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length !== 10) return false
  return (
    db
      .prepare(
        `UPDATE user_recovery_codes SET used_at = datetime('now')
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
      )
      .run(userId, sha256Hex(normalized)).changes > 0
  )
}

export function deleteRecoveryCodes(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId)
}

/**
 * Verify a typed second factor: a 6-digit TOTP code, else a recovery code.
 * Returns which one matched (each consumed), or null.
 */
export function verifyTypedFactor(
  db: Database.Database,
  key: Buffer | undefined,
  userId: string,
  code: string,
): 'totp' | 'recovery' | null {
  const trimmed = code.trim()
  if (/^\d{6}$/.test(trimmed)) return key && useTotp(db, key, userId, trimmed) ? 'totp' : null
  return useRecoveryCode(db, userId, trimmed) ? 'recovery' : null
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function passkeyCount(db: Database.Database, userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId) as { n: number }).n
}

/** Enrolled in a second factor that can be challenged (TOTP or a passkey). */
export function hasSecondFactor(db: Database.Database, userId: string): boolean {
  return hasTotp(db, userId) || passkeyCount(db, userId) > 0
}

/** Must this account use 2FA? Operator, any owner/admin role, or a workspace that requires it. */
export function isMfaRequired(
  db: Database.Database,
  user: Pick<UserRow, 'id' | 'github_id'>,
  config: Pick<RelayConfig, 'ownerGithubId'>,
): boolean {
  if (config.ownerGithubId > 0 && user.github_id === config.ownerGithubId) return true
  const row = db
    .prepare(
      `SELECT 1 FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.status = 'active' AND w.deleted_at IS NULL
         AND (m.role IN ('owner', 'admin') OR w.require_mfa = 1)
       LIMIT 1`,
    )
    .get(user.id)
  return row !== undefined
}

export interface MfaStatus {
  totp: boolean
  passkeys: number
  recoveryCodesRemaining: number
  required: boolean
  /** Whether authenticator-app enrollment is available on this relay. */
  totpAvailable: boolean
}

export function mfaStatus(
  db: Database.Database,
  user: Pick<UserRow, 'id' | 'github_id'>,
  config: Pick<RelayConfig, 'ownerGithubId' | 'mfaEncryptionKey'>,
): MfaStatus {
  return {
    totp: hasTotp(db, user.id),
    passkeys: passkeyCount(db, user.id),
    recoveryCodesRemaining: recoveryCodesRemaining(db, user.id),
    required: isMfaRequired(db, user, config),
    totpAvailable: config.mfaEncryptionKey !== undefined,
  }
}

/**
 * - `full`: signed in; everything the account's roles allow.
 * - `mfa_pending`: GitHub sign-in done, second factor outstanding.
 * - `enrollment_required`: 2FA is required but none is set up yet.
 */
export type AuthLevel = 'full' | 'mfa_pending' | 'enrollment_required'

/** Where a sign-in by `method` leaves the session. */
export function authLevelAfterSignIn(
  db: Database.Database,
  user: Pick<UserRow, 'id' | 'github_id'>,
  config: Pick<RelayConfig, 'ownerGithubId'>,
  method: 'github' | 'passkey' | 'device_link',
): AuthLevel {
  // A passkey sign-in is itself two factors; a device link is minted only
  // from a fully signed-in (and, where enrolled, freshly verified) session.
  if (method !== 'github') return 'full'
  if (hasSecondFactor(db, user.id)) return 'mfa_pending'
  return isMfaRequired(db, user, config) ? 'enrollment_required' : 'full'
}

// ---------------------------------------------------------------------------
// Attempt limiting
// ---------------------------------------------------------------------------

/**
 * Failed second-factor attempts per account: MAX_FAILURES in WINDOW_MS, then
 * refused until the window passes. In memory — the relay is one process.
 */
export class FailedAttemptLimiter {
  static readonly MAX_FAILURES = 5
  static readonly WINDOW_MS = 15 * 60 * 1000
  private failures = new Map<string, number[]>()

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter(t => now - t < FailedAttemptLimiter.WINDOW_MS)
    if (kept.length > 0) this.failures.set(key, kept)
    else this.failures.delete(key)
    return kept
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= FailedAttemptLimiter.MAX_FAILURES
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now])
  }

  reset(key: string): void {
    this.failures.delete(key)
  }
}
