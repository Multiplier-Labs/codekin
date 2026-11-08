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
  flushRevocations, proposeGrant, renewGrants, revokeShareGrants, signGrant,
  type GranteeKey, type GrantTransport, type ShareWithGrant,
} from './grants'
import { getOrCreateBrowserKey, type BrowserKey, type MachinePin, type TrustStorage } from './deviceTrust'
import { createIntentSigner } from './intentSigner'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { MachineEnrolment } from '../../server/relay/enrolment'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { emptyTrustStore, readTrustStore, writeTrustStore } from '../../server/relay/trust-store'
import { frameAction, framePayload } from '../../server/relay/intent-actions'
import type { GrantBody, SignedGrant } from '../../server/relay/intent-actions'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

function memoryStorage(): TrustStorage & { revocations: Map<string, string[]> } {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  const revocations = new Map<string, string[]>()
  return {
    revocations,
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
    const machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
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

  it('signs what the owner reviewed; the machine accepts it and the grantee acts within it', async () => {
    const proposal = await proposeGrant(share, devices, { storage: ownerStorage })
    expect(proposal.role).toBe('editor')
    await signGrant(transport, proposal, ownerStorage)
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

  it('refuses to sign a permission list it does not recognise', async () => {
    // The relay adds powers beyond Editor.
    await expect(proposeGrant({ ...share, permissions: [...EDITOR, 'approve_mutating_tool'] }, devices, { storage: ownerStorage }))
      .rejects.toMatchObject({ code: 'unknown_permissions' })
  })

  it('caps every grant, renewals included, at the share end it signed', async () => {
    const end = Date.now() + 3 * DAY
    await signGrant(transport, await proposeGrant({ ...share, expiresAt: new Date(end).toISOString() }, devices, { storage: ownerStorage }), ownerStorage)
    const g = JSON.parse(stored()[0].grant) as GrantBody
    expect(g.notAfter).toBe(end)
    expect(g.expiresAt).toBeLessThanOrEqual(end)
    // The relay later "forgets" the expiry; renewal still stops at the signed end.
    share = { ...share, expiresAt: null }
    await renewGrants(transport, 'm1', { storage: ownerStorage, now: end - DAY })
    expect((JSON.parse(stored()[0].grant) as GrantBody).expiresAt).toBeLessThanOrEqual(end)
  })

  it('renews only a grant it signed itself, changing nothing but the expiry', async () => {
    await signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)
    const before = JSON.parse(stored()[0].grant) as GrantBody
    expect(await renewGrants(transport, 'm1', { storage: ownerStorage, now: before.expiresAt - 2 * DAY })).toBe(1)
    const after = JSON.parse(stored()[0].grant) as GrantBody
    expect({ ...after, expiresAt: 0 }).toEqual({ ...before, expiresAt: 0 })
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)

    // A share the relay made up (no grant this browser signed) is never signed silently.
    share = { ...share, id: 'fake', signedGrant: { expiresAt: Date.now() + DAY, permissions: EDITOR, keyIds: [danaKey.keyId] }, signedGrantRaw: null }
    expect(await renewGrants(transport, 'm1', { storage: ownerStorage })).toBe(0)
  })

  it('gives a narrowed grant a new id and revokes the broader one on the machine', async () => {
    await signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)
    const broad = stored()[0]
    share = { ...share, permissions: ['view', 'view_diff'] }
    const narrower = await proposeGrant(share, devices, { storage: ownerStorage })
    expect(narrower.replaces).toBe((JSON.parse(broad.grant) as GrantBody).grantId)
    await signGrant(transport, narrower, ownerStorage)
    // Even if the relay keeps sending the broad grant alongside, it is revoked.
    expect(verifier.effectivePrincipal(danaPrincipal([broad, ...stored()]))?.grants).toEqual({ s1: ['view', 'view_diff'] })
    expect(verifier.effectivePrincipal(danaPrincipal([broad]))?.grants).toEqual({})
    expect(ownerStorage.revocations.get('u-owner:m1')).toEqual([])
  })

  it('keeps a revocation until the machine itself confirms it', async () => {
    await signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)
    const signed = stored()[0]
    machineDown = true
    const left = await revokeShareGrants(transport, share, ownerStorage)
    expect(left.length).toBeGreaterThan(0)
    expect(verifier.effectivePrincipal(danaPrincipal([signed]))?.grants).toEqual({ s1: EDITOR })

    // A relay answering "approved" without the machine's signature doesn't count.
    const fakeOk: GrantTransport = { ...transport, sendDeviceFrame: async () => ({ state: 'approved' }) }
    expect((await flushRevocations(fakeOk, 'm1', ownerStorage)).length).toBeGreaterThan(0)

    machineDown = false
    expect(await flushRevocations(transport, 'm1', ownerStorage)).toEqual([])
    expect(verifier.effectivePrincipal(danaPrincipal([signed]))?.grants).toEqual({})
    expect(readTrustStore(devicesFile)?.revokedGrants.length).toBeGreaterThan(0)
  })

  it('names only the new device when the grantee adds one', async () => {
    await signGrant(transport, await proposeGrant(share, devices, { storage: ownerStorage }), ownerStorage)
    const laptop = await getOrCreateBrowserKey('u-dana-laptop', memoryStorage())
    const both = [...devices, { keyId: laptop.keyId, spki: laptop.spki, label: 'Mac Safari', lastSeenAt: null }]
    const proposal = await proposeGrant(share, both, { storage: ownerStorage })
    expect(proposal.added.map(d => d.label)).toEqual(['Mac Safari'])
    expect(proposal.replaces).toBeNull()
  })
})
