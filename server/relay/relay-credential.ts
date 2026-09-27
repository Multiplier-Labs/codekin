/**
 * The machine's hosted-relay credential (~/.config/codekin/relay.json),
 * written by `codekin relay login` or the installer and read by both the
 * foreground connector CLI and the connector embedded in the local server.
 *
 * Kept free of side effects so the server can import it; connector-cli.ts
 * runs its main() at import time.
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

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

export function readRelayCredential(file = relayCredentialPath()): RelayCredential | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RelayCredential> | null
    if (
      parsed &&
      typeof parsed.url === 'string' &&
      typeof parsed.machineId === 'string' &&
      typeof parsed.machineSecret === 'string'
    ) {
      return {
        url: parsed.url,
        machineId: parsed.machineId,
        machineSecret: parsed.machineSecret,
        managed: parsed.managed === true,
      }
    }
    return null
  } catch {
    return null
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
