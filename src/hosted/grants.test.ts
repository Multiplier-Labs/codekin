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
  flushRevocations, proposeGrant, recordShare, renewGrants, revokeShareGrants, signGrant,
  type GranteeKey, type GrantTransport, type ShareWithGrant,
} from './grants'
import { getOrCreateBrowserKey, type BrowserKey, type IssuedGrant, type MachinePin, type TrustStorage } from './deviceTrust'
import { createIntentSigner } from './intentSigner'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { MachineEnrolment } from '../../server/relay/enrolment'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { emptyTrustStore, readTrustStore, writeTrustStore } from '../../server/relay/trust-store'
import { frameAction, framePayload } from '../../server/relay/intent-actions'
import type { GrantBody, SignedGrant } from '../../server/relay/intent-actions'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

function memoryStorage(): TrustStorage & { revocations: Map<string, string[]>; issued: Map<string, IssuedGrant[]> } {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  const revocations = new Map<string, string[]>()
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

  /** Share, as the dialog does: record the owner's choice, then sign what is proposed. */
  async function shareAs(role: 'viewer' | 'editor', notAfter: number | null = null) {
    await recordShare('m1', share.id, role, notAfter, ownerStorage)
    const proposal = await proposeGrant(share, devices, { storage: ownerStorage })
    await signGrant(transport, proposal, ownerStorage)
    return proposal
  }

  it('signs what the owner reviewed; the machine accepts it and the grantee acts within it', async () => {
    const proposal = await shareAs('editor')
    expect(proposal.role).toBe('editor')
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
    await recordShare('m1', share.id, 'viewer', null, ownerStorage)
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

  it('revokes every grant it supersedes, even if the relay hides them', async () => {
    const first = await shareAs('editor')
    const broad = stored()[0]
    share = { ...share, signedGrantRaw: null }
    const second = await proposeGrant(share, devices, { storage: ownerStorage })
    expect(second.replaces).toBe(first.grant.grantId)
    await signGrant(transport, second, ownerStorage)
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
    expect(left).toEqual([share.id])
    // A relay answering "approved" without the machine's signature doesn't count.
    const fakeOk: GrantTransport = { ...transport, sendDeviceFrame: async () => ({ state: 'approved' }) }
    expect(await flushRevocations(fakeOk, 'm1', ownerStorage)).toEqual([share.id])
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
})
