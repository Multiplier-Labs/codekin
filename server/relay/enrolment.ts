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
  checkLabel, codesEqual, sha256, commitment, confirmationCode, formatCode, fromB64url, normalizeCode, shortAuthString, signP1363,
  transcript, verifyP1363,
} from './enrolment-crypto.js'
import type { EnrolPasskey } from './enrolment-crypto.js'
import { keyIdForSpki, loadMachineSigningKey, parseP256Spki, readMachineIdentity } from './machine-identity.js'
import { addRevokedGrant, isIntentPolicy, mutateTrustStore, raiseIntentPolicy, readTrustStore, TrustStoreError } from './trust-store.js'
import type { PasskeyCredential, PendingEnrolment, TrustedCredential, TrustStore } from './trust-store.js'
import { coseToKey, keyIdForCoseKey, verifyPasskeyAssertion } from './webauthn-verify.js'
import type { PasskeyAssertion } from './webauthn-verify.js'
import {
  DEVICE_CERTIFY_ACTION, DEVICE_REVOKE_ACTION, DEVICE_REVOKED_LABEL, GRANT_REVOKE_ACTION, MACHINE_CLOCK_LABEL, POLICY_ACTION, POLICY_RAISED_LABEL, policyPayload, PASSKEY_PROOF_LABEL, certifyPayload, encodePasskeyProofs,
  grantRevokePayload, grantRevokedParts, revokePayload,
} from './intent-actions.js'
import type { IntentVerifier } from './intent-verify.js'
import { describeIntentRefusal } from './connector-stream.js'
import type { RelayPrincipal } from './relay-protocol.js'
import type { SecretStore } from './secret-store.js'

/** How long a request waits for its code (spec §5.2). */
export const ENROL_TTL_MS = 10 * 60_000
/** After a decision, how long the browser can still collect it (a phone may stay locked for hours). */
export const RESULT_TTL_MS = 24 * 60 * 60_000
/** Undecided requests a machine holds at once (spec §5.2). */
export const MAX_PENDING_ENROLMENTS = 3
/**
 * Requests a machine accepts per ENROL_TTL_MS window, failed ones included.
 * Each request gives a relay one 2⁻⁴⁰ guess at a code; this bounds how many
 * guesses it gets, however fast it retries.
 */
export const MAX_ENROLMENTS_PER_WINDOW = 20
/** After the identity key can't be read, how long to wait before trying again (each try may prompt the Keychain). */
const KEY_RETRY_MS = 60_000

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
  /** enrol_time: this machine's clock (ms), signed with the nonce under MACHINE_CLOCK_LABEL. */
  machineTime?: number
  /**
   * Set when approved: the signer's passkeys this machine trusts, so the
   * browser knows which one to use for step-up. A hint (unsigned); a wrong
   * one only gets a step-up refused.
   */
  passkeys?: Array<{ credentialId: string; keyId: string }>
  /** device_certify only: the machine key, which the browser pins (on first use: no code). */
  machineKey?: string
}

/** Most passkeys one enrolment may add. */
export const MAX_ENROL_PASSKEYS = 3

/** A refusal the connector sends back as a relay `error` frame. */
export class EnrolmentError extends Error {
  constructor(readonly code: 'enrol_refused' | 'enrol_unavailable', message: string) {
    super(message)
    this.name = 'EnrolmentError'
  }
}

