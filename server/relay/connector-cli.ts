/**
 * Entry point for `codekin relay connect`: loads the machine credential
 * from ~/.config/codekin/relay.json and runs the connector in the
 * foreground until Ctrl-C, serving proxied REST requests from the hosted
 * app against the local Codekin server.
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { RelayConnector } from './connector.js'
import { resolveLocalTarget } from './connector-proxy.js'

export interface RelayCredential {
  url: string
  machineId: string
  machineSecret: string
}

const RELAY_CREDENTIAL_FILE = join(homedir(), '.config', 'codekin', 'relay.json')

export function readRelayCredential(): RelayCredential | null {
  if (!existsSync(RELAY_CREDENTIAL_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(RELAY_CREDENTIAL_FILE, 'utf-8')) as Partial<RelayCredential>
    if (
      typeof parsed.url === 'string' &&
      typeof parsed.machineId === 'string' &&
      typeof parsed.machineSecret === 'string'
    ) {
      return parsed as RelayCredential
    }
    return null
  } catch {
    return null
  }
}

function packageVersion(): string {
  try {
    const pkgPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function main(): void {
  const credential = readRelayCredential()
  if (!credential) {
    console.error('Not paired. Run `codekin relay login` first.')
    process.exit(1)
  }

  const version = packageVersion()
  const localTarget = resolveLocalTarget()
  console.log(`[connector] Proxying to local Codekin at ${localTarget.origin}`)
  if (!localTarget.authToken) {
    console.warn('[connector] No local auth token found — run `codekin setup` or set AUTH_TOKEN.')
  }
  if (!localTarget.browserOrigin) {
    console.log(
      '[connector] No RELAY_LOCAL_ORIGIN/CORS_ORIGIN set. Session streaming needs one if this ' +
        "machine's Codekin server runs with NODE_ENV=production.",
    )
  }

  const connector = new RelayConnector({
    relayUrl: credential.url,
    machineId: credential.machineId,
    machineSecret: credential.machineSecret,
    connectorVersion: version,
    localCodekinVersion: version,
    localTarget,
    onProxy: (method, path, status) => {
      console.log(`[connector] ${method} ${path} → ${status}`)
    },
    onStream: (event, channelId, detail) => {
      const suffix = detail ? ` (${detail})` : ''
      console.log(`[connector] session stream ${event} ${channelId}${suffix}`)
    },
    onStatus: (status, detail) => {
      const suffix = detail ? ` (${detail})` : ''
      switch (status) {
        case 'connecting':
          console.log(`[connector] Connecting${suffix}`)
          break
        case 'connected':
          console.log(`[connector] Online as "${detail ?? credential.machineId}"`)
          break
        case 'auth_failed':
          console.error(`[connector] Credential rejected${suffix} — run \`codekin relay login\` to re-pair.`)
          process.exitCode = 1
          break
        case 'disconnected':
          console.log(`[connector] Disconnected${suffix}`)
          break
        case 'reconnect_scheduled':
          console.log(`[connector] Reconnecting${suffix}`)
          break
        case 'stopped':
          console.log('[connector] Stopped')
          break
      }
    },
  })

  connector.start()

  const stop = () => {
    connector.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main()
