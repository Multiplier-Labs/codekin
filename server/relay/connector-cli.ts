/**
 * Entry point for `codekin relay connect`: loads the machine credential
 * from ~/.config/codekin/relay.json and runs the connector in the
 * foreground until Ctrl-C, serving proxied REST requests from the hosted
 * app against the local Codekin server.
 *
 * Machines paired with a managed credential (what the installer and
 * `codekin relay login` write) do not need this: the local Codekin server
 * runs the same connector in-process (embedded-connector.ts). This entry
 * point remains for unmanaged setups that supervise the connector themselves
 * (e.g. under pm2) and for `codekin relay connect --foreground`.
 */

import { RelayConnector } from './connector.js'
import { resolveLocalTarget } from './connector-proxy.js'
import { readRelayCredential, codekinPackageVersion, relayCredentialPath } from './relay-credential.js'
import { intentVerifierFor, machineEnrolmentFor, prepareMachineTrust, recordOwnerFromRelay } from './machine-trust.js'

export { readRelayCredential } from './relay-credential.js'
export type { RelayCredential } from './relay-credential.js'

function main(): void {
  const credential = readRelayCredential()
  if (!credential) {
    console.error('Not paired. Run `codekin relay login` first.')
    process.exit(1)
  }

  const version = codekinPackageVersion()
  const localTarget = resolveLocalTarget()
  console.log(`[connector] Proxying to local Codekin at ${localTarget.origin}`)
  if (localTarget.authToken) {
    console.log(`[connector] Local auth token from ${localTarget.tokenSource ?? 'unknown source'}`)
  } else {
    console.warn(
      '[connector] No local auth token found. Every proxied request will be refused with 401.\n' +
        '[connector] Point AUTH_TOKEN_FILE at the token file your Codekin server uses ' +
        '(check its process env), or set AUTH_TOKEN directly.',
    )
  }
  if (!localTarget.browserOrigin) {
    console.log(
      '[connector] No RELAY_LOCAL_ORIGIN/CORS_ORIGIN set. Session streaming needs one if this ' +
        "machine's Codekin server runs with NODE_ENV=production.",
    )
  }

  const credentialFile = relayCredentialPath()
  const identityKey = prepareMachineTrust(credentialFile, credential.machineId, credential.url)
  const intents = intentVerifierFor(credentialFile, credential.machineId)

  const connector = new RelayConnector({
    relayUrl: credential.url,
    machineId: credential.machineId,
    machineSecret: credential.machineSecret,
    connectorVersion: version,
    localCodekinVersion: version,
    localTarget,
    identityKey,
    enrolment: machineEnrolmentFor(credentialFile, credential.machineId, undefined, console, intents),
    intents,
    onOwner: (ownerUserId) => { recordOwnerFromRelay(credentialFile, credential.machineId, ownerUserId) },
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
        case 'replaced':
          console.error(`[connector] Another connector took this machine${suffix} — stopping.`)
          console.error('[connector] Only one connector may serve a machine at a time.')
          process.exitCode = 1
          break
        case 'update_required':
          console.error(`[connector] The relay won't serve this machine until it is updated${suffix}.`)
          console.error('[connector] Run `codekin upgrade`, then restart the connector.')
          break
        case 'devices_unconfirmed':
          console.error(`[connector] The workspace refuses this machine until a browser is confirmed on it${suffix}.`)
          console.error('[connector] In the web app choose "Confirm this browser", then run `codekin relay devices approve <code>`.')
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
  // The connector contains its own failures; this only keeps an asynchronous
  // one that slips through from taking the machine off the relay.
  process.on('unhandledRejection', (reason: unknown) => {
    console.warn(`[connector] unhandled failure: ${reason instanceof Error ? reason.message : String(reason)}`)
  })
}

main()
