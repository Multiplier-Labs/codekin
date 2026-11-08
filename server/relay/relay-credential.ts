/**
 * The machine's hosted-relay credential (~/.config/codekin/relay.json),
 * written by `codekin relay login` or the installer and read by both the
 * foreground connector CLI and the connector embedded in the local server.
 *
 * Kept free of side effects so the server can import it; connector-cli.ts
 * runs its main() at import time.
 */

import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { secretStoreFromEnv, SECRET_REF_KEYCHAIN } from './secret-store.js'

/** relay.json's `secretRef` value when the secret is in the Keychain. */
export const SECRET_REF_KEYCHAIN_FIELD = SECRET_REF_KEYCHAIN
import type { SecretStore } from './secret-store.js'

export interface RelayCredential {
  url: string
  machineId: string
  machineSecret: string
  /**
   * True when the local Codekin server should run the connector itself.
   * Written by `codekin relay login` and the installer; credentials from
   * before the field existed are unmanaged, because those machines typically
   * run `codekin relay connect` under their own supervisor (pm2), and two
   * connectors for one machine would keep replacing each other.
   */
  managed: boolean
}

export function relayCredentialPath(home = homedir()): string {
  return join(home, '.config', 'codekin', 'relay.json')
}

export type RelayCredentialIdentity = Omit<RelayCredential, 'machineSecret'>
export type RelayCredentialRead =
  | { kind: 'ready'; credential: RelayCredential }
  | { kind: 'missing' }
  | { kind: 'unavailable'; identity: RelayCredentialIdentity }

/** Distinguish an absent pairing from a secret store that may recover. */
export function readRelayCredentialState(
  file = relayCredentialPath(),
  store: SecretStore | null = secretStoreFromEnv(),
): RelayCredentialRead {
  let parsed: Partial<RelayCredential> & { secretRef?: unknown }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'missing' }
    parsed = value
  } catch { return { kind: 'missing' } }
  if (typeof parsed.url !== 'string' || typeof parsed.machineId !== 'string') return { kind: 'missing' }
  const identity = { url: parsed.url, machineId: parsed.machineId, managed: parsed.managed === true }
  let secret: string | null = typeof parsed.machineSecret === 'string' ? parsed.machineSecret : null
  if (secret === null && parsed.secretRef === SECRET_REF_KEYCHAIN) {
    try { secret = store?.get(parsed.machineId) ?? null } catch { /* retryable */ }
    if (!secret) return { kind: 'unavailable', identity }
  }
  return secret ? { kind: 'ready', credential: { ...identity, machineSecret: secret } } : { kind: 'missing' }
}

/**
 * Which relay and machine relay.json names, without reading the secret (so
 * no Keychain prompt). Null when unpaired or unreadable.
 */
export function readRelayCredentialIdentity(file = relayCredentialPath()): RelayCredentialIdentity | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const parsed = value as Partial<RelayCredential>
    if (typeof parsed.url !== 'string' || typeof parsed.machineId !== 'string' || !parsed.machineId) return null
    return { url: parsed.url, machineId: parsed.machineId, managed: parsed.managed === true }
  } catch {
    return null
  }
}

/** Compatibility API for callers that only need a usable credential. */
export function readRelayCredential(
  file = relayCredentialPath(),
  store: SecretStore | null = secretStoreFromEnv(),
): RelayCredential | null {
  const result = readRelayCredentialState(file, store)
  return result.kind === 'ready' ? result.credential : null
}

/** Write a file in one step: temp file, fsync, rename. Mode 0600. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Move a plaintext machine secret from relay.json into the secret store:
 * store it, read it back and compare, then rewrite relay.json without it.
 * Any failure leaves the file as it was, so the secret is never lost.
 * Returns true when the file was rewritten.
 */
export function migrateCredentialToStore(
  file: string,
  store: SecretStore | null,
  log: Pick<Console, 'warn'> = console,
): boolean {
  if (!store || !existsSync(file)) return false
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    parsed = value as Record<string, unknown>
  } catch {
    return false
  }
  const machineId = parsed.machineId
  const secret = parsed.machineSecret
  if (typeof machineId !== 'string' || typeof secret !== 'string' || !secret) return false
  try {
    store.set(machineId, secret)
    if (store.get(machineId) !== secret) throw new Error('read-back did not match')
    const { machineSecret: _dropped, ...rest } = parsed
    void _dropped
    writeFileAtomic(file, JSON.stringify({ ...rest, secretRef: SECRET_REF_KEYCHAIN }, null, 2) + '\n')
    return true
  } catch (err) {
    log.warn(`[relay] Kept the machine secret in ${file}: moving it to the Keychain failed (${err instanceof Error ? err.message : String(err)})`)
    return false
  }
}

/**
 * The Codekin package version, found by walking up from this module to the
 * package.json named "codekin" (works from both server/relay/*.ts and the
 * compiled server/dist/relay/*.js).
 */
export function codekinPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === 'codekin' && pkg.version) return pkg.version
      } catch {
        // keep walking
      }
    }
    dir = dirname(dir)
  }
  return 'unknown'
}