export interface MachineEnrolmentOptions {
  /** Verifies device_certify and device_revoke intents (intent-verify.ts). */
  intents?: Pick<IntentVerifier, 'checkDeviceIntent'>
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
  private keyFailedAt = 0
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
    // A relay frame must not be able to set off a Keychain read (and prompt) each time.
    if (!this.signingKey && this.now() - this.keyFailedAt >= KEY_RETRY_MS) {
      this.signingKey = loadMachineSigningKey(this.opts.identityFile, this.opts.secretStore ?? null)
      if (!this.signingKey) this.keyFailedAt = this.now()
    }
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
      // Every request counts, including ones later pushed out unrevealed: a
      // relay can compute the honest browser's code, and each commit it makes
      // is one more guess at a nonceM that gives its own key the same code.
      const windowStart = this.now() - ENROL_TTL_MS
      const attempts = (store.enrolAttempts ?? []).filter(t => Date.parse(t) > windowStart)
      if (attempts.length >= MAX_ENROLMENTS_PER_WINDOW) {
        throw refuse('Too many attempts to confirm a browser on this computer; try again in a few minutes')
      }
      store.enrolAttempts = [...attempts, new Date(this.now()).toISOString()]
      // At the limit, a new request replaces the oldest undecided one: an
      // owner who reopened the sheet a few times shouldn't be locked out for
      // ten minutes, and a relay can drop requests anyway.
      const open = store.pending.filter(p => !p.outcome).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      for (const stale of open.slice(0, Math.max(0, open.length - MAX_PENDING_ENROLMENTS + 1))) {
        store.pending = store.pending.filter(p => p !== stale)
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
    const passkeys = parsePasskeys(p.passkeys)
    const proofs = parseProofs(Array.isArray(p.passkeyProofs) ? p.passkeyProofs as unknown[] : [])
    if (!passkeys || !proofs || proofs.length !== passkeys.length) throw refuse('Malformed enrolment request')
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
      // A failed check spends the request, which stays on the list (and in
      // the per-window budget) until it expires: written back, then refused.
      const spend = (refused: string) => {
        entry.outcome = { state: 'rejected', at: new Date(this.now()).toISOString() }
        return { refused }
      }
      if (!commitment(spkiB, passkeys, label, nonceB).equals(commit)) return spend('The browser key does not match its commitment')
      // The browser's key signs the passkey proofs too, so the relay can't
      // swap in an assertion of its own (spec §6.6a).
      if (!verifyP1363(spkiB, transcript(POP_LABEL, enrolId, nonceM, encodePasskeyProofs(proofs)), pop)) {
        return spend('The browser could not prove it holds its key')
      }
      // Each passkey must prove the user's authenticator holds it, bound to
      // this browser key: the public keys came through the relay, which
      // could otherwise slip in one of its own.
      const passkeyFailure = this.checkPasskeyProofs(store, passkeys, proofs, spkiB, nonceB)
      if (passkeyFailure) return spend(passkeyFailure)
      entry.reveal = {
        spki,
        keyId: keyIdForSpki(spki),
        label,
        nonceB: nonceB.toString('base64url'),
        passkeys,
        code: shortAuthString(machineSpki, spkiB, passkeys, nonceB, nonceM),
        confirmCode: confirmationCode(machineSpki, spkiB, passkeys, nonceB, nonceM),
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
      ...(state === 'approved' ? { keyId: entry.reveal.keyId, passkeys: passkeysOf(store, userId) } : {}),
      signature: signature.toString('base64url'),
    }
  }

  /** null when every passkey's proof verifies; otherwise why not. */
  private checkPasskeyProofs(store: TrustStore, passkeys: EnrolPasskey[], proofs: PasskeyProof[], spkiB: Buffer, nonceB: Buffer): string | null {
    if (passkeys.length === 0) return null
    let origin: string
    let host: string
    try {
      const relay = new URL(store.relayOrigin)
      origin = relay.origin
      host = relay.hostname
    } catch {
      return 'This computer does not know its relay address'
    }
    const challenge = sha256(transcript(PASSKEY_PROOF_LABEL, spkiB, nonceB))
    for (let i = 0; i < passkeys.length; i++) {
      const passkey = passkeys[i]
      const proof = proofs[i]
      if (passkey.rpId !== host) return 'A passkey belongs to another site'
      if (proof.credentialId !== passkey.credentialId) return 'A passkey proof is missing'
      const failure = verifyPasskeyAssertion(proof, { challenge, origin, rpId: passkey.rpId, cosePublicKey: passkey.cosePublicKey })
      if (failure) return `A passkey could not prove it is yours (${failure})`
    }
    return null
  }

