/**
 * The relay's registry of browser signing keys (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md
 * §4.2): `device_keys (user_id, key_id, spki, label, created_at, last_seen_at, revoked_at)`.
 *
 * It feeds the account's device list and will supply grantee key sets for
 * signed share grants (§6.7). It is never trusted: each machine decides from
 * its own device list, which only local confirmation can change. A key lands
 * here when a machine accepts its enrolment reveal.
 */

import type Database from 'better-sqlite3'
import { keyIdForSpki, parseP256Spki } from './machine-identity.js'

export interface DeviceKeyRow {
  keyId: string
  spki: string
  label: string
  createdAt: string
  lastSeenAt: string | null
}

/** Most active keys one user may have registered (a grant names at most 20). */
export const MAX_DEVICE_KEYS = 20

/** Record (or refresh) a key the user enrolled. Returns its key id, or null for an invalid key or a full registry. */
export function upsertDeviceKey(db: Database.Database, userId: string, spkiRaw: unknown, label: string): string | null {
  const spki = parseP256Spki(spkiRaw)
  if (!spki) return null
  const keyId = keyIdForSpki(spki)
  const known = db.prepare('SELECT 1 FROM device_keys WHERE user_id = ? AND key_id = ? AND revoked_at IS NULL').get(userId, keyId)
  const active = (db.prepare('SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId) as { n: number }).n
  if (!known && active >= MAX_DEVICE_KEYS) return null
  db.prepare(
    `INSERT INTO device_keys (user_id, key_id, spki, label, last_seen_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, key_id) DO UPDATE SET label = excluded.label, last_seen_at = datetime('now'), revoked_at = NULL`,
  ).run(userId, keyId, spki, label.slice(0, 64))
  return keyId
}

export function listDeviceKeys(db: Database.Database, userId: string): DeviceKeyRow[] {
  return (db.prepare(
    `SELECT key_id, spki, label, created_at, last_seen_at FROM device_keys
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).all(userId) as Array<{ key_id: string; spki: string; label: string; created_at: string; last_seen_at: string | null }>)
    .map(r => ({ keyId: r.key_id, spki: r.spki, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at }))
}
