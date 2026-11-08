/**
 * Share grants between the owner's browser, the grantee's browser and the
 * machine (signed-intents spec §6.7), including what a relay that lies about
 * shares can and can't get the owner's browser to sign.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const who = vi.hoisted(() => ({ id: 'u-owner' }))
vi.mock('./deviceTrust', async importOriginal => ({
  ...(await importOriginal<typeof import('./deviceTrust')>()),
  currentUserId: () => Promise.resolve(who.id),
}))
vi.mock('./workspace', () => ({ workspaceHeaders: () => ({}) }))

import {
  flushRevocations, machineClockOffset, proposeGrant, recordShare, renewGrants, revokeShareGrants, signGrant,
  type GranteeKey, type GrantTransport, type ShareWithGrant,
} from './grants'
import { getOrCreateBrowserKey, type BrowserKey, type IssuedGrant, type MachinePin, type PendingRevocation, type TrustStorage } from './deviceTrust'
import { createIntentSigner } from './intentSigner'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { MachineEnrolment } from '../../server/relay/enrolment'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { addRevokedGrant, emptyTrustStore, readTrustStore, writeTrustStore, type TrustStore } from '../../server/relay/trust-store'
import { frameAction, framePayload, grantIssuedAt } from '../../server/relay/intent-actions'
import type { GrantBody, SignedGrant } from '../../server/relay/intent-actions'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

function memoryStorage(): TrustStorage & { revocations: Map<string, PendingRevocation[]>; issued: Map<string, IssuedGrant[]> } {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  const revocations = new Map<string, PendingRevocation[]>()
  const issued = new Map<string, IssuedGrant[]>()
  return {
    revocations,
    issued,
    getIssuedGrants: async (u, m) => structuredClone(issued.get(`${u}:${m}`) ?? []),
    putIssuedGrants: async (u, m, list) => { issued.set(`${u}:${m}`, structuredClone(list)) },
    getKey: async id => keys.get(id),
    putKey: async k => { keys.set(k.userId, k) },
    getPin: async (u, m) => pins.get(`${u}:${m}`),
    putPin: async p => { pins.set(`${p.userId}:${p.machineId}`, p) },
    deletePin: async (u, m) => { pins.delete(`${u}:${m}`) },
    getRevocations: async (u, m) => revocations.get(`${u}:${m}`) ?? [],
    putRevocations: async (u, m, ids) => { revocations.set(`${u}:${m}`, ids) },
  }
}

const DAY = 24 * 60 * 60_000
const EDITOR = ['view', 'view_diff', 'send_prompt', 'upload_file', 'approve_readonly_tool']

describe('share grants from the browser to the machine', () => {
  let dir: string
  let devicesFile: string
  let verifier: IntentVerifier
  let transport: GrantTransport
  let ownerStorage: ReturnType<typeof memoryStorage>
  let danaKey: BrowserKey
  let danaStorage: TrustStorage
  let devices: GranteeKey[]
  let share: ShareWithGrant
  let machineDown = false
  let machine: MachineEnrolment

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-grants-browser-'))
    const identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    const identity = ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })

    who.id = 'u-owner'
    ownerStorage = memoryStorage()
    const ownerKey = await getOrCreateBrowserKey('u-owner', ownerStorage)
    await ownerStorage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: identity.publicKey, keyId: ownerKey.keyId, pinnedAt: 'x', via: 'code' })
    writeTrustStore(devicesFile, {
      ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required',
      credentials: [{ keyId: ownerKey.keyId, kind: 'browser', userId: 'u-owner', spki: ownerKey.spki, label: 'Owner', addedAt: 'x', addedBy: 'local' }],
    })
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile })
    machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    const ownerSigner = createIntentSigner('m1', ownerStorage)
    const ownerPrincipal: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
    machineDown = false
    transport = {
      signIntent: intent => ownerSigner.sign(intent) as ReturnType<GrantTransport['signIntent']>,
      sendDeviceFrame: async (kind, payload) => {
        if (machineDown) throw new Error('machine offline')
        return machine.handle(kind, ownerPrincipal, JSON.parse(JSON.stringify(payload))).payload
      },
    }

    danaStorage = memoryStorage()
    danaKey = await getOrCreateBrowserKey('u-dana', danaStorage)
    devices = [{ keyId: danaKey.keyId, spki: danaKey.spki, label: 'Pixel Chrome', lastSeenAt: null }]
    share = { id: 'g1', machineId: 'm1', localSessionId: 's1', granteeUserId: 'u-dana', permissions: EDITOR, expiresAt: null, signedGrant: null }

    // The relay: stores what is PUT and lists it back.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/grant') && init?.method === 'PUT') {
        const signed = JSON.parse(String(init.body)) as SignedGrant
        const g = JSON.parse(signed.grant) as GrantBody
        share = { ...share, signedGrantRaw: signed, signedGrant: { expiresAt: g.expiresAt, permissions: g.permissions, keyIds: g.granteeKeys.map(k => k.keyId) } }
        return new Response(JSON.stringify({ share }), { status: 200 })
      }
      if (url.includes('/grantee-keys')) return new Response(JSON.stringify({ keys: devices }))
      if (url.endsWith('/api/shares')) return new Response(JSON.stringify({ shared: [share] }))
      return new Response('{}', { status: 404 })
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  const stored = (): SignedGrant[] => share.signedGrantRaw ? [share.signedGrantRaw as SignedGrant] : []
  const danaPrincipal = (signed = stored(), grants: Record<string, string[]> = { s1: EDITOR }): RelayPrincipal =>
    ({ userId: 'u-dana', role: 'grantee', grants, signedGrants: signed })

  /** Share, as the dialog does: record the owner's choice, then sign what is proposed. */
  async function shareAs(role: 'viewer' | 'editor', notAfter: number | null = null) {
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role, notAfter }, ownerStorage)
    const proposal = await proposeGrant(share, devices, { storage: ownerStorage })
    await signGrant(transport, proposal, ownerStorage)
    return proposal
  }

  it('signs what the owner reviewed; the machine accepts it and the grantee acts within it', async () => {
    const proposal = await shareAs('editor')
    expect(proposal.role).toBe('editor')
    // The id format the machine dates grants by (an undatable id counts as superseded).
    expect(grantIssuedAt(proposal.grant.grantId, share.id)).toBeGreaterThan(Date.now() - 60_000)
    expect(verifier.effectivePrincipal(danaPrincipal())?.grants).toEqual({ s1: EDITOR })

    who.id = 'u-dana'
    const danaSigner = createIntentSigner('m1', danaStorage)
    danaSigner.setRole('grantee')
    const token = 'B'.repeat(22)
    const opened = verifier.checkChannelOpen(danaPrincipal(), await danaSigner.sign({ action: 'channel:open', sessionId: null, payload: new Uint8Array(), channel: token }))
    const join = '{"type":"join_session","sessionId":"s1"}'
    const intent = await danaSigner.sign({ action: frameAction(join), sessionId: 's1', payload: framePayload(join), channel: token, seq: 1 })
    expect(verifier.checkFrame(danaPrincipal(), join, intent, opened.channel).verdict).toBe('accepted')
  })

  it('signs the role the owner chose, whatever the relay lists later', async () => {
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role: 'viewer', notAfter: null }, ownerStorage)
    // The relay now claims Editor (or something stranger).
    const proposal = await proposeGrant({ ...share, permissions: [...EDITOR, 'approve_mutating_tool'] }, devices, { storage: ownerStorage })
    expect(proposal.grant.permissions).toEqual(['view', 'view_diff'])
  })

  it('refuses an unfamiliar permission list for a share it has no record of', async () => {
    await expect(proposeGrant({ ...share, permissions: [...EDITOR, 'approve_mutating_tool'] }, devices, { storage: ownerStorage }))
      .rejects.toMatchObject({ code: 'unknown_permissions' })
  })

  it('caps every grant, renewals included, at the end the owner chose', async () => {
    const end = Date.now() + 3 * DAY
    await shareAs('editor', end)
    const g = JSON.parse(stored()[0].grant) as GrantBody
    expect(g.notAfter).toBe(end)
    // The relay "forgets" the expiry; renewal still stops at the owner's end.
    share = { ...share, expiresAt: null }
    await renewGrants(transport, 'm1', { storage: ownerStorage, now: end - DAY })
    expect((JSON.parse(stored()[0].grant) as GrantBody).expiresAt).toBeLessThanOrEqual(end)
  })

  it('renews only the current grant from its own record, whatever the relay presents', async () => {
    await shareAs('editor')
    const before = JSON.parse(stored()[0].grant) as GrantBody
    // The relay hides or swaps what it stored: renewal doesn't read it.
    share = { ...share, signedGrantRaw: null, signedGrant: null }
    expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: before.expiresAt - 2 * DAY })).toBe(1)
    const after = JSON.parse(stored()[0].grant) as GrantBody
    expect({ ...after, expiresAt: 0 }).toEqual({ ...before, expiresAt: 0 })
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
  })

  it('supersedes every earlier grant, even if the relay hides the new one', async () => {
    await shareAs('editor')
    const broad = stored()[0]
    share = { ...share, signedGrantRaw: null }
    const second = await proposeGrant(share, devices, { storage: ownerStorage })
    await signGrant(transport, second, ownerStorage, { now: Date.now() + 1000 })
    const current = ownerStorage.issued.get('u-owner:m1')?.[0].current?.grantId
    expect(readTrustStore(devicesFile)?.revokedGrants).toMatchObject([{ grantId: share.id, keep: current }])
    // The relay keeps presenting the old one and leaves out the new: nothing.
    expect(verifier.effectivePrincipal(danaPrincipal([broad]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal(stored()))?.grants).toEqual({ s1: EDITOR })
  })

  it('revokes a share by its id, which kills every grant ever signed for it', async () => {
    await shareAs('viewer')
    const first = stored()[0]
    await signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)
    const second = stored()[0]
    machineDown = true
    const left = await revokeShareGrants(transport, share, ownerStorage)
    expect(left).toEqual([{ grantId: share.id }])
    // A relay answering "approved" without the machine's signature doesn't count.
    const fakeOk: GrantTransport = { ...transport, sendDeviceFrame: async () => ({ state: 'approved' }) }
    expect(await flushRevocations(fakeOk, 'm1', ownerStorage)).toEqual([{ grantId: share.id }])
    machineDown = false
    expect(await flushRevocations(transport, 'm1', ownerStorage)).toEqual([])
    expect(verifier.effectivePrincipal(danaPrincipal([first]))?.grants).toEqual({})
    expect(verifier.effectivePrincipal(danaPrincipal([second]))?.grants).toEqual({})
    // And it is never renewed or re-signed.
    expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: Date.now() + 29 * DAY })).toBe(0)
    await expect(proposeGrant(share, devices, { storage: ownerStorage })).rejects.toMatchObject({ code: 'rejected' })
  })

  it('treats a share the relay no longer has as revoked', async () => {
    await shareAs('editor')
    const g = JSON.parse(stored()[0].grant) as GrantBody
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Share not found"}', { status: 404 })))
    expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: g.expiresAt - DAY })).toBe(0)
    expect(ownerStorage.issued.get('u-owner:m1')?.[0].revoked).toBe(true)
    expect(readTrustStore(devicesFile)?.revokedGrants.map(r => r.grantId)).toContain(share.id)
  })

  it('names only the new device when the grantee adds one', async () => {
    await shareAs('editor')
    const laptop = await getOrCreateBrowserKey('u-dana-laptop', memoryStorage())
    const both = [...devices, { keyId: laptop.keyId, spki: laptop.spki, label: 'Mac Safari', lastSeenAt: null }]
    const proposal = await proposeGrant(share, both, { storage: ownerStorage })
    expect(proposal.added.map(d => d.label)).toEqual(['Mac Safari'])
  })

  it('narrows when the owner shares again: the new role is what gets signed', async () => {
    await shareAs('editor')
    // Sharing again keeps the share's id (upsertShare); the choice is replaced.
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role: 'viewer', notAfter: null }, ownerStorage)
    const proposal = await proposeGrant({ ...share, permissions: ['view', 'view_diff'] }, devices, { storage: ownerStorage, now: Date.now() + 1000 })
    expect(proposal.role).toBe('viewer')
    expect(proposal.grant.permissions).toEqual(['view', 'view_diff'])
  })

  it('refuses a listing whose member or session differs from what the owner shared', async () => {
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role: 'editor', notAfter: null }, ownerStorage)
    await expect(proposeGrant({ ...share, granteeUserId: 'u-eve' }, devices, { storage: ownerStorage })).rejects.toMatchObject({ code: 'rejected' })
    await expect(proposeGrant({ ...share, localSessionId: 's2' }, devices, { storage: ownerStorage })).rejects.toMatchObject({ code: 'rejected' })
  })

  it('flags a share it has no record of, and one that repeats a recorded share', async () => {
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role: 'viewer', notAfter: null }, ownerStorage)
    const unknown = await proposeGrant({ ...share, id: 'g2' }, devices, { storage: ownerStorage })
    expect(unknown).toMatchObject({ recorded: false, duplicateOf: 'g1' })
    expect((await proposeGrant(share, devices, { storage: ownerStorage })).recorded).toBe(true)
  })

  it('signs the narrower of its record and the listing, and says so', async () => {
    await recordShare('m1', { shareId: share.id, sessionId: 's1', granteeUserId: 'u-dana', role: 'editor', notAfter: null }, ownerStorage)
    const proposal = await proposeGrant({ ...share, permissions: ['view', 'view_diff'] }, devices, { storage: ownerStorage })
    expect(proposal).toMatchObject({ role: 'viewer', narrowedByListing: true })
    await signGrant(transport, proposal, ownerStorage)
    expect(ownerStorage.issued.get('u-owner:m1')?.[0].role).toBe('viewer')
  })

  it("dates grants and renewals by the machine's signed clock", async () => {
    await shareAs('viewer')
    const g = JSON.parse(stored()[0].grant) as GrantBody
    // The machine's clock runs 28 days ahead of this browser's.
    const ahead = g.expiresAt - 2 * DAY - Date.now()
    const clockMachine = new MachineEnrolment({ machineId: 'm1', identityFile: join(dir, 'relay-identity.json'), devicesFile, secretStore: null, intents: verifier, now: () => Date.now() + ahead })
    const viaClock: GrantTransport = {
      ...transport,
      sendDeviceFrame: async (kind, payload) => kind === 'enrol_time'
        ? clockMachine.handle(kind, undefined, payload).payload
        : transport.sendDeviceFrame(kind, payload),
    }
    expect(await renewGrants(viaClock, 'm1', { storage: ownerStorage })).toBe(1)
    const renewed = JSON.parse(stored()[0].grant) as GrantBody
    expect(Math.abs(renewed.expiresAt - (Date.now() + ahead + 30 * DAY))).toBeLessThan(2000)
    expect(Math.abs((JSON.parse(stored()[0].intent.body) as { ts: number }).ts - (Date.now() + ahead))).toBeLessThan(2000)
  })

  it("won't take the machine's clock from a slow, replayed or unpinned answer", async () => {
    expect(await machineClockOffset(transport, 'm1', ownerStorage)).toEqual(expect.any(Number))
    // An answer for another nonce (a replay).
    const old = await transport.sendDeviceFrame('enrol_time', { nonce: 'A'.repeat(22) })
    expect(await machineClockOffset({ ...transport, sendDeviceFrame: async () => old }, 'm1', ownerStorage)).toBeNull()
    // Held back by the relay past the bound.
    const real = Date.now.bind(Date)
    let skew = 0
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew)
    const slow: GrantTransport = { ...transport, sendDeviceFrame: async (k, p) => { const r = await transport.sendDeviceFrame(k, p); skew += 6000; return r } }
    expect(await machineClockOffset(slow, 'm1', ownerStorage)).toBeNull()
    vi.mocked(Date.now).mockRestore()
    // A machine key taken on first use may be the relay's.
    const pin = await ownerStorage.getPin('u-owner', 'm1')
    await ownerStorage.putPin({ ...pin!, via: 'passkey' })
    expect(await machineClockOffset(transport, 'm1', ownerStorage)).toBeNull()
    await expect(signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)).rejects.toMatchObject({ code: 'no_clock' })
  })

  describe('an owner with two browsers', () => {
    let laptopStorage: ReturnType<typeof memoryStorage>
    let laptop: GrantTransport

    beforeEach(async () => {
      laptopStorage = memoryStorage()
      const key = await getOrCreateBrowserKey('u-owner', laptopStorage)
      const pin = await ownerStorage.getPin('u-owner', 'm1')
      await laptopStorage.putPin({ ...pin!, keyId: key.keyId })
      const store = readTrustStore(devicesFile) as TrustStore
      writeTrustStore(devicesFile, {
        ...store,
        credentials: [...store.credentials, { keyId: key.keyId, kind: 'browser', userId: 'u-owner', spki: key.spki, label: 'Laptop', addedAt: 'x', addedBy: 'local' }],
      })
      const signer = createIntentSigner('m1', laptopStorage)
      const ownerPrincipal: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
      laptop = {
        signIntent: intent => signer.sign(intent) as ReturnType<GrantTransport['signIntent']>,
        sendDeviceFrame: async (kind, payload) => machine.handle(kind, ownerPrincipal, JSON.parse(JSON.stringify(payload))).payload,
      }
    })

    it("a narrowing from one browser stands, however often the other renews the broader grant", async () => {
      await shareAs('editor')
      const broad = JSON.parse(stored()[0].grant) as GrantBody
      // The laptop narrows; it has no record of the share.
      share = { ...share, permissions: ['view', 'view_diff'] }
      const narrow = await proposeGrant(share, devices, { storage: laptopStorage })
      expect(narrow).toMatchObject({ recorded: false, role: 'viewer' })
      await signGrant(laptop, narrow, laptopStorage, { now: Date.now() + 1000 })
      const narrowSigned = stored()[0]
      // The first browser renews its (now superseded) broader grant.
      expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: broad.expiresAt - 2 * DAY })).toBe(1)
      const renewed = stored()[0]
      expect((JSON.parse(renewed.grant) as GrantBody).grantId).toBe(broad.grantId)
      // Presented alone or together, the broader grant gets nothing.
      expect(verifier.effectivePrincipal(danaPrincipal([renewed]))?.grants).toEqual({})
      expect(verifier.effectivePrincipal(danaPrincipal([renewed, narrowSigned]))?.grants).toEqual({ s1: ['view', 'view_diff'] })
    })

    it('a revocation from one browser outlasts the other one renewing', async () => {
      await shareAs('editor')
      const g = JSON.parse(stored()[0].grant) as GrantBody
      expect(await revokeShareGrants(laptop, share, laptopStorage)).toEqual([])
      expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: g.expiresAt - 2 * DAY })).toBe(1)
      expect(verifier.effectivePrincipal(danaPrincipal())?.grants).toEqual({})
      // Long after any grant could have lived, the revocation is still there.
      addRevokedGrant({ grantId: 'other-share' }, devicesFile, 'm1', Date.now() + 90 * DAY)
      expect(readTrustStore(devicesFile)?.revokedGrants.map(r => r.grantId)).toEqual([share.id, 'other-share'])
    })
  })
})
