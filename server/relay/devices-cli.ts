/**
 * `codekin relay devices …` (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.5):
 * the machine's device list from a terminal, for headless machines and SSH.
 * Edits relay-devices.json directly, like the local Settings routes.
 *
 *   codekin relay devices [list] [--json]
 *   codekin relay devices approve <code>     the code your browser shows
 *   codekin relay devices trust <token>      the command your browser shows (no codes)
 *   codekin relay devices reject <requestId>
 *   codekin relay devices revoke <keyId>
 *   codekin relay devices policy <off|warn|required>
 *   codekin relay devices passkey-adds <on|off>  whether an enrolled passkey may add a browser
 *   codekin relay devices passkey-window <minutes>  how long a passkey confirmation covers its browser
 */

import { readRelayCredentialIdentity, relayCredentialPath } from './relay-credential.js'
import { readMachineIdentity } from './machine-identity.js'
import { trustPathsFor } from './machine-trust.js'
import {
  describeTrustStore, INTENT_POLICIES, MAX_PASSKEY_WINDOW_MINUTES, readTrustStore, revokeCredential, setIntentPolicy, setLocalConfirmationOnly, setPasskeyWindow, TrustStoreError,
} from './trust-store.js'
import type { TrustStoreView } from './trust-store.js'
import { approveEnrolment, approveTrustToken, rejectEnrolment } from './enrolment.js'
import { intentLogPath, readRecentIntents, verifyIntentLog } from './intent-log.js'

export interface DevicesCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

export const DEVICES_USAGE = [
  'Usage: codekin relay devices <list|trust|approve|reject|revoke|policy|passkey-adds>',
  '  list   [--json]                   Show the devices that can control this computer',
  '  trust <token>                     Confirm the browser that showed this command',
  '  approve <code>                    Confirm the browser showing this code',
  '  reject <requestId>                Turn down a browser waiting to be confirmed',
  '  revoke <keyId>                    Remove a device',
  `  policy <${INTENT_POLICIES.join('|')}>         Set whether devices must sign what they send`,
  '  passkey-adds <on|off>             Whether your passkey may add a browser without a code typed here',
  `  passkey-window <0-${MAX_PASSKEY_WINDOW_MINUTES}>          Minutes a passkey confirmation covers its browser (0: ask every time)`,
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
  io.out(`Passkeys:     ${view.localConfirmationOnly ? 'may not add browsers (only devices confirmed here)' : 'may add browsers'}`)
  io.out(`Bypass/always-allow: ${view.passkeyWindowMinutes === 0
    ? 'passkey asked every time'
    : `passkey asked, then not again on that browser for ${view.passkeyWindowMinutes} min`}`)
  io.out('Not enforced yet: this Codekin version keeps the list but does not check signatures.')
  io.out('')
  if (view.pending.length > 0) {
    io.out('Waiting to be confirmed (type the code the browser shows: codekin relay devices approve <code>):')
    for (const p of view.pending) io.out(`  ${p.enrolId}  ${p.label}  requested ${p.createdAt}`)
    io.out('')
  }
  if (view.approved.length > 0) {
    io.out('Just confirmed; type the code in that browser to finish:')
    for (const a of view.approved) io.out(`  ${a.confirmCode}  ${a.label}`)
    io.out('')
  }
  if (view.credentials.length === 0) {
    io.out('No devices yet. In the browser, choose "Confirm this browser" for this computer, then type')
    io.out('the code it shows here with `codekin relay devices approve <code>`.')
    return
  }
  io.out('Devices:')
  for (const c of view.credentials) {
    const used = c.lastUsedAt ? `, last used ${c.lastUsedAt}` : ''
    io.out(`  ${c.keyId}  ${c.kind.padEnd(7)}  ${c.label || '(no label)'}`)
    io.out(`  ${' '.repeat(c.keyId.length)}  added ${c.addedAt}, ${addedByText(c.addedBy)}${used}`)
  }
}

/**
 * Confirming a browser must happen on this computer, by its owner (spec
 * §5.2, §5.2b). A Codekin session's input and output may cross the relay,
 * so the trust token or code must never pass through one: a session that
 * runs this command (or is asked to by a prompt the relay could have
 * written) is refused. It is a guard against the easy path, not a boundary:
 * a process can clear its environment.
 */
export function insideCodekinSession(env: NodeJS.ProcessEnv): boolean {
  return typeof env.CODEKIN_SESSION_ID === 'string' && env.CODEKIN_SESSION_ID.length > 0
}

