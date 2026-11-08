/**
 * Where the relay machine secret is kept (docs/RELAY-HARDENING.md §5).
 *
 * By default it sits in ~/.config/codekin/relay.json (mode 0600), which is
 * right for the CLI and headless Linux. When CODEKIN_SECRET_HELPER names an
 * executable (the desktop app sets it to itself on macOS), the secret goes
 * to the Keychain through it instead, and relay.json holds
 * `"secretRef": "keychain"`. The helper protocol:
 *
 *   <helper> --codekin-secrets get|set|delete <service> <account>
 *
 * The secret travels on stdin/stdout, never argv. Exit 0 ok, 1 no such item,
 * anything else an error.
 *
 * This keeps the secret out of backups, dotfile sync and casual file
 * reading. It doesn't stop code already running as the user, which can run
 * the helper too.
 */

import { spawnSync } from 'child_process'

export const KEYCHAIN_SERVICE = 'ai.codekin.desktop.relay'
export const SECRET_REF_KEYCHAIN = 'keychain'

export interface SecretStore {
  /** The secret for `account`, or null when there is none. Throws on store errors. */
  get(account: string): string | null
  set(account: string, secret: string): void
  /** True if an item was removed. */
  delete(account: string): boolean
}

type Runner = (cmd: string, args: string[], opts: { input?: string; encoding: 'utf8'; timeout: number }) => {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export class HelperSecretStore implements SecretStore {
  constructor(
    private helper: string,
    private service = KEYCHAIN_SERVICE,
    private run: Runner = (cmd, args, opts) => spawnSync(cmd, args, opts),
  ) {}

  private call(op: 'get' | 'set' | 'delete', account: string, input?: string): { status: number; stdout: string } {
    const res = this.run(this.helper, ['--codekin-secrets', op, this.service, account], {
      encoding: 'utf8',
      timeout: 15_000,
      ...(input !== undefined ? { input } : {}),
    })
    if (res.error) throw new Error(`secret helper failed to run: ${res.error.message}`)
    const status = res.status ?? -1
    if (status !== 0 && status !== 1) {
      throw new Error(`secret helper ${op} failed (exit ${status}): ${res.stderr.trim().slice(0, 200)}`)
    }
    return { status, stdout: res.stdout }
  }

  get(account: string): string | null {
    const { status, stdout } = this.call('get', account)
    return status === 0 && stdout !== '' ? stdout : null
  }

  set(account: string, secret: string): void {
    const { status } = this.call('set', account, secret)
    if (status !== 0) throw new Error('secret helper refused to store the secret')
  }

  delete(account: string): boolean {
    return this.call('delete', account).status === 0
  }
}

/** The configured store, or null when secrets stay in relay.json. */
export function secretStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SecretStore | null {
  const helper = env.CODEKIN_SECRET_HELPER?.trim()
  return helper ? new HelperSecretStore(helper) : null
}
