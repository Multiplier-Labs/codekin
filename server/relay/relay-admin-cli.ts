/**
 * Operator commands for the hosted relay, run on the relay host against its
 * control-plane database (same config as the server: ~/.codekin-relay/env).
 *
 *   node dist/relay/relay-admin-cli.js reset-mfa <github-id>
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
import type Database from 'better-sqlite3'
import { loadRelayConfig } from './relay-config.js'
import { openControlPlaneDb } from './control-plane-db.js'
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

function main(argv: string[]): number {
  const [command, arg] = argv
  if (command !== 'reset-mfa' || !arg || !/^\d+$/.test(arg)) {
    console.error('Usage: relay-admin-cli reset-mfa <github-id>')
    return 2
  }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
