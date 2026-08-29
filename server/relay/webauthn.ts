/**
 * WebAuthn passkey credential store (docs/DEVICE-LINK-AND-PASSKEY-SPEC.md §5).
 *
 * Holds only public keys: a stolen database cannot produce an assertion.
 * The WebAuthn ceremonies themselves (challenges, signatures, origin checks)
 * are handled by @simplewebauthn/server in webauthn-routes.ts; this module is
 * the persistence beneath them.
 */

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

export interface WebauthnCredentialRow {
  id: string
  user_id: string
  credential_id: string
  public_key: string
  counter: number
  transports: string | null
  label: string | null
  created_at: string
  last_used_at: string | null
}

/** What the management UI sees — no key material. */
export interface PasskeySummary {
  id: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

function toSummary(row: WebauthnCredentialRow): PasskeySummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export function listPasskeys(db: Database.Database, userId: string): PasskeySummary[] {
  const rows = db
    .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at')
    .all(userId) as WebauthnCredentialRow[]
  return rows.map(toSummary)
}

/** All of a user's credentials, for excludeCredentials at registration. */
export function listCredentialRows(db: Database.Database, userId: string): WebauthnCredentialRow[] {
  return db
    .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ?')
    .all(userId) as WebauthnCredentialRow[]
}

export function getCredentialByCredentialId(
  db: Database.Database,
  credentialId: string,
): WebauthnCredentialRow | undefined {
  return db
    .prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
    .get(credentialId) as WebauthnCredentialRow | undefined
}

export interface InsertCredentialInput {
  userId: string
  /** base64url credential id, as produced by the authenticator. */
  credentialId: string
  /** base64url COSE public key. */
  publicKey: string
  counter: number
  transports?: string[]
  label?: string | null
}

export function insertCredential(
  db: Database.Database,
  input: InsertCredentialInput,
): PasskeySummary {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.credentialId,
    input.publicKey,
    input.counter,
    input.transports && input.transports.length > 0 ? JSON.stringify(input.transports) : null,
    input.label?.trim() || null,
  )
  const row = db
    .prepare('SELECT * FROM webauthn_credentials WHERE id = ?')
    .get(id) as WebauthnCredentialRow
  return toSummary(row)
}

/** Persist the post-assertion signature counter and mark the credential used. */
export function recordCredentialUse(db: Database.Database, id: string, newCounter: number): void {
  db.prepare(
    `UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?`,
  ).run(newCounter, id)
}

/** Delete a user's own passkey. False when it doesn't exist or isn't theirs. */
export function deletePasskey(db: Database.Database, userId: string, passkeyId: string): boolean {
  const result = db
    .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
    .run(passkeyId, userId)
  return result.changes > 0
}

/** Stored transports, parsed back for allow/exclude credential lists. */
export function parseTransports(row: WebauthnCredentialRow): string[] | undefined {
  if (!row.transports) return undefined
  try {
    const parsed = JSON.parse(row.transports) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : undefined
  } catch {
    return undefined
  }
}
