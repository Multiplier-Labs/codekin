/** Tests for the local device-list routes and `codekin relay devices` (signed-intents spec §5.5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createRelayDevicesRouter } from './devices-local-routes.js'
import type { RelayDevicesResponse } from './devices-local-routes.js'
import { runAuditCommand, runDevicesCommand } from './devices-cli.js'
import { IntentLog } from './intent-log.js'
import { prepareMachineTrust } from './machine-trust.js'
import { emptyTrustStore, readTrustStore, writeTrustStore } from './trust-store.js'
import type { TrustedCredential } from './trust-store.js'
import { generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { MachineEnrolment } from './enrolment.js'
import { POP_LABEL, commitment, formatCode, shortAuthString, signP1363, transcript, trustRevealMac, trustTokenId } from './enrolment-crypto.js'

/** Have a browser reach "awaiting code" on m1; returns the code it would show. */
function browserWaiting(label = 'Edge · Windows', trustSecret?: Buffer): { code: string; enrolId: string } {
  const owner = { userId: 'u1', role: 'owner' as const, grants: {} }
  const machine = new MachineEnrolment({ machineId: 'm1', identityFile: join(dir, 'relay-identity.json'), devicesFile, secretStore: null })
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const nonceB = randomBytes(32)
  const ch = machine.commit(owner, { commit: commitment(spki, [], label, nonceB).toString('base64url') })
  const nonceM = Buffer.from(ch.nonceM, 'base64url')
  const spkiM = Buffer.from(ch.machineKey, 'base64url')
  machine.reveal(owner, {
    enrolId: ch.enrolId, spki: spki.toString('base64url'), passkeys: [], label, nonceB: nonceB.toString('base64url'),
    pop: signP1363(privateKey as KeyObject, transcript(POP_LABEL, ch.enrolId, nonceM, '[]')).toString('base64url'),
    ...(trustSecret ? {
      trust: { id: trustTokenId(trustSecret), mac: trustRevealMac(trustSecret, ch.enrolId, spkiM, spki, [], label, nonceB, nonceM).toString('base64url') },
    } : {}),
  })
  return { enrolId: ch.enrolId, code: formatCode(shortAuthString(Buffer.from(ch.machineKey, 'base64url'), spki, [], nonceB, nonceM)) }
}

const quiet = { log: vi.fn(), warn: vi.fn() }

const BROWSER: TrustedCredential = {
  keyId: 'q3aaaaaaaaaaaaaaaaaaaa', kind: 'browser', userId: 'u1', spki: 'MFkw', label: 'Safari · iPhone',
  addedAt: '2026-11-08T10:00:00Z', addedBy: 'local',
}

let dir: string
let credentialFile: string
let devicesFile: string

