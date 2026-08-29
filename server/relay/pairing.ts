/**
 * Device-code machine pairing (spec §6.2).
 *
 * Flow: the CLI calls pair/start and receives a short user code (shown to
 * the human) plus a long device code (kept by the CLI). The user approves
 * the user code in the hosted UI; the CLI polls pair/complete with the
 * device code. The machine credential is generated at claim time and
 * returned exactly once — only its SHA-256 hash is stored.
 */

import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'
import { DEFAULT_ORG_ID } from './control-plane-db.js'

/** Pairing requests expire after 10 minutes. */
const PAIRING_TTL_MS = 10 * 60 * 1000

/** Unambiguous alphabet for user-facing codes (no 0/O/1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'claimed' | 'expired'

export interface PairingRequestRow {
  code: string
  device_code_hash: string
  hostname: string | null
  platform: string | null
  status: PairingStatus
  approved_by_user_id: string | null
  machine_id: string | null
  created_at: string
  expires_at: number
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time comparison of a secret against a stored SHA-256 hex hash. */
export function secretMatchesHash(secret: string, storedHashHex: string): boolean {
  const a = createHash('sha256').update(secret).digest()
  const b = Buffer.from(storedHashHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function generateUserCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    if (i === 3) out += '-'
  }
  return out
}

function getRequest(db: Database.Database, userCode: string): PairingRequestRow | undefined {
  return db
    .prepare('SELECT * FROM pairing_requests WHERE code = ?')
    .get(userCode.toUpperCase()) as PairingRequestRow | undefined
}

function isExpired(row: PairingRequestRow): boolean {
  return row.expires_at <= Date.now()
}

export interface StartPairingResult {
  userCode: string
  deviceCode: string
  expiresAt: number
}

