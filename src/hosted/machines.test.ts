/**
 * Tests for the remembered hosted connection — the thing that decides whether
 * a reload lands you back in your chat or on the machine picker.
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  decideRestore, forgetMachine, lastMachineId, rememberMachine,
  type Machine, installCommands,
} from './machines'
import { resetUserPrefsForTests } from './userPrefs'

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm1',
    displayName: 'hatchery',
    hostname: 'hatchery',
    platform: 'linux',
    connectorVersion: '0.8.0',
    localCodekinVersion: '0.8.0',
    status: 'online',
    lastSeenAt: null,
    ...overrides,
  }
}

describe('remembered machine', () => {
  const fetchMock = vi.fn(async () => new Response('{}'))
  beforeEach(() => {
    resetUserPrefsForTests()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('remembers the machine that was connected to, on the relay', () => {
    rememberMachine('m1')
    expect(lastMachineId()).toBe('m1')
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ machineId: 'm1' }),
    }))
  })

  it('forgets it when the user leaves the machine on purpose', async () => {
    rememberMachine('m1')
    await forgetMachine()
    expect(lastMachineId()).toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/me/preferences', expect.objectContaining({
      body: JSON.stringify({ machineId: null }),
    }))
  })

  it('has nothing to restore before the first connection', () => {
    expect(lastMachineId()).toBeNull()
  })
})

describe('decideRestore', () => {
  it('reconnects to a remembered machine that is online', () => {
    const m = machine()
    expect(decideRestore([m], 'm1')).toEqual({ action: 'connect', machine: m })
  })

  it('reconnects to a degraded machine — it still answers', () => {
    const m = machine({ status: 'degraded' })
    expect(decideRestore([m], 'm1')).toEqual({ action: 'connect', machine: m })
  })

  it('waits rather than dialling a machine that is offline', () => {
    // Connecting would land the reload on the connect gate's error screen;
    // the memory is kept, because the machine is only down, not gone.
    expect(decideRestore([machine({ status: 'offline' })], 'm1')).toEqual({ action: 'wait' })
  })

  it('forgets a machine that is no longer on the account', () => {
    expect(decideRestore([machine({ id: 'other' })], 'm1')).toEqual({ action: 'forget' })
  })

  it('forgets when nothing was remembered', () => {
    expect(decideRestore([machine()], null)).toEqual({ action: 'forget' })
  })

  it('forgets when the account has no machines at all', () => {
    expect(decideRestore([], 'm1')).toEqual({ action: 'forget' })
  })
})

describe('installCommands', () => {
  it('fetches the installer over https and passes the token via the environment', () => {
    const { install, login } = installCommands('tok123', 'https://app.codekin.ai')
    expect(install).toBe('curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=tok123 bash')
    expect(login).toBe('CODEKIN_PAIR_TOKEN=tok123 codekin relay login')
    // The token is never an argument (visible in `ps`)
    expect(install).not.toContain('--pair')
    expect(login).not.toContain('--code')
  })

  it('names a non-default relay explicitly', () => {
    const { install, login } = installCommands('tok', 'https://relay.example.com')
    expect(install).toBe('curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=tok bash -s -- --relay https://relay.example.com')
    expect(login).toBe('CODEKIN_PAIR_TOKEN=tok codekin relay login --url https://relay.example.com')
  })
})
