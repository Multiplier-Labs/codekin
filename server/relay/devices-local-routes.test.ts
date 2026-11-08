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
import { runDevicesCommand } from './devices-cli.js'
import { prepareMachineTrust } from './machine-trust.js'
import { emptyTrustStore, readTrustStore, writeTrustStore } from './trust-store.js'
import type { TrustedCredential } from './trust-store.js'

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
  })
})