export function startPairing(
  db: Database.Database,
  info: { hostname?: string; platform?: string },
): StartPairingResult {
  const deviceCode = randomBytes(32).toString('base64url')
  // Retry on the (astronomically unlikely) user-code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode()
    const expiresAt = Date.now() + PAIRING_TTL_MS
    try {
      db.prepare(
        `INSERT INTO pairing_requests (code, device_code_hash, hostname, platform, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userCode, sha256Hex(deviceCode), info.hostname ?? null, info.platform ?? null, expiresAt)
      return { userCode, deviceCode, expiresAt }
    } catch (err) {
      if (attempt === 4) throw err instanceof Error ? err : new Error(String(err))
    }
  }
  throw new Error('unreachable')
}

export interface PairingInfo {
  userCode: string
  hostname: string | null
  platform: string | null
  status: PairingStatus
  createdAt: string
}

/** Look up a pairing request by user code for the approval UI. */
export function getPairingInfo(db: Database.Database, userCode: string): PairingInfo | null {
  const row = getRequest(db, userCode)
  if (!row) return null
  return {
    userCode: row.code,
    hostname: row.hostname,
    platform: row.platform,
    status: isExpired(row) && row.status === 'pending' ? 'expired' : row.status,
    createdAt: row.created_at,
  }
}

/**
 * Approve a pairing request: creates the machine row owned by the approving
 * user and links it. The credential is not generated here — the device
 * receives it when it claims via completePairing.
 */
export function approvePairing(
  db: Database.Database,
  userCode: string,
  approvedByUserId: string,
  displayName?: string,
): { ok: true; machineId: string } | { ok: false; reason: 'not_found' | 'expired' | 'not_pending' } {
  const row = getRequest(db, userCode)
  if (!row) return { ok: false, reason: 'not_found' }
  if (isExpired(row)) return { ok: false, reason: 'expired' }
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' }

  const machineId = randomUUID()
  const name = displayName?.trim() || row.hostname || 'Unnamed machine'
  db.prepare(
    `INSERT INTO machines (id, organization_id, owner_user_id, display_name, hostname, platform, status)
     VALUES (?, ?, ?, ?, ?, ?, 'offline')`,
  ).run(machineId, DEFAULT_ORG_ID, approvedByUserId, name, row.hostname, row.platform)
  db.prepare(
    `UPDATE pairing_requests SET status = 'approved', approved_by_user_id = ?, machine_id = ? WHERE code = ?`,
  ).run(approvedByUserId, machineId, row.code)
  return { ok: true, machineId }
}

export interface PrecreatePairingResult {
  /** The claim secret embedded in the install command (the device code). */
  pairingToken: string
  userCode: string
  machineId: string
  expiresAt: number
}

/**
 * Browser-first pairing (the install-command funnel): an authenticated user
 * mints a pre-approved pairing in one step, and the installer claims it with
 * the token — no poll, no approval round-trip. Authorization is possession
 * of the token: it was created by a signed-in user seconds earlier, is
 * single-use (claim moves it to 'claimed'), and expires with the normal TTL.
 * Hostname/platform are unknown until claim time; completePairing backfills
 * them onto the machine row.
 */
export function precreatePairing(
  db: Database.Database,
  createdByUserId: string,
  displayName?: string,
): PrecreatePairingResult {
  const started = startPairing(db, {})
  const approved = approvePairing(db, started.userCode, createdByUserId, displayName)
  if (!approved.ok) throw new Error(`precreate approval failed: ${approved.reason}`)
  return {
    pairingToken: started.deviceCode,
    userCode: started.userCode,
    machineId: approved.machineId,
    expiresAt: started.expiresAt,
  }
}

export function denyPairing(
  db: Database.Database,
  userCode: string,
  deniedByUserId: string,
): boolean {
  const row = getRequest(db, userCode)
  if (!row || row.status !== 'pending') return false
  db.prepare(
    `UPDATE pairing_requests SET status = 'denied', approved_by_user_id = ? WHERE code = ?`,
  ).run(deniedByUserId, row.code)
  return true
}

export type CompletePairingResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'not_found' }
  | { status: 'complete'; machineId: string; machineSecret: string }

/**
 * Claim an approved pairing with the device code. Generates the machine
 * credential, stores only its hash, and returns the secret exactly once
 * (the request moves to 'claimed' so a replay cannot mint a second secret).
 */
export function completePairing(
  db: Database.Database,
  deviceCode: string,
  claimInfo?: { hostname?: string; platform?: string },
): CompletePairingResult {
  const row = db
    .prepare('SELECT * FROM pairing_requests WHERE device_code_hash = ?')
    .get(sha256Hex(deviceCode)) as PairingRequestRow | undefined
  if (!row) return { status: 'not_found' }
  if (row.status === 'denied') return { status: 'denied' }
  if (row.status === 'claimed') return { status: 'not_found' }
  if (isExpired(row)) return { status: 'expired' }
  if (row.status === 'pending') return { status: 'pending' }

  // status === 'approved' — mint the credential
  const machineSecret = randomBytes(32).toString('base64url')
  const machineId = row.machine_id
  if (!machineId) return { status: 'not_found' }
  db.prepare(
    'INSERT INTO machine_credentials (id, machine_id, secret_hash) VALUES (?, ?, ?)',
  ).run(randomUUID(), machineId, sha256Hex(machineSecret))
  db.prepare(`UPDATE pairing_requests SET status = 'claimed' WHERE code = ?`).run(row.code)

  // Precreated pairings (install-command funnel) know nothing about the
  // machine until it claims — backfill what the device reports.
  if (row.hostname === null && claimInfo?.hostname) {
    db.prepare(
      `UPDATE machines SET hostname = ?, platform = ?,
        display_name = CASE WHEN display_name = 'Unnamed machine' THEN ? ELSE display_name END
       WHERE id = ?`,
    ).run(claimInfo.hostname, claimInfo.platform ?? null, claimInfo.hostname, machineId)
  }
  return { status: 'complete', machineId, machineSecret }
}

/** Validate a machine credential against the stored (non-revoked) hashes. */
export function verifyMachineCredential(
  db: Database.Database,
  machineId: string,
  secret: string,
): boolean {
  const rows = db
    .prepare('SELECT secret_hash FROM machine_credentials WHERE machine_id = ? AND revoked_at IS NULL')
    .all(machineId) as Array<{ secret_hash: string }>
  return rows.some(r => secretMatchesHash(secret, r.secret_hash))
}

/** Delete a machine and its credentials (a removed machine can never reconnect). */
export function removeMachine(db: Database.Database, machineId: string): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM machine_credentials WHERE machine_id = ?').run(machineId)
    db.prepare('UPDATE pairing_requests SET machine_id = NULL WHERE machine_id = ?').run(machineId)
    const result = db.prepare('DELETE FROM machines WHERE id = ?').run(machineId)
    return result.changes > 0
  })()
}