  /**
   * device_certify (spec §5.4): add a browser on the strength of an enrolled
   * passkey's user-verified assertion, without a code typed here — unless
   * the owner turned that off ("Only allow devices confirmed on this computer").
   */
  certify(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const p = (payload ?? {}) as Record<string, unknown>
    const spki = parseP256Spki(p.spki)
    const label = checkLabel(p.label)
    if (!spki || !label) throw refuse('Malformed request')
    const store = readTrustStore(this.opts.devicesFile)
    if (!store || store.machineId !== this.opts.machineId) throw new EnrolmentError('enrol_unavailable', "This computer's device list can't be used right now")
    if (store.localConfirmationOnly) throw refuse('This computer only accepts browsers confirmed on it. Use the code instead.')
    if (!this.opts.intents) throw new EnrolmentError('enrol_unavailable', 'This computer cannot check passkeys')
    const userId = this.checkPrincipal(principal, store)
    const { decision, signer } = this.opts.intents.checkDeviceIntent(principal, p.intent, DEVICE_CERTIFY_ACTION, certifyPayload(spki, label))
    if (!signer) throw refuse(`The passkey could not be checked (${decision.reason ?? 'not accepted'})`)
    // Only a passkey certifies; a browser key added by passkey can't add more.
    if (signer.kind !== 'passkey' || signer.userId !== userId) throw refuse('Only a passkey confirmed on this computer can add a browser')
    const keyId = keyIdForSpki(spki)
    const { key, spki: machineSpki } = this.machineKey()
    this.mutate(s => {
      const at = new Date(this.now()).toISOString()
      s.credentials = [...s.credentials.filter(c => c.keyId !== keyId), {
        keyId, kind: 'browser', userId, spki, label, addedAt: at, addedBy: `passkey:${signer.keyId}`,
      }]
    })
    this.opts.log?.log(`[relay] A browser ("${label}") was added by passkey. Remove it in Settings → Remote access if that wasn't you.`)
    const nonce = parseIntentNonce(p.intent)
    return {
      enrolId: `certify:${nonce}`,
      state: 'approved',
      keyId,
      machineKey: machineSpki.toString('base64url'),
      passkeys: passkeysOf(store, userId),
      signature: signP1363(key, transcript(RESULT_LABEL, `certify:${nonce}`, Buffer.from(spki, 'base64url'), 'approved')).toString('base64url'),
    }
  }

  /**
   * grant_revoke (spec §6.7): the owner revokes a share grant on this machine
   * itself, so a relay replaying the old signed grant gets nowhere.
   */
  revokeGrant(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const p = payload as { grantId?: unknown; keep?: unknown } | null
    const grantId = p?.grantId
    const keep = p?.keep
    if (typeof grantId !== 'string' || !grantId || grantId.length > 200) throw refuse('Malformed request')
    // A supersede keeps one of the share's own grants.
    if (keep !== undefined && (typeof keep !== 'string' || keep.length > 200 || !keep.startsWith(`${grantId}:`))) throw refuse('Malformed request')
    if (!this.opts.intents) throw new EnrolmentError('enrol_unavailable', 'This computer cannot check signed requests')
    const { decision, signer } = this.opts.intents.checkDeviceIntent(
      principal, (payload as { intent?: unknown }).intent, GRANT_REVOKE_ACTION, grantRevokePayload(grantId, keep), false)
    if (!signer) throw refuse(describeIntentRefusal(decision.reason))
    addRevokedGrant(keep === undefined ? { grantId } : { grantId, keep }, this.opts.devicesFile, this.opts.machineId, this.now())
    // Signed, so the owner's browser can tell the machine really has it and
    // stop retrying; a relay can't fake the confirmation.
    const { key } = this.machineKey()
    return {
      enrolId: `grant_revoke:${grantId}`,
      state: 'approved',
      signature: signP1363(key, transcript(...grantRevokedParts(grantId, keep))).toString('base64url'),
    }
  }

  /**
   * enrol_time: this machine's clock, signed over the browser's fresh nonce,
   * so the owner's browser can date share grants by a time the relay didn't
   * choose (it times the round trip itself). Harmless to anyone: it is only
   * the time.
   */
  time(payload: unknown): EnrolResult {
    const nonce = (payload as { nonce?: unknown } | null)?.nonce
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw refuse('Malformed request')
    const machineTime = this.now()
    const { key } = this.machineKey()
    return {
      enrolId: `time:${nonce}`,
      state: 'approved',
      machineTime,
      signature: signP1363(key, transcript(MACHINE_CLOCK_LABEL, nonce, String(machineTime))).toString('base64url'),
    }
  }