/** Run the command; returns the process exit code. */
export function runDevicesCommand(
  args: string[],
  credentialFile = relayCredentialPath(),
  io: DevicesCliIo = { out: line => { console.log(line) }, err: line => { console.error(line) } },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const [action = 'list', ...rest] = args
  if ((action === 'trust' || action === 'approve') && insideCodekinSession(env)) {
    io.err('Refused: this is running inside a Codekin session, whose input and output can pass through the relay.')
    io.err('Run it yourself in a terminal on this computer (or over SSH), or use Settings → Remote access in Codekin opened here.')
    return 1
  }
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
      case 'trust': {
        // The install passes it in the environment, which (unlike argv) `ps` doesn't show.
        const token = rest[0] ?? process.env.CODEKIN_TRUST_TOKEN
        if (!token) {
          io.err('Usage: codekin relay devices trust <token>')
          return 1
        }
        const outcome = approveTrustToken(token, { devicesFile, identityFile }, { machineId: paired.machineId, relayOrigin: paired.url })
        if (outcome.kind === 'refused') {
          io.err("The browser that asked with this command couldn't prove it holds it. Start again in the browser.")
          return 1
        }
        if (outcome.kind === 'waiting') {
          io.out('Ready. The browser that showed this command is confirmed as soon as it asks (within 30 minutes).')
          return 0
        }
        io.out(`Confirmed ${outcome.added.label}. It can now control this computer; the browser finishes by itself.`)
        if (outcome.added.policyRaised) {
          io.out('This computer now accepts control through the relay only from confirmed devices.')
          io.out('Your other browsers need confirming too, and existing shares need Allow again in the share dialog.')
          io.out('To undo: codekin relay devices policy off')
        }
        return 0
      }
      case 'approve': {
        if (!rest[0]) {
          io.err('Usage: codekin relay devices approve <code>')
          return 1
        }
        const added = approveEnrolment(rest.join(''), devicesFile, paired.machineId)
        io.out(`Confirmed ${added.label}. It can now control this computer.`)
        if (added.policyRaised) {
          io.out('This computer now accepts control through the relay only from confirmed devices.')
          io.out('Your other browsers need confirming too, and existing shares need Allow again in the share dialog.')
          io.out('To undo: codekin relay devices policy off')
        }
        io.out('')
        io.out(`To finish, type this code in the browser:  ${added.confirmCode}`)
        return 0
      }
      case 'reject': {
        if (!rest[0]) {
          io.err('Usage: codekin relay devices reject <requestId>')
          return 1
        }
        rejectEnrolment(rest[0], devicesFile, paired.machineId)
        io.out('Request turned down.')
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
      case 'passkey-adds': {
        if (rest[0] !== 'on' && rest[0] !== 'off') {
          io.err('Usage: codekin relay devices passkey-adds <on|off>')
          return 1
        }
        setLocalConfirmationOnly(rest[0] === 'off', devicesFile, paired.machineId)
        io.out(rest[0] === 'on'
          ? 'Your enrolled passkey may add a browser to this computer.'
          : 'Only devices confirmed on this computer can be added now.')
        return 0
      }
      case 'passkey-window': {
        const minutes = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : NaN
        const store = setPasskeyWindow(minutes, devicesFile, paired.machineId)
        const set = store.passkeyWindowMinutes ?? 15
        io.out(set === 0
          ? 'Your passkey is asked for every bypass session and "always allow" rule.'
          : `After you use your passkey, that browser isn't asked again for ${set} minutes.`)
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

/**
 * `codekin relay audit …`: the machine's intent log (spec §7.2).
 *
 *   codekin relay audit [list] [--limit N] [--json]
 *   codekin relay audit verify [file]
 */
export function runAuditCommand(
  args: string[],
  logFile = intentLogPath(),
  io: DevicesCliIo = { out: line => { console.log(line) }, err: line => { console.error(line) } },
): number {
  const [action = 'list', ...rest] = args
  if (action === 'verify') {
    const file = rest[0] ?? logFile
    const result = verifyIntentLog(file)
    if (result.ok) {
      io.out(`OK: ${result.entries} entries in ${file}, chain intact.`)
      return 0
    }
    io.err(`Broken at line ${result.problem?.line ?? '?'}: ${result.problem?.reason ?? 'unknown'} (${file})`)
    return 1
  }
  if (action === 'list') {
    const limitFlag = rest.indexOf('--limit')
    const limit = limitFlag !== -1 ? Number.parseInt(rest[limitFlag + 1] ?? '', 10) || 50 : 50
    const entries = readRecentIntents(logFile, { limit })
    if (rest.includes('--json')) {
      io.out(JSON.stringify(entries, null, 2))
      return 0
    }
    if (entries.length === 0) {
      io.out('Nothing logged yet.')
      return 0
    }
    for (const e of entries) {
      const what = e.verdict === 'accepted' ? 'ok      ' : e.verdict === 'unsigned' ? 'unsigned' : 'REJECTED'
      const why = e.reason ? `  ${e.reason}${e.forwarded ? ' (forwarded)' : ''}` : ''
      io.out(`${e.at}  ${what}  ${e.action}${e.sessionId ? `  session ${e.sessionId}` : ''}${e.keyId ? `  key ${e.keyId}` : ''}${why}`)
    }
    return 0
  }
  io.err('Usage: codekin relay audit [list [--limit N] [--json] | verify [file]]')
  return 1
}
