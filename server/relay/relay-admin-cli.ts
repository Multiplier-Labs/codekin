/**
 * Operator commands for the hosted relay, run on the relay host against its
 * control-plane database (same config as the server: ~/.codekin-relay/env).
 *
 *   node dist/relay/relay-admin-cli.js reset-mfa <github-id>
 *   node dist/relay/relay-admin-cli.js mint-session <github-id> [--hours N]   (staging only)
 *
 * mint-session signs a test account in without GitHub, for automated suites
 * against a staging relay (docs/RELAY-HARDENING.md §7). It writes a session
 * row and prints the cookie. There is deliberately no HTTP route for this:
 * a test-login endpoint shipped in the same binary is one misconfiguration
 * away from a production backdoor, while this needs a shell on the host,
 * the same trust as the database file itself. It refuses unless the relay's
 * config says RELAY_STAGING=1.
 *
 * reset-mfa is the recovery path for an account that has lost every second
 * factor (authenticator, passkeys and recovery codes). Workspace admins
 * cannot do this — an account spans workspaces, and none of them may weaken
 * its protection elsewhere — so it is the operator's, out of band, after
 * verifying the person by other means. It removes all factors, ends every
 * session and pending device link, and is audited. The account must then
 * enroll again at its next sign-in if its roles require 2FA.
 */

import { join } from 'path'
import { createHmac, randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import type { SessionData } from 'express-session'
import { loadRelayConfig } from './relay-config.js'
import type { RelayConfig } from './relay-config.js'
import { openControlPlaneDb, getUserById } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { hasSecondFactor } from './mfa.js'
import { toSessionUser } from './relay-auth-routes.js'
import { recordAuditEvent } from './audit.js'
import { revokePendingDeviceLinks } from './device-link.js'

export interface MfaResetSummary {
  login: string
  totp: number
  passkeys: number
  recoveryCodes: number
  sessions: number
}

/** Remove every second factor of an account and end its sessions. */
export function resetMfa(db: Database.Database, githubId: number): MfaResetSummary | null {
  const user = db.prepare('SELECT id, login FROM users WHERE github_id = ?').get(githubId) as
    | { id: string; login: string }
    | undefined
  if (!user) return null
  return db.transaction((): MfaResetSummary => {
    const summary = {
      login: user.login,
      totp: db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(user.id).changes,
      passkeys: db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(user.id).changes,
      recoveryCodes: db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(user.id).changes,
      sessions: db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(user.id).changes,
    }
    revokePendingDeviceLinks(db, user.id)
    recordAuditEvent(db, {
      kind: 'mfa_reset',
      actorUserId: null,
      metadata: { targetUserId: user.id, by: 'operator_cli', ...summary },
    })
    return summary
  })()
}

/** The relay's session cookie name (relay-server.ts). */
export const SESSION_COOKIE = 'codekin_relay_sid'
export const MAX_MINTED_SESSION_HOURS = 24

export interface MintedSession {
  login: string
  sid: string
  /** `codekin_relay_sid=<signed value>`, ready for a Cookie header. */
  cookie: string
  expiresAt: number
}

/** express-session's cookie value: `s:<sid>.<HMAC-SHA256 base64, unpadded>`, URI-encoded. */
export function signSessionCookie(sid: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')
  return encodeURIComponent(`s:${sid}.${sig}`)
}

/**
 * Sign a test account in on a staging relay: a fully signed-in session, as
 * after GitHub plus the second factor. Throws unless `config.staging`.
 */
export function mintSession(
  db: Database.Database,
  config: Pick<RelayConfig, 'staging' | 'sessionSecret' | 'publicUrl'>,
  githubId: number,
  hours = 8,
): MintedSession | null {
  if (!config.staging) {
    throw new Error('mint-session only runs on a staging relay (RELAY_STAGING=1 in its config)')
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_MINTED_SESSION_HOURS) {
    throw new Error(`--hours must be between 0 and ${MAX_MINTED_SESSION_HOURS}`)
  }
  const row = db.prepare('SELECT id FROM users WHERE github_id = ?').get(githubId) as { id: string } | undefined
  const user = row ? getUserById(db, row.id) : undefined
  if (!user) return null
  if (user.status !== 'active') throw new Error(`${user.login} is ${user.status}; only active accounts can be signed in`)

  const now = Date.now()
  const maxAge = Math.round(hours * 3_600_000)
  const sid = randomBytes(24).toString('base64url')
  const session = {
    cookie: {
      originalMaxAge: maxAge,
      expires: new Date(now + maxAge).toISOString(),
      httpOnly: true,
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      sameSite: 'lax',
    },
    user: toSessionUser(user),
    authMethod: 'github',
    authenticatedAt: now,
    authLevel: 'full',
    // Counts as a fresh second factor only for accounts that have one, so
    // 2FA policy is exercised as it would be for a real sign-in.
    ...(hasSecondFactor(db, user.id) ? { mfaVerifiedAt: now } : {}),
  } as unknown as SessionData
  const store = new SqliteSessionStore(db)
  try {
    store.set(sid, session)
  } finally {
    store.close()
  }
  recordAuditEvent(db, {
    kind: 'session_minted',
    actorUserId: null,
    metadata: { targetUserId: user.id, by: 'operator_cli', hours },
  })
  return {
    login: user.login,
    sid,
    cookie: `${SESSION_COOKIE}=${signSessionCookie(sid, config.sessionSecret)}`,
    expiresAt: now + maxAge,
  }
}

function usage(): number {
  console.error('Usage: relay-admin-cli reset-mfa <github-id>')
  console.error('       relay-admin-cli mint-session <github-id> [--hours N]   (staging relays only)')
  return 2
}

function main(argv: string[]): number {
  const [command, arg] = argv
  if (!arg || !/^\d+$/.test(arg)) return usage()
  if (command === 'mint-session') return mintSessionCommand(parseInt(arg, 10), argv.slice(2))
  if (command !== 'reset-mfa') return usage()
  const config = loadRelayConfig()
  const db = openControlPlaneDb(join(config.dataDir, 'control-plane.db'))
  try {
    const summary = resetMfa(db, parseInt(arg, 10))
    if (!summary) {
      console.error(`No account with GitHub id ${arg}.`)
      return 1
    }
    console.log(
      `Reset 2FA for ${summary.login}: removed ${summary.totp} authenticator, ${summary.passkeys} passkey(s), ` +
        `${summary.recoveryCodes} recovery code(s); ended ${summary.sessions} session(s).`,
    )
    console.log('Open browser sockets close within seconds, once the relay sees their sessions are gone.')
    return 0
  } finally {
    db.close()
  }
}

function mintSessionCommand(githubId: number, rest: string[]): number {
  const hoursFlag = rest.indexOf('--hours')
  const hours = hoursFlag >= 0 ? Number(rest[hoursFlag + 1]) : 8
  const config = loadRelayConfig()
  if (!config.staging) {
    console.error('Refusing: mint-session only runs on a staging relay (RELAY_STAGING=1 in its config).')
    return 1
  }
  const db = openControlPlaneDb(join(config.dataDir, 'control-plane.db'))
  try {
    const minted = mintSession(db, config, githubId, hours)
    if (!minted) {
      console.error(`No account with GitHub id ${githubId}. It has to sign in once through GitHub first.`)
      return 1
    }
    // The cookie alone on stdout, so scripts can capture it; the rest on stderr.
    console.error(`Signed in ${minted.login} until ${new Date(minted.expiresAt).toISOString()} (audited).`)
    console.log(minted.cookie)
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