  /**
   * device_policy (spec §6.8): the owner raises this machine's policy from a
   * browser. It never lowers it: only local surfaces can.
   */
  raisePolicy(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const policy = (payload as { policy?: unknown } | null)?.policy
    if (!isIntentPolicy(policy)) throw refuse('Malformed request')
    if (!this.opts.intents) throw new EnrolmentError('enrol_unavailable', 'This computer cannot check signed requests')
    const { decision, signer } = this.opts.intents.checkDeviceIntent(
      principal, (payload as { intent?: unknown }).intent, POLICY_ACTION, policyPayload(policy), false)
    if (!signer) throw refuse(describeIntentRefusal(decision.reason))
    // The key first: a raise that took effect must not come back as an error.
    const { key } = this.machineKey()
    try {
      raiseIntentPolicy(policy, this.opts.devicesFile, this.opts.machineId, this.now())
    } catch (err) {
      if (err instanceof TrustStoreError && (err.code === 'invalid_policy' || err.code === 'no_credentials')) throw refuse(err.message)
      throw err
    }
    this.opts.log?.log(`[relay] This computer's policy was raised to ${policy} by a signed request.`)
    return {
      enrolId: `policy:${policy}`,
      state: 'approved',
      signature: signP1363(key, transcript(POLICY_RAISED_LABEL, policy, parseIntentNonce((payload as { intent?: unknown }).intent))).toString('base64url'),
    }
  }

  /** device_revoke (spec §5.6): remove a credential, on an owner's signed (and stepped-up) intent. */
  revoke(principal: RelayPrincipal | undefined, payload: unknown): EnrolResult {
    const keyId = (payload as { keyId?: unknown } | null)?.keyId
    if (typeof keyId !== 'string' || !keyId || keyId.length > 64) throw refuse('Malformed request')
    const nonce = parseIntentNonce((payload as { intent?: unknown }).intent)
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw refuse('Malformed request')
    const store = readTrustStore(this.opts.devicesFile)
    if (!store || store.machineId !== this.opts.machineId) throw refuse('Device list unavailable')
    this.checkPrincipal(principal, store)
    // Load the signing key before changing state. A retry can still prove
    // absence after self-revocation removed the request's signing key.
    const { key } = this.machineKey()
    if (store.credentials.some(c => c.keyId === keyId)) {
      if (!this.opts.intents) throw new EnrolmentError('enrol_unavailable', 'This computer cannot check signed requests')
      const { decision, signer } = this.opts.intents.checkDeviceIntent(principal, (payload as { intent?: unknown }).intent, DEVICE_REVOKE_ACTION, revokePayload(keyId))
      if (!signer) throw refuse(describeIntentRefusal(decision.reason))
      this.mutate(s => {
        const target = s.credentials.find(c => c.keyId === keyId)
        if (target && target.userId !== signer.userId) throw refuse('That device belongs to another account')
        s.credentials = s.credentials.filter(c => c.keyId !== keyId)
      })
      this.opts.log?.log(`[relay] A device (${keyId}) was removed from this computer by a signed request.`)
    }
    // If already absent, this is a read-only proof, not authorization to
    // mutate the store. It is safe even when the original signer is gone.
    return {
      enrolId: `revoke:${keyId}`, state: 'approved', keyId,
      signature: signP1363(key, transcript(DEVICE_REVOKED_LABEL, this.opts.machineId, keyId, nonce)).toString('base64url'),
    }
  }

  /** Dispatch one frame; throws EnrolmentError for a refusal. */
  handle(kind: string, principal: RelayPrincipal | undefined, payload: unknown): { kind: 'enrol_challenge' | 'enrol_result'; payload: EnrolChallenge | EnrolResult } {
    switch (kind) {
      case 'enrol_commit': return { kind: 'enrol_challenge', payload: this.commit(principal, payload) }
      case 'enrol_reveal': return { kind: 'enrol_result', payload: this.reveal(principal, payload) }
      case 'enrol_status': return { kind: 'enrol_result', payload: this.status(principal, payload) }
      case 'enrol_certify': return { kind: 'enrol_result', payload: this.certify(principal, payload) }
      case 'enrol_revoke': return { kind: 'enrol_result', payload: this.revoke(principal, payload) }
      case 'enrol_grant_revoke': return { kind: 'enrol_result', payload: this.revokeGrant(principal, payload) }
      case 'enrol_time': return { kind: 'enrol_result', payload: this.time(payload) }
      case 'enrol_policy': return { kind: 'enrol_result', payload: this.raisePolicy(principal, payload) }
      default: throw refuse('Unknown enrolment message')
    }
  }
}