function pair(machineId = 'm1'): void {
  writeFileSync(credentialFile, JSON.stringify({ url: 'https://relay.test', machineId, secretRef: 'keychain', managed: true }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-devices-'))
  credentialFile = join(dir, 'relay.json')
  devicesFile = join(dir, 'relay-devices.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('/api/relay/devices', () => {
  let server: Server
  let base: string
  const auth = { Authorization: 'Bearer good', 'Content-Type': 'application/json' }

  beforeEach(async () => {
    const app = express()
    app.use(express.json())
    app.use(createRelayDevicesRouter(
      (token) => token === 'good',
      (req) => req.headers.authorization?.replace(/^Bearer /, ''),
      credentialFile,
    ))
    server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => { resolve(s) })
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/relay/devices`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })

  it('requires the local auth token on every route', async () => {
    for (const [method, path] of [['GET', ''], ['DELETE', '/q3'], ['PUT', '/policy']] as const) {
      expect((await fetch(base + path, { method })).status).toBe(401)
      expect((await fetch(base + path, { method, headers: { Authorization: 'Bearer bad' } })).status).toBe(401)
    }
  })

  it('reports an unpaired machine', async () => {
    const res = await fetch(base, { headers: auth })
    expect(await res.json()).toEqual({ paired: false, machineId: null, identity: null, devices: null })
    expect((await fetch(`${base}/q3`, { method: 'DELETE', headers: auth })).status).toBe(404)
  })

  it('shows the identity key and the device list for this pairing, without key material', async () => {
    pair()
    // Paired, but the connector hasn't started yet.
    expect(await (await fetch(base, { headers: auth })).json()).toMatchObject({ paired: true, machineId: 'm1', identity: null, devices: null })

    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials: [BROWSER] })
    const body = await (await fetch(base, { headers: auth })).json() as RelayDevicesResponse
    expect(body.identity?.keyId).toHaveLength(22)
    expect(body.devices).toMatchObject({ machineId: 'm1', ownerUserId: 'u1', policy: 'off', pendingCount: 0 })
    expect(body.devices?.credentials).toEqual([{
      keyId: BROWSER.keyId, kind: 'browser', userId: 'u1', label: BROWSER.label, addedAt: BROWSER.addedAt, addedBy: 'local',
    }])
    expect(JSON.stringify(body)).not.toContain('MFkw')
  })

  it('hides a list left over from an earlier pairing', async () => {
    pair('m2')
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials: [BROWSER] })
    expect(await (await fetch(base, { headers: auth })).json()).toMatchObject({ paired: true, machineId: 'm2', devices: null })
    const res = await fetch(`${base}/${BROWSER.keyId}`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(409)
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
  })

  it('reports an unreadable list instead of hiding it', async () => {
    pair()
    writeFileSync(devicesFile, '{ broken')
    const body = await (await fetch(base, { headers: auth })).json() as RelayDevicesResponse
    expect(body.devices).toBeNull()
    expect(body.error).toMatch(/not valid JSON/)
  })

  it('removes a device', async () => {
    pair()
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials: [BROWSER] })
    const res = await fetch(`${base}/${BROWSER.keyId}`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: { keyId: BROWSER.keyId, label: BROWSER.label } })
    expect(readTrustStore(devicesFile)?.credentials).toEqual([])
    expect((await fetch(`${base}/${BROWSER.keyId}`, { method: 'DELETE', headers: auth })).status).toBe(404)
  })

  it('confirms a waiting browser by its code, and never lists the code', async () => {
    pair()
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    const { code, enrolId } = browserWaiting()
    const listed = await (await fetch(base, { headers: auth })).json() as RelayDevicesResponse
    expect(listed.devices?.pending).toEqual([expect.objectContaining({ enrolId, label: 'Edge · Windows' })])
    expect(JSON.stringify(listed)).not.toContain(code.replace('-', ''))

    const wrong = await fetch(`${base}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ code: 'AAAA-AAAA' }) })
    expect(wrong.status).toBe(404)
    const ok = await fetch(`${base}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ code }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ added: { label: 'Edge · Windows', confirmCode: expect.stringMatching(/^[A-Z2-7]{3}-[A-Z2-7]{3}$/) } })
    expect(readTrustStore(devicesFile)?.credentials).toHaveLength(1)
  })

  it("takes the browser's trust command pasted whole", async () => {
    pair()
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    const secret = randomBytes(16)
    browserWaiting('Edge · Windows', secret)
    const res = await fetch(`${base}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ code: `codekin relay devices trust ${secret.toString('base64url')}` }) })
    expect(await res.json()).toMatchObject({ added: { label: 'Edge · Windows', confirmCode: null, policyRaised: true } })
    const early = await fetch(`${base}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ code: randomBytes(16).toString('base64url') }) })
    expect(await early.json()).toMatchObject({ waiting: { expiresAt: expect.any(String) } })
  })

  it('turns a waiting browser down', async () => {
    pair()
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    const { code, enrolId } = browserWaiting()
    expect((await fetch(`${base}/pending/${enrolId}`, { method: 'DELETE', headers: auth })).status).toBe(200)
    expect((await fetch(`${base}/pending/${enrolId}`, { method: 'DELETE', headers: auth })).status).toBe(404)
    // A turned-down request's code no longer works.
    expect((await fetch(`${base}/approve`, { method: 'POST', headers: auth, body: JSON.stringify({ code }) })).status).toBe(404)
  })

  it('sets the policy, refusing required with no owner device', async () => {
    pair()
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    const put = (policy: unknown) => fetch(`${base}/policy`, { method: 'PUT', headers: auth, body: JSON.stringify({ policy }) })
    expect((await put('bogus')).status).toBe(400)
    const refused = await put('required')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'no_credentials' })
    const ok = await put('warn')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ policy: 'warn' })
    expect(readTrustStore(devicesFile)?.policy).toBe('warn')
  })
})

describe('the intent log, locally', () => {
  const entry = (action: string, verdict: 'accepted' | 'rejected' = 'accepted') =>
    ({ verdict, forwarded: true, action, sessionId: null, userId: 'u1', keyId: 'k1', payloadHash: 'h', intent: { body: '{}', sig: 'sig' } })

  it('lists recent entries without the stored intents, and checks the chain', async () => {
    const logFile = join(dir, 'intents.jsonl')
    const log = new IntentLog(logFile)
    log.append(entry('rest:GET /api/repos'))
    log.append(entry('ws:input', 'rejected'))
    const app = express()
    app.use(createRelayDevicesRouter(t => t === 'good', r => r.headers.authorization?.replace(/^Bearer /, ''), credentialFile, logFile))
    const srv = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => { resolve(s) }) })
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/relay/intents`
    try {
      expect((await fetch(base)).status).toBe(401)
      const auth = { Authorization: 'Bearer good' }
      const all = await (await fetch(base, { headers: auth })).json() as { entries: Array<Record<string, unknown>> }
      expect(all.entries.map(e => e.action)).toEqual(['ws:input', 'rest:GET /api/repos'])
      expect(all.entries[0]).not.toHaveProperty('intent')
      const refused = await (await fetch(`${base}?verdict=rejected`, { headers: auth })).json() as { entries: unknown[] }
      expect(refused.entries).toHaveLength(1)
      expect(await (await fetch(`${base}/verify`, { headers: auth })).json()).toEqual({ ok: true, entries: 2 })
    } finally {
      await new Promise<void>(resolve => srv.close(() => { resolve() }))
    }
  })

  it('codekin relay audit lists and verifies', () => {
    const logFile = join(dir, 'intents.jsonl')
    const out: string[] = []
    const err: string[] = []
    const io = { out: (l: string) => { out.push(l) }, err: (l: string) => { err.push(l) } }
    expect(runAuditCommand([], logFile, io)).toBe(0)
    expect(out.pop()).toBe('Nothing logged yet.')
    const log = new IntentLog(logFile)
    log.append(entry('rest:GET /api/repos'))
    log.append({ ...entry('ws:input', 'rejected'), reason: 'intent_stale' })
    expect(runAuditCommand(['list'], logFile, io)).toBe(0)
    expect(out.join('\n')).toContain('REJECTED  ws:input  key k1  intent_stale (forwarded)')
    expect(runAuditCommand(['verify'], logFile, io)).toBe(0)
    expect(out.pop()).toContain('OK: 2 entries')
    writeFileSync(logFile, 'garbage\n')
    expect(runAuditCommand(['verify'], logFile, io)).toBe(1)
    expect(err.pop()).toContain('Broken at line 1')
  })
})

