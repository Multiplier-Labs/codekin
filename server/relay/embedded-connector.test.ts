/** Tests for the in-process relay connector supervisor and its status route. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import type { AddressInfo } from 'net'
import type { ConnectorOptions } from './connector.js'
import {
  EmbeddedConnectorSupervisor,
  createRelayStatusRouter,
  embeddedConnectorDisabled,
} from './embedded-connector.js'
import { readRelayCredential } from './relay-credential.js'

interface FakeConnector {
  opts: ConnectorOptions
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

describe('EmbeddedConnectorSupervisor', () => {
  let dir: string
  let file: string
  let created: FakeConnector[]
  let bump: number
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

  function writeCredential(fields: Record<string, unknown>): void {
    writeFileSync(file, JSON.stringify({ url: 'https://relay.test', machineSecret: 's3cret', ...fields }))
    // Guarantee a new stat signature even within one filesystem tick
    bump += 10
    utimesSync(file, new Date(), new Date(Date.now() + bump * 1000))
  }

  function supervisor(extra: { disabled?: boolean } = {}): EmbeddedConnectorSupervisor {
    return new EmbeddedConnectorSupervisor({
      version: '1.2.3',
      credentialFile: file,
      log,
      ...extra,
      createConnector: (opts) => {
        const fake: FakeConnector = { opts, start: vi.fn(), stop: vi.fn() }
        created.push(fake)
        return fake
      },
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-embedded-'))
    file = join(dir, 'relay.json')
    created = []
    bump = 0
    log.log.mockClear(); log.warn.mockClear(); log.error.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports unpaired and starts nothing without a credential', () => {
    const sup = supervisor()
    sup.check()
    expect(sup.status()).toEqual({ paired: false, managed: false, state: 'unpaired', machineId: null, relayUrl: null })
    expect(created).toHaveLength(0)
  })

  it('leaves an unmanaged (legacy) credential alone', () => {
    writeCredential({ machineId: 'm1' })
    const sup = supervisor()
    sup.check()
    expect(created).toHaveLength(0)
    expect(sup.status()).toMatchObject({ paired: true, managed: false, state: 'unmanaged', machineId: 'm1' })
  })

  it('starts a connector for a managed credential and tracks its status', () => {
    writeCredential({ machineId: 'm1', managed: true })
    const sup = supervisor()
    sup.check()
    expect(created).toHaveLength(1)
    expect(created[0].start).toHaveBeenCalledOnce()
    expect(created[0].opts).toMatchObject({
      relayUrl: 'https://relay.test', machineId: 'm1', machineSecret: 's3cret', connectorVersion: '1.2.3',
    })
    expect(sup.status().state).toBe('connecting')

    created[0].opts.onStatus?.('connected', 'Laptop')
    expect(sup.status()).toMatchObject({ state: 'connected', detail: 'Laptop', managed: true, relayUrl: 'https://relay.test' })

    created[0].opts.onStatus?.('disconnected', 'code 1006')
    expect(sup.status().state).toBe('disconnected')
    // A reconnect attempt stays "disconnected" until it lands
    created[0].opts.onStatus?.('connecting')
    expect(sup.status().state).toBe('disconnected')
  })

  it('does not start when disabled by CODEKIN_RELAY_CONNECTOR=off', () => {
    writeCredential({ machineId: 'm1', managed: true })
    const sup = supervisor({ disabled: true })
    sup.check()
    expect(created).toHaveLength(0)
    expect(sup.status()).toMatchObject({ paired: true, managed: true, state: 'disabled' })
  })

  it('picks up a credential written after startup, and stops on logout', () => {
    const sup = supervisor()
    sup.check()
    expect(created).toHaveLength(0)

    writeCredential({ machineId: 'm1', managed: true })
    sup.check()
    expect(created).toHaveLength(1)

    // Unchanged file: no restart
    sup.check()
    expect(created).toHaveLength(1)

    rmSync(file)
    sup.check()
    expect(created[0].stop).toHaveBeenCalledOnce()
    expect(sup.status().state).toBe('unpaired')
  })

  it('restarts when the credential names another machine', () => {
    writeCredential({ machineId: 'm1', managed: true })
    const sup = supervisor()
    sup.check()
    writeCredential({ machineId: 'm2', managed: true })
    sup.check()
    expect(created).toHaveLength(2)
    expect(created[0].stop).toHaveBeenCalledOnce()
    expect(created[1].opts.machineId).toBe('m2')
    // Late status from the old connector is ignored
    created[0].opts.onStatus?.('connected', 'old')
    expect(sup.status()).toMatchObject({ state: 'connecting', machineId: 'm2' })
  })

  it.each(['replaced', 'auth_failed'] as const)('stops and does not flap after %s', (status) => {
    writeCredential({ machineId: 'm1', managed: true })
    const sup = supervisor()
    sup.check()
    created[0].opts.onStatus?.(status, 'reason')
    expect(sup.status()).toMatchObject({ state: status, detail: 'reason' })
    expect(log.error).toHaveBeenCalledOnce()

    // Rewriting the same credential (touch) does not restart it
    writeCredential({ machineId: 'm1', managed: true })
    sup.check()
    expect(created).toHaveLength(1)

    // A fresh pairing does
    writeCredential({ machineId: 'm1', managed: true, machineSecret: 'new-secret' })
    sup.check()
    expect(created).toHaveLength(2)
  })

  it('polls on an interval once started, and stop() tears down', () => {
    vi.useFakeTimers()
    try {
      const sup = new EmbeddedConnectorSupervisor({
        version: '1', credentialFile: file, log, pollIntervalMs: 1000,
        createConnector: (opts) => {
          const fake: FakeConnector = { opts, start: vi.fn(), stop: vi.fn() }
          created.push(fake)
          return fake
        },
      })
      sup.start()
      writeCredential({ machineId: 'm1', managed: true })
      vi.advanceTimersByTime(1000)
      expect(created).toHaveLength(1)
      sup.stop()
      expect(created[0].stop).toHaveBeenCalledOnce()
      expect(sup.status().state).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('relay credential', () => {
  it('reads managed as false unless explicitly true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-cred-'))
    const file = join(dir, 'relay.json')
    try {
      writeFileSync(file, JSON.stringify({ url: 'u', machineId: 'm', machineSecret: 's' }))
      expect(readRelayCredential(file)?.managed).toBe(false)
      writeFileSync(file, JSON.stringify({ url: 'u', machineId: 'm', machineSecret: 's', managed: true }))
      expect(readRelayCredential(file)?.managed).toBe(true)
      writeFileSync(file, '{not json')
      expect(readRelayCredential(file)).toBeNull()
      expect(readRelayCredential(join(dir, 'missing.json'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CODEKIN_RELAY_CONNECTOR=off disables the embedded connector', () => {
    expect(embeddedConnectorDisabled({ CODEKIN_RELAY_CONNECTOR: 'off' })).toBe(true)
    expect(embeddedConnectorDisabled({ CODEKIN_RELAY_CONNECTOR: 'OFF' })).toBe(true)
    expect(embeddedConnectorDisabled({})).toBe(false)
    expect(embeddedConnectorDisabled({ CODEKIN_RELAY_CONNECTOR: 'on' })).toBe(false)
  })
})

describe('GET /api/relay/status', () => {
  it('requires the local auth token and returns the supervisor status', async () => {
    const app = express()
    const status = { paired: true, managed: true, state: 'connected' as const, machineId: 'm1', relayUrl: 'https://r' }
    app.use(createRelayStatusRouter(
      (token) => token === 'good',
      (req) => req.headers.authorization?.replace(/^Bearer /, ''),
      { status: () => status },
    ))
    const server = await new Promise<import('http').Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => { resolve(s) })
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/relay/status`
    try {
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: 'Bearer bad' } })).status).toBe(401)
      const ok = await fetch(url, { headers: { Authorization: 'Bearer good' } })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual(status)
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  })
})
