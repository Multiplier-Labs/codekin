/**
 * The machine identity (machine-identity.ts) and trust store (trust-store.ts)
 * over a pairing's lifetime. Both files sit beside relay.json, so every
 * caller that knows the credential file also knows where they are.
 *
 *   pairing      → new identity key, empty trust store with the owner's id
 *   connector up → identity created if missing (machines paired before this
 *                  shipped), trust store created if missing, public key
 *                  advertised in hello, owner id recorded from hello_ack
 *   unpair       → both removed
 *
 * None of this may stop a machine from pairing or connecting: failures are
 * logged and the connector carries on without an identity key.
 */

import { dirname, join } from 'path'
import { ensureMachineIdentity, loadMachineSigningKey, removeMachineIdentity, writeMachineIdentity } from './machine-identity.js'
import { signP1363 } from './enrolment-crypto.js'
import type { KeyObject } from 'crypto'
import type { MachineIdentity, MachineKeyPair } from './machine-identity.js'
import { emptyTrustStore, ensureTrustStore, recordOwnerUserId, removeTrustStore, writeTrustStore } from './trust-store.js'
import { secretStoreFromEnv } from './secret-store.js'
import type { SecretStore } from './secret-store.js'
import { relayCredentialPath } from './relay-credential.js'
import { MachineEnrolment } from './enrolment.js'
import { IntentVerifier } from './intent-verify.js'
import { IntentLog, intentLogPath } from './intent-log.js'

export interface TrustPaths {
  identityFile: string
  devicesFile: string
}

/** relay-identity.json and relay-devices.json beside the given relay.json. */
export function trustPathsFor(credentialFile = relayCredentialPath()): TrustPaths {
  const dir = dirname(credentialFile)
  return { identityFile: join(dir, 'relay-identity.json'), devicesFile: join(dir, 'relay-devices.json') }
}

/** A relay user id as the relay sends it; anything else is ignored. */
export function safeUserId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null
}

type Log = Pick<Console, 'log' | 'warn'>

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Called when pairing completes, before relay.json is written (so the
 * embedded connector never starts without the identity it was paired with).
 * A new pairing always starts an empty trust store (spec §5.6).
 */
export function recordPairing(
  credentialFile: string,
  relayUrl: string,
  machineId: string,
  ownerUserId: string | null,
  keyPair: MachineKeyPair,
  store: SecretStore | null = secretStoreFromEnv(),
  log: Log = console,
): MachineIdentity | null {
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)
  let identity: MachineIdentity | null = null
  try {
    identity = writeMachineIdentity(identityFile, machineId, relayUrl, keyPair, store, log)
  } catch (err) {
    log.warn(`[relay] Could not save this machine's identity key (${reason(err)}); a new one is made when the connector starts.`)
  }
  try {
    writeTrustStore(devicesFile, emptyTrustStore(machineId, relayUrl, ownerUserId))
  } catch (err) {
    log.warn(`[relay] Could not create this machine's device list (${reason(err)}).`)
  }
  return identity
}

/**
 * Make sure the identity and trust store exist for this pairing before the
 * connector starts. Returns the identity public key to advertise, if any.
 */
export function prepareMachineTrust(
  credentialFile: string,
  machineId: string,
  relayUrl: string,
  store: SecretStore | null = secretStoreFromEnv(),
  log: Log = console,
): string | undefined {
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)
  let publicKey: string | undefined
  try {
    publicKey = ensureMachineIdentity(machineId, relayUrl, { file: identityFile, store, log }).publicKey
  } catch (err) {
    log.warn(`[relay] Could not set up this machine's identity key (${reason(err)}); connecting without it.`)
  }
  try {
    ensureTrustStore(machineId, relayUrl, { file: devicesFile, log })
  } catch (err) {
    log.warn(`[relay] Could not read this machine's device list ${devicesFile} (${reason(err)}). Fix or remove the file.`)
  }
  return publicKey
}

/** hello_ack named the owner: record it if the trust store doesn't have one yet. */
export function recordOwnerFromRelay(credentialFile: string, machineId: string, ownerUserId: unknown, log: Log = console): void {
  const userId = safeUserId(ownerUserId)
  if (!userId) return
  try {
    recordOwnerUserId(machineId, userId, trustPathsFor(credentialFile).devicesFile, log)
  } catch (err) {
    log.warn(`[relay] Could not record this machine's owner in its device list (${reason(err)}).`)
  }
}

/** The enrolment handler the connector answers enrol_* frames with. */
export function machineEnrolmentFor(
  credentialFile: string,
  machineId: string,
  store: SecretStore | null = secretStoreFromEnv(),
  log: Log = console,
): MachineEnrolment {
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)
  return new MachineEnrolment({ machineId, identityFile, devicesFile, secretStore: store, log })
}

/**
 * Signs with this machine's identity key, loading it once; a key that can't
 * be read is retried at most once a minute (each try may prompt the Keychain).
 */
export function machineKeySigner(
  credentialFile: string,
  store: SecretStore | null = secretStoreFromEnv(),
): (data: Uint8Array) => string | null {
  const { identityFile } = trustPathsFor(credentialFile)
  let key: KeyObject | null = null
  let failedAt = -Infinity
  return data => {
    if (!key && Date.now() - failedAt >= 60_000) {
      key = loadMachineSigningKey(identityFile, store)
      if (!key) failedAt = Date.now()
    }
    return key ? signP1363(key, data).toString('base64url') : null
  }
}

/** The intent checks for this machine's connector, logging to the local intent log (§7.2). */
export function intentVerifierFor(
  credentialFile: string,
  machineId: string,
  logFile: string = intentLogPath(),
  log: Log = console,
  store: SecretStore | null = secretStoreFromEnv(),
): IntentVerifier {
  return new IntentVerifier({
    machineId,
    devicesFile: trustPathsFor(credentialFile).devicesFile,
    log: new IntentLog(logFile, Date.now, log),
    warn: log,
    signWithMachineKey: machineKeySigner(credentialFile, store),
  })
}

/** Unpair: the identity and device list belong to the pairing that is going away. */
export function removeMachineTrust(credentialFile: string, store: SecretStore | null = secretStoreFromEnv()): void {
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)
  try { removeMachineIdentity(identityFile, store) } catch { /* best effort */ }
  try { removeTrustStore(devicesFile) } catch { /* best effort */ }
}
