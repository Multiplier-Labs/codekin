/**
 * The machine's side of the enrolment ceremony
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.2): how a browser key gets
 * onto this machine's device list without the relay being able to add, swap
 * or grind keys.
 *
 *   enrol_commit { commit }            → enrol_challenge { enrolId, machineKey, nonceM, signature }
 *   enrol_reveal { enrolId, spki, passkeys, label, nonceB, pop }
 *                                      → enrol_result { enrolId, state: 'awaiting_code' }
 *   enrol_status { enrolId }           → enrol_result { enrolId, state, keyId?, signature? }
 *
 * The browser shows an 8-character code derived from both keys and both
 * nonces; the owner types it on this machine (Settings → Remote access,
 * `codekin relay devices approve`, or the prompt after `codekin relay login`),
 * which is what adds the key. The browser polls `enrol_status` and pins the
 * machine key once it sees an approval signed by that key.
 *
 * Requests live in the trust store's `pending` list, so the local UI and CLI
 * (other processes) can decide them, and they survive a connector restart.
 * Only the machine owner may enrol, checked against the owner id the trust
 * store recorded at pairing, not just the relay's role label.
 */

import { randomBytes, randomUUID } from 'crypto'
import type { KeyObject } from 'crypto'
import {
  CHALLENGE_LABEL, DIGEST_BYTES, NONCE_BYTES, POP_LABEL, RESULT_LABEL, SIGNATURE_BYTES,
  checkLabel, codesEqual, commitment, fromB64url, normalizeCode, shortAuthString, signP1363, transcript, verifyP1363,
} from './enrolment-crypto.js'
import type { EnrolPasskey } from './enrolment-crypto.js'
import { keyIdForSpki, loadMachineSigningKey, parseP256Spki, readMachineIdentity } from './machine-identity.js'
import { mutateTrustStore, readTrustStore, TrustStoreError } from './trust-store.js'
import type { PendingEnrolment, TrustedCredential, TrustStore } from './trust-store.js'
import type { RelayPrincipal } from './relay-protocol.js'
import type { SecretStore } from './secret-store.js'

/** How long a request waits for its code (spec §5.2). */
export const ENROL_TTL_MS = 10 * 60_000
/** After approval, how long the browser has to collect the signed result. */
export const RESULT_TTL_MS = 10 * 60_000
/** Undecided requests a machine holds at once (spec §5.2). */
export const MAX_PENDING_ENROLMENTS = 3

export type EnrolState = 'awaiting_code' | 'approved' | 'rejected' | 'expired'

export interface EnrolChallenge {
  enrolId: string
  /** base64url SPKI of the machine identity key. */
  machineKey: string
  nonceM: string
  /** sign_kM(T(challenge, enrolId, C, nonceM)), base64url. */
  signature: string
}

export interface EnrolResult {
  enrolId: string
  state: EnrolState
  /** Set when approved: the new device's key id. */
  keyId?: string
  /** Set when approved or rejected: sign_kM(T(result, enrolId, SPKI(kB), state)), base64url. */
  signature?: string
}

/** A refusal the connector sends back as a relay `error` frame. */
export class EnrolmentError extends Error {
  constructor(readonly code: 'enrol_refused' | 'enrol_unavailable', message: string) {
    super(message)
    this.name = 'EnrolmentError'
  }
}

export interface MachineEnrolmentOptions {
  machineId: string
  identityFile: string
  devicesFile: string
  secretStore?: SecretStore | null
  now?: () => number
  log?: Pick<Console, 'log' | 'warn'>
}

const refuse = (message: string) => new EnrolmentError('enrol_refused', message)

/** Handles the enrol_* frames for one paired machine. */
export class MachineEnrolment {
  private signingKey: KeyObject | null = null
  private readonly now: () => number

  constructor(private readonly opts: MachineEnrolmentOptions) {
    this.now = opts.now ?? Date.now
  }

  /** The identity key and its SPKI, loaded once (the Keychain read can prompt). */
  private machineKey(): { key: KeyObject; spki: Buffer } {
    const identity = readMachineIdentity(this.opts.identityFile)
    if (!identity || identity.machineId !== this.opts.machineId) {
      throw new EnrolmentError('enrol_unavailable', 'This computer has no identity key yet; restart Codekin on it')
    }
    this.signingKey ??= loadMachineSigningKey(this.opts.identityFile, this.opts.secretStore ?? null)
    if (!this.signingKey) throw new EnrolmentError('enrol_unavailable', "This computer's identity key could not be read")
    return { key: this.signingKey, spki: Buffer.from(identity.publicKey, 'base64url') }
  }

