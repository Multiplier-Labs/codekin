/**
 * `codekin relay devices …` (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.5):
 * the machine's device list from a terminal, for headless machines and SSH.
 * Edits relay-devices.json directly, like the local Settings routes.
 *
 *   codekin relay devices [list] [--json]
 *   codekin relay devices revoke <keyId>
 *   codekin relay devices policy <off|warn|required>
 *
 * `approve <code>` arrives with the enrolment ceremony (slice 3).
 */

import { readRelayCredentialIdentity, relayCredentialPath } from './relay-credential.js'
import { readMachineIdentity } from './machine-identity.js'
import { trustPathsFor } from './machine-trust.js'
import {
  describeTrustStore, INTENT_POLICIES, readTrustStore, revokeCredential, setIntentPolicy, TrustStoreError,
} from './trust-store.js'
import type { TrustStoreView } from './trust-store.js'

export interface DevicesCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

export const DEVICES_USAGE = [
  'Usage: codekin relay devices <list|revoke|policy>',
  '  list   [--json]                   Show the devices that can control this computer',
  '  revoke <keyId>                    Remove a device',
  `  policy <${INTENT_POLICIES.join('|')}>         Set whether devices must sign what they send`,
]

const POLICY_TEXT: Record<TrustStoreView['policy'], string> = {
  off: 'off (the relay is trusted to say who is in control)',
  warn: 'warn (unsigned actions are logged)',
  required: 'required (only confirmed devices can control this computer)',
}

function addedByText(addedBy: string): string {
  if (addedBy === 'local') return 'confirmed on this computer'
  if (addedBy.startsWith('passkey:')) return `added by passkey ${addedBy.slice('passkey:'.length)}`
  return addedBy
}

function printList(view: TrustStoreView, identityKeyId: string | null, io: DevicesCliIo): void {
  io.out(`Machine:      ${view.machineId}`)
  io.out(`Identity key: ${identityKeyId ?? 'not created yet (made when the connector starts)'}`)
  io.out(`Policy:       ${POLICY_TEXT[view.policy]}`)
  io.out('Not enforced yet: this Codekin version keeps the list but does not check signatures.')
  io.out('')
  if (view.credentials.length === 0) {
    io.out('No devices yet. Devices are added by typing a code from your browser on this computer;')
    io.out('that arrives in a later Codekin version.')
    return
  }
  io.out('Devices:')
  for (const c of view.credentials) {
    const used = c.lastUsedAt ? `, last used ${c.lastUsedAt}` : ''
    io.out(`  ${c.keyId}  ${c.kind.padEnd(7)}  ${c.label || '(no label)'}`)
    io.out(`  ${' '.repeat(c.keyId.length)}  added ${c.addedAt}, ${addedByText(c.addedBy)}${used}`)
  }
}

/** Run the command; returns the process exit code. */
export function runDevicesCommand(
  args: string[],
  credentialFile = relayCredentialPath(),
  io: DevicesCliIo = { out: line => { console.log(line) }, err: line => { console.error(line) } },
): number {
  const [action = 'list', ...rest] = args
  const paired = readRelayCredentialIdentity(credentialFile)
  if (!paired) {
    io.err('Not paired. Run `codekin relay login` first.')
    return 1
  }
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)

  try {
    switch (action) {
      case 'list': {
        const store = readTrustStore(devicesFile)
        if (!store || store.machineId !== paired.machineId) {
          io.err('This machine has no device list yet. It is created when the relay connector starts.')
          return 1
        }
        const identity = readMachineIdentity(identityFile)
        const keyId = identity?.machineId === paired.machineId ? identity.keyId : null
        const view = describeTrustStore(store)
        if (rest.includes('--json')) io.out(JSON.stringify({ ...view, identityKeyId: keyId }, null, 2))
        else printList(view, keyId, io)
        return 0
      }
      case 'revoke': {
        const keyId = rest[0]
        if (!keyId) {
          io.err('Usage: codekin relay devices revoke <keyId>')
          return 1
        }
        const removed = revokeCredential(keyId, devicesFile, paired.machineId)
        io.out(`Removed ${removed.label || removed.keyId}. It can no longer control this computer.`)
        return 0
      }
      case 'policy': {
        const store = setIntentPolicy(rest[0], devicesFile, paired.machineId)
        io.out(`Policy: ${POLICY_TEXT[store.policy]}`)
        return 0
      }
      default:
        for (const line of DEVICES_USAGE) io.err(line)
        return 1
    }
  } catch (err) {
    if (err instanceof TrustStoreError) {
      io.err(err.message)
      return 1
    }
    throw err
  }
}
