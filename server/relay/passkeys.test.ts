/**
 * Passkeys on the machine (signed-intents spec §5.2 passkeys, §5.4
 * device_certify, §5.6 device_revoke, §6.6 step-up), with a software
 * authenticator standing in for the user's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MachineEnrolment, approveEnrolment } from './enrolment.js'
import { POP_LABEL, commitment, shortAuthString, signP1363, transcript } from './enrolment-crypto.js'
import type { EnrolPasskey } from './enrolment-crypto.js'
import {
  DEVICE_CERTIFY_ACTION, DEVICE_REVOKE_ACTION, PASSKEY_ANY, PASSKEY_PROOF_LABEL, certifyPayload, frameAction, framePayload,
  encodePasskeyProofs, frameNeedsStepUp, intentChallengeInput, requestNeedsStepUp, revokePayload,
} from './intent-actions.js'
import type { IntentBody, SignedIntent } from './intent-actions.js'
import { IntentVerifier } from './intent-verify.js'
import { IntentLog, readRecentIntents } from './intent-log.js'
import { ensureMachineIdentity, keyIdForSpki } from './machine-identity.js'
import { emptyTrustStore, readTrustStore, setLocalConfirmationOnly, writeTrustStore } from './trust-store.js'
import { keyIdForCoseKey } from './webauthn-verify.js'
import { softPasskey } from './__fixtures__/authenticator.js'
import type { SoftPasskey } from './__fixtures__/authenticator.js'
import type { RelayPrincipal } from './relay-protocol.js'

const OWNER: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
const quiet = { log: vi.fn(), warn: vi.fn() }
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

function browserKey(label = 'Safari · iPhone') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return { spki, spkiB64: spki.toString('base64url'), keyId: keyIdForSpki(spki.toString('base64url')), privateKey: privateKey as KeyObject, label }
}

describe('passkeys on the machine', () => {
  let dir: string
  let devicesFile: string
  let logFile: string
  let verifier: IntentVerifier
  let enrolment: MachineEnrolment
  let passkey: SoftPasskey

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-passkeys-'))
    const identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    logFile = join(dir, 'intents.jsonl')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: quiet })
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required' })
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile, log: new IntentLog(logFile) })
    enrolment = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, log: quiet, intents: verifier })
    passkey = softPasskey()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Enrol a browser and, with proof, a passkey; returns the browser key. */
  function enrolWithPasskey(pk: SoftPasskey = passkey, offered?: EnrolPasskey, swapProof?: (proof: Record<string, string>) => Record<string, string>[]) {
    const b = browserKey()
    const nonceB = randomBytes(32)
    const P: EnrolPasskey[] = [offered ?? { credentialId: pk.credentialId, cosePublicKey: pk.cosePublicKey, rpId: 'relay.test' }]
    const proof = { credentialId: P[0].credentialId, ...pk.assert(sha256(transcript(PASSKEY_PROOF_LABEL, b.spki, nonceB))) }
    const proofs = swapProof?.(proof)
    const ch = enrolment.commit(OWNER, { commit: commitment(b.spki, P, b.label, nonceB).toString('base64url') })
    const nonceM = Buffer.from(ch.nonceM, 'base64url')
    enrolment.reveal(OWNER, {
      enrolId: ch.enrolId, spki: b.spkiB64, passkeys: P, passkeyProofs: [proof], label: b.label, nonceB: nonceB.toString('base64url'),
      // The browser signs over the proof it made; a relay may swap what is sent.
      pop: signP1363(b.privateKey, transcript(POP_LABEL, ch.enrolId, nonceM, encodePasskeyProofs([proof]))).toString('base64url'),
      ...(proofs ? { passkeyProofs: proofs } : {}),
    })
    approveEnrolment(shortAuthString(Buffer.from(ch.machineKey, 'base64url'), b.spki, P, nonceB, nonceM), devicesFile, 'm1')
    return { b, enrolId: ch.enrolId }
  }

  /** A passkey-signed intent: the assertion's challenge is SHA-256(body). */
  function passkeyIntent(fields: Partial<IntentBody> & { action: string; payload: Uint8Array }, pk: SoftPasskey = passkey, keyId?: string): SignedIntent {
    const { payload, ...rest } = fields
    const body = JSON.stringify({
      v: 1, machineId: 'm1', sessionId: null, nonce: randomBytes(16).toString('base64url'), ts: Date.now(),
      keyId: keyId ?? keyIdForCoseKey(pk.cosePublicKey), payloadHash: sha256(payload).toString('base64url'), ...rest,
    } satisfies Partial<IntentBody>)
    return { body, webauthn: { credentialId: pk.credentialId, ...pk.assert(sha256(intentChallengeInput(body))) } }
  }

  function browserIntent(b: ReturnType<typeof browserKey>, fields: Partial<IntentBody> & { action: string; payload: Uint8Array }): SignedIntent {
    const { payload, ...rest } = fields
    const body = JSON.stringify({
      v: 1, machineId: 'm1', sessionId: null, nonce: randomBytes(16).toString('base64url'), ts: Date.now(),
      keyId: b.keyId, payloadHash: sha256(payload).toString('base64url'), ...rest,
    } satisfies Partial<IntentBody>)
    return { body, sig: signP1363(b.privateKey, Buffer.from(body)).toString('base64url') }
  }

  it('enrols a passkey with the browser, after proof the user holds it', () => {
    enrolWithPasskey()
    const store = readTrustStore(devicesFile)!
    expect(store.credentials.map(c => c.kind).sort()).toEqual(['browser', 'passkey'])
    expect(store.credentials.find(c => c.kind === 'passkey')).toMatchObject({ credentialId: passkey.credentialId, rpId: 'relay.test', addedBy: 'local' })
  })

  it('refuses a passkey public key the relay slipped in', () => {
    // The relay lists its own key under the user's credential id.
    const relays = softPasskey()
    expect(() => enrolWithPasskey(passkey, { credentialId: passkey.credentialId, cosePublicKey: relays.cosePublicKey, rpId: 'relay.test' }))
      .toThrow(/could not prove/)
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
  })

  it('refuses a passkey proof the relay swapped after the browser signed it', () => {
    // The relay lists its own key, then replaces the user's assertion with one of its own.
    const relays = softPasskey()
    const offered = { credentialId: passkey.credentialId, cosePublicKey: relays.cosePublicKey, rpId: 'relay.test' }
    let swapped: Record<string, string>[] = []
    // The browser signs over the real proof; the relay sends a different one.
    expect(() => enrolWithPasskey(passkey, offered, proof => {
      swapped = [{ ...proof, ...relays.assert(Buffer.from(JSON.parse(Buffer.from(proof.clientDataJSON, 'base64url').toString()).challenge, 'base64url')) }]
      return swapped
    })).toThrow(/prove it holds its key/)
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
  })

  it('refuses a passkey for another site', () => {
    const elsewhere = softPasskey('ES256', { origin: 'https://evil.test', rpId: 'evil.test' })
    expect(() => enrolWithPasskey(elsewhere, { credentialId: elsewhere.credentialId, cosePublicKey: elsewhere.cosePublicKey, rpId: 'evil.test' }))
      .toThrow(/another site/)
  })

  it('tells the browser which passkeys to use for step-up', () => {
    const { enrolId } = enrolWithPasskey()
    expect(enrolment.status(OWNER, { enrolId }).passkeys).toEqual([{ credentialId: passkey.credentialId, keyId: keyIdForCoseKey(passkey.cosePublicKey) }])
  })

  it('adds a new browser on a passkey assertion (device_certify), marked as such', () => {
    enrolWithPasskey()
    const phone = browserKey('Chrome · Android')
    const intent = passkeyIntent({ action: DEVICE_CERTIFY_ACTION, payload: certifyPayload(phone.spkiB64, phone.label) }, passkey, PASSKEY_ANY)
    const result = enrolment.certify(OWNER, { spki: phone.spkiB64, label: phone.label, intent })
    expect(result).toMatchObject({ state: 'approved', keyId: phone.keyId })
    expect(result.machineKey).toBeDefined()
    expect(readTrustStore(devicesFile)?.credentials.find(c => c.keyId === phone.keyId))
      .toMatchObject({ kind: 'browser', addedBy: `passkey:${keyIdForCoseKey(passkey.cosePublicKey)}` })
    // The intent can't add a different key than the one it names.
    const other = browserKey('Other')
    const replay = passkeyIntent({ action: DEVICE_CERTIFY_ACTION, payload: certifyPayload(phone.spkiB64, phone.label) }, passkey, PASSKEY_ANY)
    expect(() => enrolment.certify(OWNER, { spki: other.spkiB64, label: other.label, intent: replay })).toThrow(/intent_wrong_payload/)
  })

  it('refuses device_certify when the owner allows only devices confirmed here', () => {
    enrolWithPasskey()
    setLocalConfirmationOnly(true, devicesFile, 'm1')
    const phone = browserKey()
    const intent = passkeyIntent({ action: DEVICE_CERTIFY_ACTION, payload: certifyPayload(phone.spkiB64, phone.label) }, passkey, PASSKEY_ANY)
    expect(() => enrolment.certify(OWNER, { spki: phone.spkiB64, label: phone.label, intent })).toThrow(/only accepts browsers confirmed/)
  })

  it('refuses device_certify signed by a browser key, or by an unknown passkey', () => {
    const { b } = enrolWithPasskey()
    const phone = browserKey()
    const byBrowser = browserIntent(b, { action: DEVICE_CERTIFY_ACTION, payload: certifyPayload(phone.spkiB64, phone.label) })
    expect(() => enrolment.certify(OWNER, { spki: phone.spkiB64, label: phone.label, intent: byBrowser })).toThrow(/intent_step_up_required/)
    const stranger = softPasskey()
    const byStranger = passkeyIntent({ action: DEVICE_CERTIFY_ACTION, payload: certifyPayload(phone.spkiB64, phone.label) }, stranger, PASSKEY_ANY)
    expect(() => enrolment.certify(OWNER, { spki: phone.spkiB64, label: phone.label, intent: byStranger })).toThrow(/intent_unknown_key/)
  })

  it('removes a device on a signed device_revoke, stepped up when a passkey is enrolled', () => {
    const { b } = enrolWithPasskey()
    const byBrowser = browserIntent(b, { action: DEVICE_REVOKE_ACTION, payload: revokePayload(b.keyId) })
    expect(() => enrolment.revoke(OWNER, { keyId: b.keyId, intent: byBrowser })).toThrow(/passkey/)
    const byPasskey = passkeyIntent({ action: DEVICE_REVOKE_ACTION, payload: revokePayload(b.keyId) })
    expect(enrolment.revoke(OWNER, { keyId: b.keyId, intent: byPasskey })).toMatchObject({ state: 'approved', keyId: b.keyId })
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.kind)).toEqual(['passkey'])
    expect(() => enrolment.revoke(OWNER, { keyId: b.keyId, intent: passkeyIntent({ action: DEVICE_REVOKE_ACTION, payload: revokePayload(b.keyId) }) }))
      .toThrow(/not on this computer/)
  })

  describe('step-up for privileged actions', () => {
    const always = '{"type":"prompt_response","value":"always_allow","requestId":"r1"}'
    const once = '{"type":"prompt_response","value":"allow","requestId":"r1"}'

    function channel() {
      const token = randomBytes(16).toString('base64url')
      return { token, seq: 0 }
    }

    it('knows which actions are privileged, however they are spelled', () => {
      const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
      expect(frameNeedsStepUp('{"type":"set_permission_mode","permissionMode":"dangerouslySkipPermissions"}')).toBe(true)
      expect(requestNeedsStepUp('POST', '/API/Sessions/Create/', json({ permissionMode: 'bypassPermissions' }))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/sessions/create', json({ permissionMode: 'dangerouslySkipPermissions' }))).toBe(true)
      // A body this can't read (another charset) counts as privileged.
      expect(requestNeedsStepUp('POST', '/api/sessions/create', new Uint8Array([0xff, 0xfe, 0x7b, 0x00]))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/orchestrator/sessions/s1/respond', json({ value: 'always_allow' }))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/orchestrator/sessions/s1/respond', json({ value: 'allow' }))).toBe(false)
      // Pre-approved tools are a standing rule too.
      expect(frameNeedsStepUp('{"type":"create_session","name":"n","workingDir":"/w","allowedTools":["Bash"]}')).toBe(true)
      expect(frameNeedsStepUp('{"type":"create_session","name":"n","workingDir":"/w","allowedTools":[]}')).toBe(false)
      expect(requestNeedsStepUp('POST', '/api/sessions/create', json({ allowedTools: ['Bash'] }))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/orchestrator/children', json({ repo: 'r', task: 't', allowedTools: ['Bash'] }))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/orchestrator/children', json({ repo: 'r', task: 't' }))).toBe(false)
    })

    it('knows which actions are privileged', () => {
      expect(frameNeedsStepUp(always)).toBe(true)
      expect(frameNeedsStepUp('{"type":"prompt_response","value":["approve_pattern"]}')).toBe(true)
      expect(frameNeedsStepUp(once)).toBe(false)
      expect(frameNeedsStepUp('{"type":"set_permission_mode","permissionMode":"bypassPermissions"}')).toBe(true)
      expect(frameNeedsStepUp('{"type":"set_permission_mode","permissionMode":"default"}')).toBe(false)
      expect(frameNeedsStepUp('{"type":"create_session","permissionMode":"bypassPermissions"}')).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/sessions/create', new TextEncoder().encode('{"permissionMode":"bypassPermissions"}'))).toBe(true)
      expect(requestNeedsStepUp('POST', '/api/sessions/create', new TextEncoder().encode('{}'))).toBe(false)
    })

    it('needs the passkey when one is enrolled, and says which; logs how each was confirmed', () => {
      const { b } = enrolWithPasskey()
      const ch = channel()
      const opened = verifier.checkChannelOpen(OWNER, browserIntent(b, { action: 'channel:open', payload: new Uint8Array(), channel: ch.token }))
      const sign = (frame: string, viaPasskey = false) => {
        const fields = { action: frameAction(frame), payload: framePayload(frame), channel: ch.token, seq: ++ch.seq }
        return viaPasskey ? passkeyIntent(fields) : browserIntent(b, fields)
      }
      expect(verifier.checkFrame(OWNER, once, sign(once), opened.channel).verdict).toBe('accepted')
      const refused = verifier.checkFrame(OWNER, always, sign(always), opened.channel)
      expect(refused).toMatchObject({ forward: false, reason: 'intent_step_up_required' })
      expect(refused.stepUpPasskeys).toEqual([{ credentialId: passkey.credentialId, keyId: keyIdForCoseKey(passkey.cosePublicKey) }])
      expect(verifier.checkFrame(OWNER, always, sign(always, true), opened.channel)).toMatchObject({ forward: true, verdict: 'accepted' })
      const log = readRecentIntents(logFile, { limit: 10 }).reverse()
      expect(log.at(-1)).toMatchObject({ action: 'ws:prompt_response', stepUp: 'passkey', verdict: 'accepted' })
      expect(log.at(-1)?.intent?.webauthn?.credentialId).toBe(passkey.credentialId)
    })

    it('accepts the browser key without a passkey enrolled, and logs it as the weaker step-up', () => {
      const b = browserKey()
      writeTrustStore(devicesFile, {
        ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required',
        credentials: [{ keyId: b.keyId, kind: 'browser', userId: 'u-owner', spki: b.spkiB64, label: 'x', addedAt: 'x', addedBy: 'local' }],
      })
      const ch = channel()
      const opened = verifier.checkChannelOpen(OWNER, browserIntent(b, { action: 'channel:open', payload: new Uint8Array(), channel: ch.token }))
      const intent = browserIntent(b, { action: frameAction(always), payload: framePayload(always), channel: ch.token, seq: 1 })
      expect(verifier.checkFrame(OWNER, always, intent, opened.channel).verdict).toBe('accepted')
      expect(readRecentIntents(logFile, { limit: 1 })[0]).toMatchObject({ stepUp: 'browser-key' })

      // The workspace can require a passkey regardless.
      verifier.setRequirePasskey(true)
      const again = browserIntent(b, { action: frameAction(always), payload: framePayload(always), channel: ch.token, seq: 2 })
      expect(verifier.checkFrame(OWNER, always, again, opened.channel).reason).toBe('intent_step_up_required')
    })
  })
})
