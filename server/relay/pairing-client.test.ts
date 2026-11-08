/** Tests for in-app relay pairing: the device-code client, the local routes, and that the relay can't reach them. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_RELAY_URL,
  PairingError,
  RelayPairing,
  claimPairingToken,
  normalizeRelayUrl,
  safeLogin,
  removeRelayCredential,
} from './pairing-client.js'
import { readMachineIdentity } from './machine-identity.js'
import { readTrustStore } from './trust-store.js'
import { createRelayPairingRouter } from './pairing-local-routes.js'
import { checkProxyRequest } from './connector-proxy.js'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-pair-'))
  file = join(dir, 'config', 'relay.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type Reply = { status: number; body: Record<string, unknown> }

/** A scripted relay: pair/start answers once, pair/complete walks through `completes`. */
function fakeRelay(start: Reply, completes: Reply[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, body })
    const reply = url.endsWith('/pair/start') ? start : (completes.shift() ?? { status: 404, body: { status: 'not_found' } })
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const START: Reply = {
  status: 200,
  body: { userCode: 'ABCD-1234', deviceCode: 'dev-secret', verificationUrl: 'https://app.codekin.ai/pair?code=ABCD-1234', pollIntervalMs: 1000, expiresAt: Date.now() + 600_000 },
}
const COMPLETE: Reply = { status: 200, body: { status: 'complete', machineId: 'm-1', machineSecret: 'sekrit', ownerLogin: 'octocat' } }
const opts = (fetchImpl: typeof fetch) => ({ credentialFile: file, fetchImpl, hostname: 'mac', platform: 'darwin', sleep: async () => {}, log: { log: () => {}, warn: () => {} } })

describe('normalizeRelayUrl', () => {
  it('defaults to app.codekin.ai and trims trailing slashes', () => {
    expect(normalizeRelayUrl(undefined)).toBe(DEFAULT_RELAY_URL)
    expect(normalizeRelayUrl('https://relay.example.com/')).toBe('https://relay.example.com')
    expect(normalizeRelayUrl('https://relay.example.com/base//')).toBe('https://relay.example.com/base')
  })
  it('requires https, except loopback http for relay development', () => {
    expect(() => normalizeRelayUrl('http://relay.example.com')).toThrow(PairingError)
    expect(normalizeRelayUrl('http://localhost:8080')).toBe('http://localhost:8080')
    expect(() => normalizeRelayUrl('ftp://x')).toThrow(/https/)
    expect(() => normalizeRelayUrl('not a url')).toThrow(/valid URL/)
    expect(() => normalizeRelayUrl('https://u:p@relay.example.com')).toThrow(/credentials/)
  })
})

describe('safeLogin', () => {
  it('accepts GitHub logins only', () => {
    expect(safeLogin('octo-cat')).toBe('octo-cat')
    expect(safeLogin('<script>')).toBeNull()
    expect(safeLogin('\u001b[31mred')).toBeNull()
    expect(safeLogin(42)).toBeNull()
  })
})