  /** Only the owner the trust store recorded may enrol, and only as owner. */
  private checkPrincipal(principal: RelayPrincipal | undefined, store: TrustStore): string {
    if (!principal || principal.role !== 'owner') throw refuse('Only the owner of this computer can confirm a browser on it')
    if (!store.ownerUserId) throw new EnrolmentError('enrol_unavailable', "This computer doesn't know its owner yet; reconnect it to the relay")
    if (principal.userId !== store.ownerUserId) throw refuse('Only the owner of this computer can confirm a browser on it')
    return principal.userId
  }

  private mutate<T>(fn: (store: TrustStore) => T): T {
    try {
      return mutateTrustStore(this.opts.devicesFile, this.opts.machineId, fn, this.now())
    } catch (err) {
      if (err instanceof TrustStoreError && err.code !== 'busy') {
        throw new EnrolmentError('enrol_unavailable', "This computer's device list can't be used right now")
      }
      throw err
    }
  }

  commit(principal: RelayPrincipal | undefined, payload: unknown): EnrolChallenge {
    const commit = fromB64url((payload as { commit?: unknown } | null)?.commit, DIGEST_BYTES)
    if (!commit) throw refuse('Malformed enrolment request')
    const { key, spki } = this.machineKey()
    return this.mutate(store => {
      const userId = this.checkPrincipal(principal, store)
      const open = store.pending.filter(p => !p.outcome)
      if (open.length >= MAX_PENDING_ENROLMENTS) {
        throw refuse('Too many browsers are waiting to be confirmed on this computer; try again in a few minutes')
      }
      const enrolId = randomUUID()
      const nonceM = randomBytes(NONCE_BYTES)
      const now = this.now()
      store.pending.push({
        enrolId,
        userId,
        commit: commit.toString('base64url'),
        nonceM: nonceM.toString('base64url'),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ENROL_TTL_MS).toISOString(),
      })
      const signature = signP1363(key, transcript(CHALLENGE_LABEL, enrolId, commit, nonceM))
      return { enrolId, machineKey: spki.toString('base64url'), nonceM: nonceM.toString('base64url'), signature: signature.toString('base64url') }
    })
  }

  reveal(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const p = (payload ?? {}) as Record<string, unknown>
    const enrolId = typeof p.enrolId === 'string' ? p.enrolId : null
    const spki = parseP256Spki(p.spki)
    const nonceB = fromB64url(p.nonceB, NONCE_BYTES)
    const pop = fromB64url(p.pop, SIGNATURE_BYTES)
    const label = checkLabel(p.label)
    if (!enrolId || !spki || !nonceB || !pop || !label || !Array.isArray(p.passkeys)) throw refuse('Malformed enrolment request')
    // Passkeys join the ceremony with step-up (slice 5).
    if (p.passkeys.length > 0) throw refuse('This computer cannot enrol passkeys yet')
    const passkeys: EnrolPasskey[] = []
    const { spki: machineSpki } = this.machineKey()
    const spkiB = Buffer.from(spki, 'base64url')

    const outcome = this.mutate((store): EnrolResult | { refused: string } => {
      const userId = this.checkPrincipal(principal, store)
      const entry = store.pending.find(e => e.enrolId === enrolId)
      if (!entry || entry.userId !== userId) throw refuse('Unknown or expired enrolment request')
      if (entry.reveal || entry.outcome) throw refuse('This enrolment request was already used')
      const commit = Buffer.from(entry.commit, 'base64url')
      const nonceM = Buffer.from(entry.nonceM, 'base64url')
      // The reveal must open the commitment made before nonceM existed, or
      // a relay could pick its key after seeing the machine's nonce.
      // A failed check spends the request (written back, then refused).
      if (!commitment(spkiB, passkeys, label, nonceB).equals(commit)) {
        store.pending = store.pending.filter(e => e !== entry)
        return { refused: 'The browser key does not match its commitment' }
      }
      if (!verifyP1363(spkiB, transcript(POP_LABEL, enrolId, nonceM), pop)) {
        store.pending = store.pending.filter(e => e !== entry)
        return { refused: 'The browser could not prove it holds its key' }
      }
      entry.reveal = {
        spki,
        keyId: keyIdForSpki(spki),
        label,
        nonceB: nonceB.toString('base64url'),
        passkeys,
        code: shortAuthString(machineSpki, spkiB, passkeys, nonceB, nonceM),
        revealedAt: new Date(this.now()).toISOString(),
      }
      this.opts.log?.log(`[relay] A browser ("${label}") is asking to control this computer. Type the code it shows in Settings → Remote access, or run \`codekin relay devices approve <code>\`.`)
      return { enrolId, state: 'awaiting_code' }
    })
    if ('refused' in outcome) throw refuse(outcome.refused)
    return outcome
  }

  status(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const enrolId = (payload as { enrolId?: unknown } | null)?.enrolId
    if (typeof enrolId !== 'string') throw refuse('Malformed enrolment request')
    const store = readTrustStore(this.opts.devicesFile)
    if (!store || store.machineId !== this.opts.machineId) throw new EnrolmentError('enrol_unavailable', "This computer's device list can't be used right now")
    const userId = this.checkPrincipal(principal, store)
    const entry = store.pending.find(e => e.enrolId === enrolId && e.userId === userId)
    if (!entry || Date.parse(entry.expiresAt) <= this.now()) return { enrolId, state: 'expired' }
    if (!entry.reveal) throw refuse('This enrolment request has not been completed')
    if (!entry.outcome) return { enrolId, state: 'awaiting_code' }
    const { key } = this.machineKey()
    const state = entry.outcome.state
    const signature = signP1363(key, transcript(RESULT_LABEL, enrolId, Buffer.from(entry.reveal.spki, 'base64url'), state))
    return {
      enrolId,
      state,
      ...(state === 'approved' ? { keyId: entry.reveal.keyId } : {}),
      signature: signature.toString('base64url'),
    }
  }

  /** Dispatch one frame; throws EnrolmentError for a refusal. */
  handle(kind: string, principal: RelayPrincipal | undefined, payload: unknown): { kind: 'enrol_challenge' | 'enrol_result'; payload: EnrolChallenge | EnrolResult } {
    switch (kind) {
      case 'enrol_commit': return { kind: 'enrol_challenge', payload: this.commit(principal, payload) }
      case 'enrol_reveal': return { kind: 'enrol_result', payload: this.reveal(principal, payload) }
      case 'enrol_status': return { kind: 'enrol_result', payload: this.status(principal, payload) }
      default: throw refuse('Unknown enrolment message')
    }
  }
}