/** Passkeys sent in a reveal: credential id, COSE key and RP ID, each bounded. Null when malformed. */
function parsePasskeys(value: unknown[]): EnrolPasskey[] | null {
  if (value.length > MAX_ENROL_PASSKEYS) return null
  const out: EnrolPasskey[] = []
  for (const v of value) {
    const p = v as Partial<EnrolPasskey> | null
    if (!p || typeof p.credentialId !== 'string' || typeof p.cosePublicKey !== 'string' || typeof p.rpId !== 'string') return null
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(p.credentialId) || !/^[A-Za-z0-9_-]{1,2048}$/.test(p.cosePublicKey) || p.rpId.length > 253) return null
    if (!coseToKey(p.cosePublicKey)) return null
    out.push({ credentialId: p.credentialId, cosePublicKey: p.cosePublicKey, rpId: p.rpId })
  }
  return out
}

type PasskeyProof = PasskeyAssertion & { credentialId: string }

/** Passkey proofs as sent, each field a bounded base64url string. Null when malformed. */
function parseProofs(value: unknown[]): PasskeyProof[] | null {
  if (value.length > MAX_ENROL_PASSKEYS) return null
  const out: PasskeyProof[] = []
  const field = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v)
  for (const v of value) {
    const p = v as Partial<PasskeyProof> | null
    if (!p || !field(p.credentialId, 1024) || !field(p.authenticatorData, 4096) || !field(p.clientDataJSON, 4096) || !field(p.signature, 2048)) return null
    out.push({ credentialId: p.credentialId, authenticatorData: p.authenticatorData, clientDataJSON: p.clientDataJSON, signature: p.signature })
  }
  return out
}

/** A user's passkeys on this machine, for the browser's step-up. */
function passkeysOf(store: TrustStore, userId: string): Array<{ credentialId: string; keyId: string }> {
  return store.credentials
    .filter((c): c is PasskeyCredential => c.kind === 'passkey' && c.userId === userId)
    .map(c => ({ credentialId: c.credentialId, keyId: c.keyId }))
}

function parseIntentNonce(intent: unknown): string {
  try {
    const nonce = (JSON.parse((intent as { body: string }).body) as { nonce?: unknown }).nonce
    return typeof nonce === 'string' ? nonce : ''
  } catch {
    return ''
  }
}

/** A browser just added, and the code the owner types in that browser to finish. */
export type ApprovedEnrolment = TrustedCredential & {
  confirmCode: string
  /** This was the owner's first device, so the machine now requires confirmed devices (§6.8). */
  policyRaised?: boolean
}

/**
 * The owner typed a code on this machine: add the browser whose request
 * produced it, and return the finishing code to show (spec §5.2, as built).
 * Throws TrustStoreError('not_found') when no waiting request has that code.
 */
export function approveEnrolment(
  input: string,
  devicesFile: string,
  machineId: string,
  now: () => number = Date.now,
): ApprovedEnrolment {
  const code = normalizeCode(input)
  if (!code) throw new TrustStoreError('not_found', 'That is not a code: it has 8 letters and digits, like K7QM-2XPA')
  return mutateTrustStore(devicesFile, machineId, store => {
    const t = now()
    let policyRaised = false
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
    // The passkeys proven in the ceremony come in with the browser.
    const passkeys: TrustedCredential[] = match.reveal.passkeys.map(p => ({
      keyId: keyIdForCoseKey(p.cosePublicKey),
      kind: 'passkey',
      userId: match.userId,
      credentialId: p.credentialId,
      cosePublicKey: p.cosePublicKey,
      rpId: p.rpId,
      label: 'Passkey',
      addedAt: at,
      addedBy: 'local',
    }))
    // Re-confirming a browser or passkey that is already listed replaces its entry.
    const added = new Set([credential.keyId, ...passkeys.map(c => c.keyId)])
    // The owner's first confirmed device turns enforcement on (§5.3, §6.8,
    // D7). Only from `off`, the default: an owner who chose `warn` keeps it.
    const firstOwnerDevice = store.ownerUserId !== null && match.userId === store.ownerUserId
      && !store.credentials.some(c => c.userId === store.ownerUserId)
    if (firstOwnerDevice && store.policy === 'off') {
      store.policy = 'required'
      policyRaised = true
    }
    store.credentials = [...store.credentials.filter(c => !added.has(c.keyId)), credential, ...passkeys]
    match.outcome = { state: 'approved', at }
    match.expiresAt = new Date(t + RESULT_TTL_MS).toISOString()
    return { ...credential, confirmCode: formatCode(match.reveal.confirmCode ?? ''), ...(policyRaised ? { policyRaised } : {}) }
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