describe('codekin relay devices', () => {
  function run(args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = runDevicesCommand(args, credentialFile, { out: l => { out.push(l) }, err: l => { err.push(l) } })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('needs a pairing', () => {
    expect(run(['list'])).toMatchObject({ code: 1, err: expect.stringContaining('Not paired') })
  })

  it('lists the identity key, the policy and the devices', () => {
    pair()
    expect(run([]).code).toBe(1) // no list until the connector starts
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    const empty = run([])
    expect(empty.code).toBe(0)
    expect(empty.out).toContain('Machine:      m1')
    expect(empty.out).toMatch(/Identity key: [A-Za-z0-9_-]{22}/)
    expect(empty.out).toContain('No devices yet')

    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials: [BROWSER, { ...BROWSER, keyId: 'z9', addedBy: 'passkey:p7' }] })
    const listed = run(['list'])
    expect(listed.out).toContain(`${BROWSER.keyId}  browser  Safari · iPhone`)
    expect(listed.out).toContain('confirmed on this computer')
    expect(listed.out).toContain('added by passkey p7')

    const json = JSON.parse(run(['list', '--json']).out) as { credentials: unknown[]; identityKeyId: string }
    expect(json.credentials).toHaveLength(2)
    expect(json.identityKeyId).toHaveLength(22)
  })

  it('approves and rejects by code and request id, and lists waiting browsers', () => {
    pair()
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    const first = browserWaiting('Edge · Windows')
    const second = browserWaiting('Safari · iPad')
    const listed = run(['list'])
    expect(listed.out).toContain('Waiting to be confirmed')
    expect(listed.out).toContain(`${first.enrolId}  Edge · Windows`)
    expect(run(['approve'])).toMatchObject({ code: 1 })
    expect(run(['approve', 'AAAA-AAAA'])).toMatchObject({ code: 1, err: expect.stringContaining('No browser is waiting') })
    // Typed with a space instead of the hyphen, in lower case.
    const approved = run(['approve', ...first.code.toLowerCase().split('-')])
    expect(approved).toMatchObject({ code: 0, out: expect.stringContaining('Confirmed Edge · Windows') })
    const finishing = /type this code in the browser: +([A-Z2-7]{3}-[A-Z2-7]{3})/.exec(approved.out)?.[1]
    expect(finishing).toBeDefined()
    // `list` keeps showing it for a while, in case it scrolled away.
    expect(run(['list']).out).toContain(`${finishing!}  Edge · Windows`)
    expect(run(['reject', second.enrolId])).toMatchObject({ code: 0 })
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.label)).toEqual(['Edge · Windows'])
  })

  it('confirms a browser by its pasted trust token, before or after it asked', () => {
    pair()
    prepareMachineTrust(credentialFile, 'm1', 'https://relay.test', null, quiet)
    writeTrustStore(devicesFile, emptyTrustStore('m1', 'https://relay.test', 'u1'))
    expect(run(['trust'])).toMatchObject({ code: 1 })
    expect(run(['trust', 'K7QM-2XPA'])).toMatchObject({ code: 1, err: expect.stringContaining('not a trust token') })
    const secret = randomBytes(16)
    browserWaiting('Edge · Windows', secret)
    expect(run(['trust', secret.toString('base64url')])).toMatchObject({ code: 0, out: expect.stringContaining('Confirmed Edge · Windows') })
    // Pasted first: it waits for its browser, which is then confirmed as it asks.
    const early = randomBytes(16)
    expect(run(['trust', early.toString('base64url')])).toMatchObject({ code: 0, out: expect.stringContaining('as soon as it asks') })
    browserWaiting('Safari · iPad', early)
    expect(readTrustStore(devicesFile)?.credentials.map(c => c.label)).toEqual(['Edge · Windows', 'Safari · iPad'])
  })

  it('revokes and sets the policy', () => {
    pair()
    writeTrustStore(devicesFile, { ...emptyTrustStore('m1', 'https://relay.test', 'u1'), credentials: [BROWSER] })
    expect(run(['revoke'])).toMatchObject({ code: 1 })
    expect(run(['revoke', 'nope'])).toMatchObject({ code: 1, err: expect.stringContaining('No device') })
    expect(run(['revoke', BROWSER.keyId])).toMatchObject({ code: 0, out: expect.stringContaining('Removed Safari · iPhone') })
    expect(run(['policy', 'required'])).toMatchObject({ code: 1, err: expect.stringContaining('Confirm at least one') })
    expect(run(['policy', 'warn'])).toMatchObject({ code: 0, out: expect.stringContaining('warn') })
    expect(run(['policy', 'sometimes'])).toMatchObject({ code: 1 })
    expect(run(['frobnicate'])).toMatchObject({ code: 1, err: expect.stringContaining('Usage') })
    expect(run(['passkey-adds', 'off'])).toMatchObject({ code: 0, out: expect.stringContaining('Only devices confirmed') })
    expect(readTrustStore(devicesFile)?.localConfirmationOnly).toBe(true)
    expect(run(['list']).out).toContain('may not add browsers')
    expect(run(['passkey-adds', 'on']).code).toBe(0)
    expect(readTrustStore(devicesFile)?.localConfirmationOnly).toBeUndefined()
    expect(run(['passkey-adds', 'maybe']).code).toBe(1)
  })
})