/**
 * The owner typed a code on this machine: add the browser whose request
 * produced it. Throws TrustStoreError('not_found') when no waiting request
 * has that code.
 */
export function approveEnrolment(
  input: string,
  devicesFile: string,
  machineId: string,
  now: () => number = Date.now,
): TrustedCredential {
  const code = normalizeCode(input)
  if (!code) throw new TrustStoreError('not_found', 'That is not a code: it has 8 letters and digits, like K7QM-2XPA')
  return mutateTrustStore(devicesFile, machineId, store => {
    const t = now()
    // Compare against every waiting request, without stopping at a match.
    let match: PendingEnrolment | null = null
    for (const entry of store.pending) {
      if (!entry.reveal || entry.outcome || Date.parse(entry.expiresAt) <= t) continue
      if (codesEqual(entry.reveal.code, code) && !match) match = entry
    }
    if (!match?.reveal) throw new TrustStoreError('not_found', 'No browser is waiting with that code. Check it, or start again in the browser.')
    const at = new Date(t).toISOString()
    const credential: TrustedCredential = {
      keyId: match.reveal.keyId,
      kind: 'browser',
      userId: match.userId,
      spki: match.reveal.spki,
      label: match.reveal.label,
      addedAt: at,
      addedBy: 'local',
    }
    // Re-confirming a browser that is already listed replaces its entry.
    store.credentials = [...store.credentials.filter(c => c.keyId !== credential.keyId), credential]
    match.outcome = { state: 'approved', at }
    match.expiresAt = new Date(t + RESULT_TTL_MS).toISOString()
    return credential
  }, now())
}

/** Turn a request down from this machine. */
export function rejectEnrolment(enrolId: string, devicesFile: string, machineId: string, now: () => number = Date.now): void {
  mutateTrustStore(devicesFile, machineId, store => {
    const entry = store.pending.find(e => e.enrolId === enrolId && !e.outcome)
    if (!entry) throw new TrustStoreError('not_found', 'No such request is waiting')
    const t = now()
    entry.outcome = { state: 'rejected', at: new Date(t).toISOString() }
    entry.expiresAt = new Date(t + RESULT_TTL_MS).toISOString()
  }, now())
}
