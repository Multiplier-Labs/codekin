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
import { ensureMachineIdentity, removeMachineIdentity, writeMachineIdentity } from './machine-identity.js'
import type { MachineIdentity, MachineKeyPair } from './machine-identity.js'
import { emptyTrustStore, ensureTrustStore, recordOwnerUserId, removeTrustStore, writeTrustStore } from './trust-store.js'
import { secretStoreFromEnv } from './secret-store.js'
import type { SecretStore } from './secret-store.js'
import { relayCredentialPath } from './relay-credential.js'

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

/** Unpair: the identity and device list belong to the pairing that is going away. */
export function removeMachineTrust(credentialFile: string, store: SecretStore | null = secretStoreFromEnv()): void {
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)
  try { removeMachineIdentity(identityFile, store) } catch { /* best effort */ }
  try { removeTrustStore(devicesFile) } catch { /* best effort */ }
}
