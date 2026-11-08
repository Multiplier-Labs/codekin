/**
 * Share grants between the owner's browser, the grantee's browser and the
 * machine (signed-intents spec §6.7): what the browser signs, the machine
 * verifies.
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

import { buildGrant, grantStatus, renewGrants, revokeShareGrant, signShareGrant, type GrantTransport, type ShareWithGrant } from './grants'
import { getOrCreateBrowserKey, type BrowserKey, type MachinePin, type TrustStorage } from './deviceTrust'
import { createIntentSigner } from './intentSigner'
import { IntentVerifier } from '../../server/relay/intent-verify'
import { MachineEnrolment } from '../../server/relay/enrolment'
import { ensureMachineIdentity } from '../../server/relay/machine-identity'
import { emptyTrustStore, readTrustStore, writeTrustStore } from '../../server/relay/trust-store'
import { frameAction, framePayload } from '../../server/relay/intent-actions'
import type { SignedGrant } from '../../server/relay/intent-actions'
import type { RelayPrincipal } from '../../server/relay/relay-protocol'

function memoryStorage(): TrustStorage {
  const keys = new Map<string, BrowserKey>()
  const pins = new Map<string, MachinePin>()
  return {
    getKey: async id => keys.get(id),
    putKey: async k => { keys.set(k.userId, k) },
    getPin: async (u, m) => pins.get(`${u}:${m}`),
    putPin: async p => { pins.set(`${p.userId}:${p.machineId}`, p) },
    deletePin: async (u, m) => { pins.delete(`${u}:${m}`) },
  }
}

const DAY = 24 * 60 * 60_000

describe('share grants from the browser to the machine', () => {
  let dir: string
  let devicesFile: string
  let verifier: IntentVerifier
  let machine: MachineEnrolment
  let transport: GrantTransport
  let danaKey: BrowserKey
  let danaStorage: TrustStorage
  let stored: SignedGrant[]
  let share: ShareWithGrant

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-grants-browser-'))
    const identityFile = join(dir, 'relay-identity.json')
    devicesFile = join(dir, 'relay-devices.json')
    ensureMachineIdentity('m1', 'https://relay.test', { file: identityFile, store: null, log: { log: vi.fn(), warn: vi.fn() } })

    // The owner's browser, confirmed on the machine.
    who.id = 'u-owner'
    const ownerStorage = memoryStorage()
    const ownerKey = await getOrCreateBrowserKey('u-owner', ownerStorage)
    await ownerStorage.putPin({ userId: 'u-owner', machineId: 'm1', machineKey: 'mk', keyId: ownerKey.keyId, pinnedAt: 'x', via: 'code' })
    writeTrustStore(devicesFile, {
      ...emptyTrustStore('m1', 'https://relay.test', 'u-owner'), policy: 'required',
      credentials: [{ keyId: ownerKey.keyId, kind: 'browser', userId: 'u-owner', spki: ownerKey.spki, label: 'Owner', addedAt: 'x', addedBy: 'local' }],
    })
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile })
    machine = new MachineEnrolment({ machineId: 'm1', identityFile, devicesFile, secretStore: null, intents: verifier })
    const ownerSigner = createIntentSigner('m1', ownerStorage)
    const ownerPrincipal: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }
    transport = {
      signIntent: intent => ownerSigner.sign(intent) as ReturnType<GrantTransport['signIntent']>,
      sendDeviceFrame: async (kind, payload) => machine.handle(kind, ownerPrincipal, JSON.parse(JSON.stringify(payload))).payload,
    }

    // Dana's browser key, registered with the relay.
    danaStorage = memoryStorage()
    danaKey = await getOrCreateBrowserKey('u-dana', danaStorage)

    share = {
      id: 'g1', machineId: 'm1', localSessionId: 's1', granteeUserId: 'u-dana', permissions: ['view', 'send_prompt'],
      expiresAt: null, signedGrant: null,
    }
    stored = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/grant') && init?.method === 'PUT') {
        stored.push(JSON.parse(String(init.body)) as SignedGrant)
        return new Response(JSON.stringify({ share }), { status: 200 })
      }
      if (url.includes('/grantee-keys')) return new Response(JSON.stringify({ keys: [{ keyId: danaKey.keyId, spki: danaKey.spki, label: 'Pixel Chrome', lastSeenAt: null }] }))
      if (url.endsWith('/api/shares')) return new Response(JSON.stringify({ shared: [share] }))
      return new Response('{}', { status: 404 })
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  const danaPrincipal = (): RelayPrincipal => ({ userId: 'u-dana', role: 'grantee', grants: { s1: ['view', 'send_prompt', 'upload_file'] }, signedGrants: stored })

  it('signs a grant the machine accepts, and lets the grantee act only within it', async () => {
    await signShareGrant(transport, share, [danaKey])
    expect(stored).toHaveLength(1)
    expect(verifier.effectivePrincipal(danaPrincipal())?.grants).toEqual({ s1: ['view', 'send_prompt'] })

    // Dana's browser signs as a grantee, with her own key.
    who.id = 'u-dana'
    const danaSigner = createIntentSigner('m1', danaStorage)
    danaSigner.setRole('grantee')
    const token = 'B'.repeat(22)
    const opened = verifier.checkChannelOpen(danaPrincipal(), await danaSigner.sign({ action: 'channel:open', sessionId: null, payload: new Uint8Array(), channel: token }))
    expect(opened.decision.verdict).toBe('accepted')
    const join = '{"type":"join_session","sessionId":"s1"}'
    const intent = await danaSigner.sign({ action: frameAction(join), sessionId: 's1', payload: framePayload(join), channel: token, seq: 1 })
    expect(verifier.checkFrame(danaPrincipal(), join, intent, opened.channel).verdict).toBe('accepted')
  })

  it('can not sign a grant from a browser not confirmed on the machine', async () => {
    const stranger = createIntentSigner('m1', memoryStorage())
    await expect(signShareGrant({ ...transport, signIntent: i => stranger.sign(i) as ReturnType<GrantTransport['signIntent']> }, share, [danaKey]))
      .rejects.toMatchObject({ code: 'not_confirmed' })
    await expect(signShareGrant(transport, share, [])).rejects.toMatchObject({ code: 'no_keys' })
  })

  it('expires grants after 30 days or with the share, whichever is first', () => {
    const now = Date.parse('2026-11-08T00:00:00Z')
    expect(buildGrant(share, [danaKey], now).expiresAt).toBe(now + 30 * DAY)
    expect(buildGrant({ ...share, expiresAt: new Date(now + 3 * DAY).toISOString() }, [danaKey], now).expiresAt).toBe(now + 3 * DAY)
  })

  it('renews a grant about to run out for the same devices, and leaves a new device to the owner', async () => {
    share = { ...share, signedGrant: { expiresAt: Date.now() + 2 * DAY, permissions: share.permissions, keyIds: [danaKey.keyId] } }
    expect(await renewGrants(transport, 'm1')).toBe(1)
    expect(stored).toHaveLength(1)

    // Far from expiry: nothing to do.
    share = { ...share, signedGrant: { expiresAt: Date.now() + 20 * DAY, permissions: share.permissions, keyIds: [danaKey.keyId] } }
    expect(await renewGrants(transport, 'm1')).toBe(0)

    // A device the grant doesn't name is never added silently.
    share = { ...share, signedGrant: { expiresAt: Date.now() + 2 * DAY, permissions: share.permissions, keyIds: ['old-key'] } }
    expect(await renewGrants(transport, 'm1')).toBe(0)
    expect(grantStatus(share, [{ keyId: danaKey.keyId, spki: danaKey.spki, label: 'Pixel Chrome', lastSeenAt: null }]))
      .toMatchObject({ kind: 'new_device', added: [expect.objectContaining({ label: 'Pixel Chrome' })] })
  })

  it('revokes the grant on the machine itself', async () => {
    await signShareGrant(transport, share, [danaKey])
    await revokeShareGrant(transport, 'g1')
    expect(readTrustStore(devicesFile)?.revokedGrants.map(g => g.grantId)).toEqual(['g1'])
    expect(verifier.effectivePrincipal(danaPrincipal())?.grants).toEqual({})
  })
})
