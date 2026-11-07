/**
 * Desktop-app sign-in handoff (docs/DESKTOP-APP-TAURI-PLAN.md, D9).
 *
 * The app opens `start` in the system browser with a `state` and a PKCE
 * `code_challenge`. Once the browser is fully signed in, the user approves the
 * request, which mints a one-time code bound to the user and the challenge;
 * the browser hands it to the app through `codekin://auth`. The app's webview
 * redeems it with the verifier, which never left the app, so a different app
 * that registered `codekin://` and caught the code still can't use it.
 *
 * Only hashes of codes are stored. Every transition (approve, claim) is one
 * conditional UPDATE, so a replay or a concurrent second claim loses the race.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type Database from 'better-sqlite3'
import { sha256Hex } from './pairing.js'

/** Time to finish signing in (GitHub, second factor) in the browser. */
export const DESKTOP_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000
/** The one-time code only has to travel browser → app → webview. */
export const DESKTOP_AUTH_CODE_TTL_MS = 60 * 1000

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/
/** base64url(SHA-256) without padding is always 43 characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 §4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/
const REQUEST_ID_RE = /^[0-9a-f-]{36}$/

interface DesktopAuthRow {
  id: string
  state: string
  code_challenge: string
  status: 'pending' | 'approved' | 'claimed' | 'failed'
  expires_at: number
  user_id: string | null
  code_expires_at: number | null
  mfa_verified_at: number | null
}

export function isValidRequestId(id: unknown): id is string {
  return typeof id === 'string' && REQUEST_ID_RE.test(id)
}

export type StartDesktopAuthResult = { ok: true; requestId: string } | { ok: false }

export function startDesktopAuth(
  db: Database.Database,
  params: { state: unknown; codeChallenge: unknown; method: unknown },
): StartDesktopAuthResult {
  const { state, codeChallenge, method } = params
  if (typeof state !== 'string' || !STATE_RE.test(state)) return { ok: false }
  if (typeof codeChallenge !== 'string' || !CHALLENGE_RE.test(codeChallenge)) return { ok: false }
  // `plain` would put the verifier itself in the browser's URL bar.
  if (method !== undefined && method !== 'S256') return { ok: false }

  const now = Date.now()
  // Unapproved requests expire unused; approved-but-unclaimed codes too.
  // Claimed rows stay as the record of where each desktop sign-in went.
  db.prepare(
    `DELETE FROM desktop_auth_requests
     WHERE (status = 'pending' AND expires_at <= ?) OR (status = 'approved' AND code_expires_at <= ?)`,
  ).run(now, now)
  const requestId = randomUUID()
  db.prepare(
    `INSERT INTO desktop_auth_requests (id, state, code_challenge, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(requestId, state, codeChallenge, now + DESKTOP_AUTH_REQUEST_TTL_MS)
  return { ok: true, requestId }
}

export type DesktopAuthStatus = 'pending' | 'used' | 'expired'

/** What the approval page shows. Never exposes the state or challenge. */
export function getDesktopAuthStatus(db: Database.Database, requestId: string): DesktopAuthStatus | null {
  const row = db.prepare('SELECT * FROM desktop_auth_requests WHERE id = ?').get(requestId) as DesktopAuthRow | undefined
  if (!row) return null
  if (row.status !== 'pending') return 'used'
  return row.expires_at <= Date.now() ? 'expired' : 'pending'
}

export type ApproveDesktopAuthResult =
  | { status: 'approved'; code: string; state: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'used' }

export function approveDesktopAuth(
  db: Database.Database,
  requestId: string,
  userId: string,
  meta: { mfaVerifiedAt?: number | null; ip?: string | null } = {},
): ApproveDesktopAuthResult {
  const row = db.prepare('SELECT * FROM desktop_auth_requests WHERE id = ?').get(requestId) as DesktopAuthRow | undefined
  if (!row) return { status: 'not_found' }
  if (row.status !== 'pending') return { status: 'used' }
  const now = Date.now()
  if (row.expires_at <= now) return { status: 'expired' }

  const code = randomBytes(32).toString('base64url')
  const result = db
    .prepare(
      `UPDATE desktop_auth_requests
       SET status = 'approved', user_id = ?, code_hash = ?, code_expires_at = ?, mfa_verified_at = ?, approved_ip = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(userId, sha256Hex(code), now + DESKTOP_AUTH_CODE_TTL_MS, meta.mfaVerifiedAt ?? null, meta.ip ?? null, requestId)
  if (result.changes === 0) return { status: 'used' }
  return { status: 'approved', code, state: row.state }
}

export type ClaimDesktopAuthResult =
  | { status: 'complete'; requestId: string; userId: string; mfaVerifiedAt: number | null }
  | { status: 'invalid' }
  | { status: 'expired' }

function challengeMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

/**
 * Redeem a code with its PKCE verifier. A wrong verifier burns the code: the
 * legitimate app can start again, and a code holder gets exactly one guess.
 */
export function claimDesktopAuth(
  db: Database.Database,
  code: unknown,
  verifier: unknown,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): ClaimDesktopAuthResult {
  if (typeof code !== 'string' || !code || code.length > 128) return { status: 'invalid' }
  const row = db
    .prepare(`SELECT * FROM desktop_auth_requests WHERE code_hash = ? AND status = 'approved'`)
    .get(sha256Hex(code)) as DesktopAuthRow | undefined
  if (!row || !row.user_id) return { status: 'invalid' }

  const ok = typeof verifier === 'string' && VERIFIER_RE.test(verifier) && challengeMatches(verifier, row.code_challenge)
  const expired = (row.code_expires_at ?? 0) <= Date.now()
  const result = db
    .prepare(
      `UPDATE desktop_auth_requests
       SET status = ?, claimed_at = datetime('now'), claimed_ip = ?, claimed_user_agent = ?
       WHERE id = ? AND status = 'approved'`,
    )
    .run(ok && !expired ? 'claimed' : 'failed', meta.ip ?? null, meta.userAgent?.slice(0, 512) ?? null, row.id)
  if (result.changes === 0) return { status: 'invalid' }
  if (!ok) return { status: 'invalid' }
  if (expired) return { status: 'expired' }
  return { status: 'complete', requestId: row.id, userId: row.user_id, mfaVerifiedAt: row.mfa_verified_at }
}

/**
 * Drop a user's approved-but-unclaimed codes (logout-all). A code minted
 * before "sign out everywhere" must not mint a session after it.
 */
export function revokePendingDesktopAuth(db: Database.Database, userId: string): number {
  return db
    .prepare(`DELETE FROM desktop_auth_requests WHERE user_id = ? AND status = 'approved'`)
    .run(userId).changes
}

/** Opaque, stable handle for a stored session, safe to show the user (the sid itself is a bearer secret). */
export function sessionHandle(sid: string): string {
  return createHash('sha256').update(`desktop-session:${sid}`).digest('hex').slice(0, 32)
}
