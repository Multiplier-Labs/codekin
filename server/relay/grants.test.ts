/** Owner-signed share grants on the machine (signed-intents spec §6.7). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GRANT_ACTION, GRANT_REVOKED_LABEL, GRANT_REVOKE_ACTION, MAX_GRANT_LIFETIME_MS, frameAction, framePayload, grantIssuedAt, grantPayload, grantRevokePayload,
  grantRevokedBy, grantRevokedParts, intentChallengeInput,
} from './intent-actions.js'
import type { GrantBody, IntentBody, SignedGrant, SignedIntent } from './intent-actions.js'
import { IntentVerifier } from './intent-verify.js'
import { MachineEnrolment } from './enrolment.js'
import { signP1363, transcript, verifyP1363 } from './enrolment-crypto.js'
import { liveChannelPolicy } from './connector.js'
import { ensureMachineIdentity, keyIdForSpki } from './machine-identity.js'
import { MAX_REVOKED_GRANTS, emptyTrustStore, readTrustStore, withRevocation, writeTrustStore } from './trust-store.js'
import type { TrustedCredential, IntentPolicy } from './trust-store.js'
import { keyIdForCoseKey } from './webauthn-verify.js'
import { softPasskey } from './__fixtures__/authenticator.js'
import type { RelayPrincipal } from './relay-protocol.js'

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  return { spki, keyId: keyIdForSpki(spki), privateKey: privateKey as KeyObject }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64url')

function sign(k: ReturnType<typeof key>, fields: Partial<IntentBody> & { action: string; payload: Uint8Array }): SignedIntent {
  const { payload, ...rest } = fields
  const body = JSON.stringify({
    v: 1, machineId: 'm1', sessionId: null, nonce: randomBytes(16).toString('base64url'), ts: Date.now(), keyId: k.keyId, payloadHash: sha(payload), ...rest,
  })
  return { body, sig: signP1363(k.privateKey, Buffer.from(body)).toString('base64url') }
}

describe('signed share grants on the machine', () => {
  let dir: string
  let devicesFile: string
  let verifier: IntentVerifier
  let owner: ReturnType<typeof key>
  let dana: ReturnType<typeof key>
  let danaPrincipal: (signedGrants: SignedGrant[], grants?: Record<string, string[]>) => RelayPrincipal

  function store(policy: IntentPolicy, extra: TrustedCredential[] = []) {
    writeTrustStore(devicesFile, {
      ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'),
      policy,
      credentials: [{ keyId: owner.keyId, kind: 'browser', userId: 'u-owner', spki: owner.spki, label: 'Owner', addedAt: 'x', addedBy: 'local' }, ...extra],
    })
  }

  function grant(overrides: Partial<GrantBody> = {}, signer = owner, intentOverrides: Partial<IntentBody> = {}): SignedGrant {
    const body: GrantBody = {
      grantId: 'g1', sessionId: 's1', granteeUserId: 'u-dana', permissions: ['view', 'send_prompt'],
      granteeKeys: [{ keyId: dana.keyId, spki: dana.spki }], expiresAt: Date.now() + 24 * 60 * 60_000, ...overrides,
    }
    const text = JSON.stringify(body)
    return { grant: text, intent: sign(signer, { action: GRANT_ACTION, sessionId: body.sessionId, payload: grantPayload(text), ...intentOverrides }) }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-grants-'))
    devicesFile = join(dir, 'relay-devices.json')
    owner = key()
    dana = key()
    store('required')
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile })
    danaPrincipal = (signedGrants, grants = { s1: ['view', 'send_prompt', 'upload_file'] }) => ({ userId: 'u-dana', role: 'grantee', grants, signedGrants })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('uses what the relay says and the owner signed, nothing more', () => {
    const principal = danaPrincipal([grant()], { s1: ['view', 'send_prompt', 'upload_file'], s2: ['view'] })
    // upload_file wasn't signed; s2 has no grant at all.
    expect(verifier.effectivePrincipal(principal)?.grants).toEqual({ s1: ['view', 'send_prompt'] })
  })

  it('gives a fabricated grantee nothing', () => {
    const relayKey = key()
    expect(verifier.effectivePrincipal(danaPrincipal([grant({}, relayKey)]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([]))?.grants).toEqual({})
  })

  it('ignores grants that are expired, too long, for someone else, tampered, or for another machine', () => {
    const cases: SignedGrant[] = [
      grant({ expiresAt: Date.now() - 1 }),
      grant({ expiresAt: Date.now() + MAX_GRANT_LIFETIME_MS + 10 * 60_000 }),
      grant({ granteeUserId: 'u-other' }),
      { ...grant(), grant: JSON.stringify({ ...JSON.parse(grant().grant) as GrantBody, permissions: ['view', 'send_prompt', 'approve_shell'] }) },
      grant({}, owner, { machineId: 'm2' }),
      grant({}, owner, { action: 'grant_other' }),
      grant({ granteeKeys: [{ keyId: 'wrong', spki: dana.spki }] }),
    ]
    for (const g of cases) expect(verifier.effectivePrincipal(danaPrincipal([g]))?.grants).toEqual({})
  })

  it('accepts a grantee frame only from a key the grant names, for that session', () => {
    const principal = danaPrincipal([grant()])
    const token = randomBytes(16).toString('base64url')
    const opened = verifier.checkChannelOpen(principal, sign(dana, { action: 'channel:open', payload: new Uint8Array(), channel: token }))
    expect(opened.decision.verdict).toBe('accepted')
    const join = '{"type":"join_session","sessionId":"s1"}'
    expect(verifier.checkFrame(principal, join, sign(dana, { action: frameAction(join), payload: framePayload(join), sessionId: 's1', channel: token, seq: 1 }), opened.channel).verdict).toBe('accepted')
    const input = '{"type":"input","data":"hi"}'
    const stranger = key()
    expect(verifier.checkFrame(principal, input, sign(stranger, { action: frameAction(input), payload: framePayload(input), sessionId: 's1', channel: token, seq: 2 }), opened.channel).reason)
      .toBe('intent_unknown_key')
    // Another session the grant doesn't cover: no key there.
    const other = '{"type":"join_session","sessionId":"s9"}'
    expect(verifier.checkFrame(principal, other, sign(dana, { action: frameAction(other), payload: framePayload(other), sessionId: 's9', channel: token, seq: 3 }), opened.channel).reason)
      .toBe('intent_unknown_key')
  })

  it('drops every grant a revoked owner key signed, at once', () => {
    const principal = danaPrincipal([grant()])
    expect(verifier.effectivePrincipal(principal)?.grants).toEqual({ s1: ['view', 'send_prompt'] })
    const other = key()
    store('required', [])
    writeTrustStore(devicesFile, { ...readTrustStore(devicesFile)!, credentials: [{ keyId: other.keyId, kind: 'browser', userId: 'u-owner', spki: other.spki, label: 'Other', addedAt: 'x', addedBy: 'local' }] })
    expect(verifier.effectivePrincipal(principal)?.grants).toEqual({})
  })

  it('needs the owner passkey for a grant that approves shell commands, when one is enrolled', () => {
    const passkey = softPasskey()
    store('required', [{
      keyId: keyIdForCoseKey(passkey.cosePublicKey), kind: 'passkey', userId: 'u-owner', credentialId: passkey.credentialId,
      cosePublicKey: passkey.cosePublicKey, rpId: 'relay.test', label: 'Passkey', addedAt: 'x', addedBy: 'local',
    }])
    const shell = grant({ permissions: ['view', 'approve_shell'] })
    expect(verifier.effectivePrincipal(danaPrincipal([shell], { s1: ['view', 'approve_shell'] }))?.grants).toEqual({})
    // The same grant signed with the passkey counts.
    const text = shell.grant
    const body = JSON.stringify({
      v: 1, machineId: 'm1', sessionId: 's1', action: GRANT_ACTION, nonce: randomBytes(16).toString('base64url'), ts: Date.now(),
      keyId: keyIdForCoseKey(passkey.cosePublicKey), payloadHash: sha(grantPayload(text)),
    })
    const viaPasskey: SignedGrant = { grant: text, intent: { body, webauthn: { credentialId: passkey.credentialId, ...passkey.assert(createHash('sha256').update(intentChallengeInput(body)).digest()) } } }
    expect(verifier.effectivePrincipal(danaPrincipal([viaPasskey], { s1: ['view', 'approve_shell'] }))?.grants).toEqual({ s1: ['view', 'approve_shell'] })
  })

  it('keeps a grant the owner revoked on the machine revoked, whatever the relay sends', () => {
    const identityFile = join(dir, 'relay-identity.json')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    const enrolment = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    const ownerPrincipal: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
    // Only the owner can revoke.
    expect(() => enrolment.revokeGrant({ userId: 'u-dana', role: 'grantee', grants: {} }, {
      grantId: 'g1', intent: sign(dana, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1') }),
    })).toThrow()
    enrolment.revokeGrant(ownerPrincipal, { grantId: 'g1', intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1') }) })
    expect(readTrustStore(devicesFile)?.revokedGrants.map(g => g.grantId)).toEqual(['g1'])
    expect(verifier.effectivePrincipal(danaPrincipal([grant()]))?.grants).toEqual({})
  })

  it('never lets a grant run past its signed notAfter', () => {
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ notAfter: Date.now() + 1000, expiresAt: Date.now() + 5 * 60_000 })]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ notAfter: Date.now() + 10 * 60_000, expiresAt: Date.now() + 5 * 60_000 })]))?.grants)
      .toEqual({ s1: ['view', 'send_prompt'] })
  })

  it('prefers the most recently signed grant for a session, so narrowing takes', () => {
    const broad = grant({ grantId: 'g1:a', expiresAt: Date.now() + 20 * 24 * 60 * 60_000 }, owner, { ts: Date.now() - 60_000 })
    const narrow = grant({ grantId: 'g1:b', permissions: ['view'], expiresAt: Date.now() + 24 * 60 * 60_000 })
    expect(verifier.effectivePrincipal(danaPrincipal([broad, narrow]))?.grants).toEqual({ s1: ['view'] })
    expect(verifier.effectivePrincipal(danaPrincipal([narrow, broad]))?.grants).toEqual({ s1: ['view'] })
  })

  it('confirms a revocation with the machine key, so the owner can stop retrying', () => {
    const identityFile = join(dir, 'relay-identity.json')
    const identity = ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    const enrolment = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    const result = enrolment.revokeGrant({ userId: 'u-owner', role: 'owner', grants: {} }, {
      grantId: 'g1:a', intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1:a') }),
    })
    expect(verifyP1363(Buffer.from(identity.publicKey, 'base64url'), transcript(GRANT_REVOKED_LABEL, 'g1:a'), Buffer.from(result.signature!, 'base64url'))).toBe(true)
  })

  it('stops an open channel acting on a grant revoked after it opened', () => {
    const principal = danaPrincipal([grant()])
    const policy = liveChannelPolicy(principal, verifier)
    expect(policy.grants).toEqual({ s1: ['view', 'send_prompt'] })
    const current = readTrustStore(devicesFile)!
    writeTrustStore(devicesFile, { ...current, revokedGrants: [{ grantId: 'g1', at: new Date().toISOString() }] })
    expect(policy.grants).toEqual({})
  })

  it('revokes every grant signed for a share when its id is revoked, and nothing else', () => {
    const current = readTrustStore(devicesFile)!
    writeTrustStore(devicesFile, { ...current, revokedGrants: [{ grantId: 'g1', at: new Date().toISOString() }] })
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: 'g1:k2x9' })]))?.grants).toEqual({})
    // A different share whose id merely starts the same way is untouched.
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: 'g10:aa' })]))?.grants).toEqual({ s1: ['view', 'send_prompt'] })
  })

  it('leaves the relay word standing outside required, where unsigned traffic goes through anyway', () => {
    store('warn')
    const principal = danaPrincipal([])
    expect(verifier.effectivePrincipal(principal)).toBe(principal)
  })

  /** A grant id as the owner's browser issues them: `<share>:<ms base 36><8 hex>`. */
  const issued = (share: string, at: number) => `${share}:${at.toString(36)}0123abcd`

  it('orders a share\'s grants by issue, so renewing a broader one never overtakes a narrowing', () => {
    const t = Date.now()
    // Issued first, renewed just now; the narrowing was issued later but signed earlier.
    const broad = grant({ grantId: issued('g1', t - 60_000) })
    const narrow = grant({ grantId: issued('g1', t - 30_000), permissions: ['view'] }, owner, { ts: t - 30_000 })
    expect(verifier.effectivePrincipal(danaPrincipal([broad, narrow]))?.grants).toEqual({ s1: ['view'] })
    expect(verifier.effectivePrincipal(danaPrincipal([narrow, broad]))?.grants).toEqual({ s1: ['view'] })
  })

  it('supersedes a share\'s earlier grants on the owner\'s word, keeping later ones, and confirms it', () => {
    const identityFile = join(dir, 'relay-identity.json')
    const identity = ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })
    const enrolment = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    const ownerPrincipal: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
    const t = Date.now()
    const [old, kept, later] = [issued('g1', t - 2000), issued('g1', t - 1000), issued('g1', t)]
    // The kept grant must belong to the share; the intent must cover it.
    expect(() => enrolment.revokeGrant(ownerPrincipal, { grantId: 'g1', keep: 'g2:x', intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1', 'g2:x') }) })).toThrow()
    expect(() => enrolment.revokeGrant(ownerPrincipal, { grantId: 'g1', keep: kept, intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1') }) })).toThrow()
    const result = enrolment.revokeGrant(ownerPrincipal, { grantId: 'g1', keep: kept, intent: sign(owner, { action: GRANT_REVOKE_ACTION, payload: grantRevokePayload('g1', kept) }) })
    expect(verifyP1363(Buffer.from(identity.publicKey, 'base64url'), transcript(...grantRevokedParts('g1', kept)), Buffer.from(result.signature!, 'base64url'))).toBe(true)
    // A full-revocation confirmation is not a supersede confirmation, and vice versa.
    expect(verifyP1363(Buffer.from(identity.publicKey, 'base64url'), transcript(GRANT_REVOKED_LABEL, 'g1'), Buffer.from(result.signature!, 'base64url'))).toBe(false)
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: old })]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: 'g1' })]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: kept })]))?.grants).toEqual({ s1: ['view', 'send_prompt'] })
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: later })]))?.grants).toEqual({ s1: ['view', 'send_prompt'] })
  })

  it('reads issue times only from well-formed ids, and treats any other as superseded', () => {
    const t = 1_790_000_000_000
    expect(grantIssuedAt(issued('g1', t), 'g1')).toBe(t)
    expect(grantIssuedAt('g1:a', 'g1')).toBeNull()
    expect(grantIssuedAt(issued('g1', t), 'g2')).toBeNull()
    const supersede = { grantId: 'g1', keep: issued('g1', t) }
    expect(grantRevokedBy('g1:a', supersede)).toBe(true)
    expect(grantRevokedBy(issued('g1', t + 1), supersede)).toBe(false)
    expect(grantRevokedBy(issued('g10', t - 1), supersede)).toBe(false)
  })

  it('keeps one revocation per share, the broadest, and never lets one lapse', () => {
    const t = Date.now()
    let list = withRevocation([], { grantId: 'g1', keep: issued('g1', t) }, t)
    list = withRevocation(list, { grantId: 'g1', keep: issued('g1', t - 5) }, t)
    expect(list).toMatchObject([{ grantId: 'g1', keep: issued('g1', t) }])
    list = withRevocation(list, { grantId: 'g1', keep: issued('g1', t + 5) }, t)
    expect(list).toMatchObject([{ grantId: 'g1', keep: issued('g1', t + 5) }])
    list = withRevocation(list, { grantId: 'g1' }, t)
    expect(list).toEqual([{ grantId: 'g1', at: new Date(t).toISOString() }])
    // A supersede after a full revocation changes nothing; a year on, it is still there.
    list = withRevocation(list, { grantId: 'g1', keep: issued('g1', t + 9) }, t)
    list = withRevocation(list, { grantId: 'g2' }, t + 365 * 24 * 60 * 60_000)
    expect(list.map(r => [r.grantId, r.keep])).toEqual([['g1', undefined], ['g2', undefined]])
  })

  it('refuses a grant whose issue time runs ahead of its signing (a fast clock would outrank later grants)', () => {
    const t = Date.now()
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: issued('g1', t + 60 * 60_000) })]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([grant({ grantId: issued('g1', t + 60_000) })]))?.grants).toEqual({ s1: ['view', 'send_prompt'] })
  })

  it('refuses a new revocation when full rather than dropping an old one', () => {
    const full = Array.from({ length: MAX_REVOKED_GRANTS }, (_, i) => ({ grantId: `s${i}`, at: 'x' }))
    expect(() => withRevocation(full, { grantId: 'new' })).toThrow(/too many/)
    // Coalescing into an existing share still works.
    expect(withRevocation(full, { grantId: 's1' })).toBe(full)
  })
})
