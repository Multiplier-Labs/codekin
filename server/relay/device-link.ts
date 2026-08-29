/**
 * Single-use device-link codes (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §4).
 *
 * The inverse of machine pairing: the code is minted by an authenticated
 * browser, rendered there as a QR, and whoever presents it back within the
 * TTL gets a session as the minting user. Possession is the approval — the
 * code originates on an already-authenticated device, so unlike machine
 * pairing there is no human approval step. Single use, short TTL, only the
 * SHA-256 hash at rest.
 */

import { randomBytes, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { sha256Hex } from './pairing.js'

/** Device-link codes expire after 3 minutes: the QR is scanned within seconds. */
export const DEVICE_LINK_TTL_MS = 3 * 60 * 1000

export interface DeviceLinkRequestRow {
  id: string
  code_hash: string
  created_by_user_id: string
  status: 'pending' | 'claimed'
  created_at: string
  expires_at: number
  claimed_at: string | null
  claimed_ip: string | null
  claimed_user_agent: string | null
}

export interface StartDeviceLinkResult {
  requestId: string
  code: string
  expiresAt: number
}

export function startDeviceLink(db: Database.Database, userId: string): StartDeviceLinkResult {
  // Opportunistic sweep: expired pending rows have no further use. Claimed
  // rows are kept — they record where each device link went.
  db.prepare(`DELETE FROM device_link_requests WHERE status = 'pending' AND expires_at <= ?`).run(
    Date.now(),
  )
  const requestId = randomUUID()
  const code = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + DEVICE_LINK_TTL_MS
  db.prepare(
    `INSERT INTO device_link_requests (id, code_hash, created_by_user_id, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(requestId, sha256Hex(code), userId, expiresAt)
  return { requestId, code, expiresAt }
}

export type DeviceLinkStatus = 'pending' | 'claimed' | 'expired'

/** Status for the creator's polling dialog. Null when unknown or not the creator's. */
export function getDeviceLinkStatus(
  db: Database.Database,
  requestId: string,
  userId: string,
): DeviceLinkStatus | null {
  const row = db
    .prepare('SELECT * FROM device_link_requests WHERE id = ?')
    .get(requestId) as DeviceLinkRequestRow | undefined
  if (!row || row.created_by_user_id !== userId) return null
  if (row.status === 'claimed') return 'claimed'
  return row.expires_at <= Date.now() ? 'expired' : 'pending'
}

export type CompleteDeviceLinkResult =
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'complete'; requestId: string; createdByUserId: string }

/**
 * Claim a device-link code. `claimed` is a terminal state written in the same
 * statement that checks for `pending`, so a concurrent replay of the code
 * loses the race and reads as unknown.
 */
export function completeDeviceLink(
  db: Database.Database,
  code: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): CompleteDeviceLinkResult {
  const row = db
    .prepare('SELECT * FROM device_link_requests WHERE code_hash = ?')
    .get(sha256Hex(code)) as DeviceLinkRequestRow | undefined
  if (!row || row.status === 'claimed') return { status: 'not_found' }
  if (row.expires_at <= Date.now()) return { status: 'expired' }

  const result = db
    .prepare(
      `UPDATE device_link_requests
       SET status = 'claimed', claimed_at = datetime('now'), claimed_ip = ?, claimed_user_agent = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(meta.ip ?? null, meta.userAgent ?? null, row.id)
  if (result.changes === 0) return { status: 'not_found' }

  return { status: 'complete', requestId: row.id, createdByUserId: row.created_by_user_id }
}
