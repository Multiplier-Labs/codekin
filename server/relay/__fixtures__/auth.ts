/**
 * Test-only: sign a fixture session in fully, the state a real sign-in
 * reaches after its second factor. The account gets a stub authenticator
 * (never decrypted — no code is checked against it) so the per-request 2FA
 * policy treats owners and admins as enrolled, and the factor counts as just
 * verified so step-up routes pass. Tests of 2FA itself do not use this.
 */

import type Database from 'better-sqlite3'
import type { SessionData } from 'express-session'

export function signInFully(db: Database.Database, session: Partial<SessionData>, userId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO user_totp (user_id, secret_enc, confirmed_at, created_at)
     VALUES (?, 'fixture', datetime('now'), ?)`,
  ).run(userId, Date.now())
  const now = Date.now()
  session.authLevel = 'full'
  session.authenticatedAt = now
  session.mfaVerifiedAt = now
}