describe('RelayPairing', () => {
  it('starts, polls through pending, and writes a managed 0600 credential', async () => {
    const relay = fakeRelay(START, [{ status: 202, body: { status: 'pending' } }, COMPLETE])
    const pairing = new RelayPairing(opts(relay.fetchImpl))
    const { state, done } = await pairing.start()
    expect(state).toMatchObject({ state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://app.codekin.ai/pair?code=ABCD-1234' })
    expect(JSON.stringify(state)).not.toContain('dev-secret')
    expect(await done).toEqual({ state: 'complete', relayUrl: DEFAULT_RELAY_URL, machineId: 'm-1', ownerLogin: 'octocat' })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ url: DEFAULT_RELAY_URL, machineId: 'm-1', machineSecret: 'sekrit', managed: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(pairing.status())).not.toContain('sekrit')
    expect(relay.calls[0].body).toEqual({ hostname: 'mac', platform: 'darwin' })
    expect(relay.calls.slice(1).every(c => c.body.deviceCode === 'dev-secret')).toBe(true)
  })

  it('reports denied and expired without writing a credential', async () => {
    for (const [reply, state] of [[{ status: 403, body: { status: 'denied' } }, 'denied'], [{ status: 410, body: { status: 'expired' } }, 'expired']] as const) {
      const pairing = new RelayPairing(opts(fakeRelay(START, [reply]).fetchImpl))
      const { done } = await pairing.start()
      expect((await done).state).toBe(state)
      expect(existsSync(file)).toBe(false)
    }
  })

  it('gives up after the code expires even if the relay keeps saying pending', async () => {
    let now = 0
    const start: Reply = { status: 200, body: { ...START.body, expiresAt: 5_000 } }
    const pending = Array.from({ length: 50 }, () => ({ status: 202, body: { status: 'pending' } }))
    const pairing = new RelayPairing({ ...opts(fakeRelay(start, pending).fetchImpl), now: () => (now += 1_000) })
    const { done } = await pairing.start()
    expect((await done).state).toBe('expired')
  })

  it('refuses to start when already paired, and returns the pending pairing instead of a second one', async () => {
    const relay = fakeRelay(START, Array.from({ length: 3 }, () => ({ status: 202, body: { status: 'pending' } })))
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const pairing = new RelayPairing({ ...opts(relay.fetchImpl), sleep: () => gate })
    const first = await pairing.start()
    const second = await pairing.start('https://other.example.com')
    expect(second.state).toBe(first.state)
    expect(relay.calls.filter(c => c.url.endsWith('/pair/start'))).toHaveLength(1)
    pairing.cancel()
    release()
    expect(pairing.status()).toEqual({ state: 'idle' })

    writeFileSync(join(dir, 'paired.json'), JSON.stringify({ url: 'https://x', machineId: 'm', machineSecret: 's' }))
    const paired = new RelayPairing({ ...opts(relay.fetchImpl), credentialFile: join(dir, 'paired.json') })
    await expect(paired.start()).rejects.toMatchObject({ code: 'already_paired' })
  })

  it('rejects a verification URL on another site', async () => {
    const evil: Reply = { status: 200, body: { ...START.body, verificationUrl: 'https://evil.example/pair?code=X' } }
    const pairing = new RelayPairing(opts(fakeRelay(evil, []).fetchImpl))
    await expect(pairing.start()).rejects.toMatchObject({ code: 'rejected' })
    expect(pairing.status()).toEqual({ state: 'idle' })
  })

  it('reports an unreachable relay', async () => {
    const pairing = new RelayPairing(opts((async () => { throw new Error('ECONNREFUSED') }) as typeof fetch))
    await expect(pairing.start()).rejects.toMatchObject({ code: 'unreachable' })
  })
})

describe('machine identity and device list at pairing', () => {
  const COMPLETE_WITH_OWNER: Reply = { status: 200, body: { ...COMPLETE.body, ownerUserId: 'u-owner' } }
  const identityFile = () => join(dir, 'config', 'relay-identity.json')
  const devicesFile = () => join(dir, 'config', 'relay-devices.json')

  it('sends a new identity key with pair/complete and saves it with an empty device list', async () => {
    const relay = fakeRelay(START, [{ status: 202, body: { status: 'pending' } }, COMPLETE_WITH_OWNER])
    const { done } = await new RelayPairing({ ...opts(relay.fetchImpl), secretStore: null }).start()
    await done
    const identity = readMachineIdentity(identityFile())
    expect(identity?.machineId).toBe('m-1')
    // Every poll carries the same key; the relay stores it on completion.
    const polls = relay.calls.slice(1)
    expect(polls.every(c => c.body.identityKey === identity?.publicKey)).toBe(true)
    expect(readTrustStore(devicesFile())).toMatchObject({ machineId: 'm-1', ownerUserId: 'u-owner', policy: 'off', credentials: [] })
  })

  it('claims a token with an identity key too, and a re-pair replaces both files', async () => {
    const first = fakeRelay(START, [COMPLETE_WITH_OWNER])
    await claimPairingToken(undefined, 'tok', true, { ...opts(first.fetchImpl), secretStore: null })
    const before = readMachineIdentity(identityFile())
    expect(first.calls[0].body.identityKey).toBe(before?.publicKey)

    rmSync(file)
    const second = fakeRelay(START, [{ status: 200, body: { ...COMPLETE_WITH_OWNER.body, machineId: 'm-2' } }])
    await claimPairingToken(undefined, 'tok2', true, { ...opts(second.fetchImpl), secretStore: null })
    const after = readMachineIdentity(identityFile())
    expect(after?.machineId).toBe('m-2')
    expect(after?.publicKey).not.toBe(before?.publicKey)
    expect(readTrustStore(devicesFile())).toMatchObject({ machineId: 'm-2', credentials: [] })
  })

  it('ignores an owner id that is not a plain identifier', async () => {
    const relay = fakeRelay(START, [{ status: 200, body: { ...COMPLETE.body, ownerUserId: '../../etc' } }])
    await claimPairingToken(undefined, 'tok', true, { ...opts(relay.fetchImpl), secretStore: null })
    expect(readTrustStore(devicesFile())?.ownerUserId).toBeNull()
  })

  it('still pairs against a relay that returns no owner id', async () => {
    const relay = fakeRelay(START, [COMPLETE])
    await claimPairingToken(undefined, 'tok', true, { ...opts(relay.fetchImpl), secretStore: null })
    expect(existsSync(file)).toBe(true)
    expect(readTrustStore(devicesFile())?.ownerUserId).toBeNull()
  })

  it('unpairing removes the identity and the device list with the credential', async () => {
    const relay = fakeRelay(START, [COMPLETE_WITH_OWNER])
    await claimPairingToken(undefined, 'tok', true, { ...opts(relay.fetchImpl), secretStore: null })
    expect(removeRelayCredential(file, null)).toBe(true)
    expect(existsSync(identityFile())).toBe(false)
    expect(existsSync(devicesFile())).toBe(false)
  })
})

describe('claimPairingToken', () => {
  it('claims a pre-approved token in one request', async () => {
    const relay = fakeRelay(START, [COMPLETE])
    const result = await claimPairingToken(undefined, 'tok', false, opts(relay.fetchImpl))
    expect(result).toEqual({ machineId: 'm-1', ownerLogin: 'octocat', relayUrl: DEFAULT_RELAY_URL })
    expect(JSON.parse(readFileSync(file, 'utf-8')).managed).toBeUndefined()
    expect(relay.calls[0].body).toMatchObject({ deviceCode: 'tok', hostname: 'mac' })
  })
  it('reports an expired token', async () => {
    const relay = fakeRelay(START, [{ status: 410, body: { status: 'expired' } }])
    await expect(claimPairingToken(undefined, 'tok', true, opts(relay.fetchImpl))).rejects.toThrow('expired')
  })
})

describe('local pairing routes', () => {
  async function serve(pairing: RelayPairing) {
    const app = express()
    app.use(express.json())
    app.use(createRelayPairingRouter(t => t === 'good', req => req.headers.authorization?.replace(/^Bearer /, ''), pairing, file))
    const server = app.listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = (method: string, path: string, body?: unknown, token = 'good') =>
      fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { call, close: () => new Promise(r => server.close(r)) }
  }

  it('requires the local token', async () => {
    const s = await serve(new RelayPairing(opts(fakeRelay(START, []).fetchImpl)))
    try {
      for (const [m, p] of [['GET', '/api/relay/pair'], ['POST', '/api/relay/pair'], ['DELETE', '/api/relay/pair'], ['POST', '/api/relay/unpair']]) {
        expect((await s.call(m, p, undefined, 'bad')).status).toBe(401)
      }
    } finally { await s.close() }
  })

  it('starts, reports, cancels, and maps errors', async () => {
    const pending = Array.from({ length: 3 }, () => ({ status: 202, body: { status: 'pending' } }))
    const s = await serve(new RelayPairing({ ...opts(fakeRelay(START, pending).fetchImpl), sleep: () => new Promise(() => {}) }))
    try {
      expect((await s.call('POST', '/api/relay/pair', { relayUrl: 'http://evil.example' })).status).toBe(400)
      const started = await s.call('POST', '/api/relay/pair', {})
      expect(started.status).toBe(200)
      expect(await started.json()).toMatchObject({ state: 'pending', userCode: 'ABCD-1234' })
      expect(await (await s.call('GET', '/api/relay/pair')).json()).toMatchObject({ state: 'pending' })
      expect(await (await s.call('DELETE', '/api/relay/pair')).json()).toEqual({ state: 'idle' })
    } finally { await s.close() }
  })

  it('unpairs by removing the local credential', async () => {
    const s = await serve(new RelayPairing(opts(fakeRelay(START, []).fetchImpl)))
    try {
      expect(await (await s.call('POST', '/api/relay/unpair')).json()).toEqual({ removed: false })
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(file, JSON.stringify({ url: 'https://x', machineId: 'm', machineSecret: 's' }))
      expect(await (await s.call('POST', '/api/relay/unpair')).json()).toEqual({ removed: true })
      expect(existsSync(file)).toBe(false)
    } finally { await s.close() }
  })
})

describe('hosted relay access', () => {
  it('can never reach the local pairing endpoints, even as the machine owner', () => {
    const principal = { userId: 'u1', role: 'owner' as const, grants: {} }
    for (const [method, path] of [['GET', '/api/relay/pair'], ['POST', '/api/relay/pair'], ['DELETE', '/api/relay/pair'], ['POST', '/api/relay/unpair'], ['GET', '/api/relay/status']]) {
      expect(checkProxyRequest({ method, path, principal }).allowed).toBe(false)
    }
  })
})
