/**
 * GitHub webhook receivers on the relay, one per machine
 * (docs/SELF-HOSTED-RELAY.md, "GitHub webhooks").
 *
 * The URL token only decides *which machine* a delivery is forwarded to, and
 * keeps random traffic from reaching it. It is not what makes a delivery
 * trusted: the machine's local server checks GitHub's HMAC signature with a
 * secret the relay never sees. Only the token's SHA-256 is stored.
 */

import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import { sha256Hex } from './pairing.js'

export interface MachineWebhookRow {
  machine_id: string
  token_hash: string
  created_by_user_id: string
  created_at: string
  last_delivery_at: string | null
}

/** What the owner's UI sees — never the token or its hash. */
export interface MachineWebhookSummary {
  enabled: boolean
  createdAt: string | null
  lastDeliveryAt: string | null
}

/** URL path a webhook token is served under, behind the relay's public origin. */
export const WEBHOOK_INGRESS_PREFIX = '/api/hooks/github/'

export function webhookUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEBHOOK_INGRESS_PREFIX}${token}`
}

export function getMachineWebhook(db: Database.Database, machineId: string): MachineWebhookSummary {
  const row = db.prepare('SELECT * FROM machine_webhooks WHERE machine_id = ?').get(machineId) as
    | MachineWebhookRow
    | undefined
  return {
    enabled: row !== undefined,
    createdAt: row?.created_at ?? null,
    lastDeliveryAt: row?.last_delivery_at ?? null,
  }
}

/**
 * Turn the receiver on, or rotate it: a new token replaces any old one, so
 * the previous URL stops working at once. Returns the token, shown once.
 */
export function enableMachineWebhook(db: Database.Database, machineId: string, userId: string): string {
  const token = randomBytes(24).toString('base64url')
  db.prepare(
    `INSERT INTO machine_webhooks (machine_id, token_hash, created_by_user_id)
     VALUES (?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       created_by_user_id = excluded.created_by_user_id,
       created_at = datetime('now'),
       last_delivery_at = NULL`,
  ).run(machineId, sha256Hex(token), userId)
  return token
}

export function disableMachineWebhook(db: Database.Database, machineId: string): boolean {
  return db.prepare('DELETE FROM machine_webhooks WHERE machine_id = ?').run(machineId).changes > 0
}

/** Machine a token routes to, or undefined. Tokens are 192-bit random, so a hash lookup is enough. */
export function machineForWebhookToken(db: Database.Database, token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined
  const row = db.prepare('SELECT machine_id FROM machine_webhooks WHERE token_hash = ?').get(sha256Hex(token)) as
    | { machine_id: string }
    | undefined
  return row?.machine_id
}

export function touchWebhookDelivery(db: Database.Database, machineId: string): void {
  db.prepare(`UPDATE machine_webhooks SET last_delivery_at = datetime('now') WHERE machine_id = ?`).run(machineId)
}
