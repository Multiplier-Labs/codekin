/**
 * Tests for the remembered hosted connection — the thing that decides whether
 * a reload lands you back in your chat or on the machine picker.
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest'
import {
  decideRestore, forgetMachine, lastMachineId, rememberMachine,
  LAST_MACHINE_KEY, type Machine,
} from './machines'

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
  beforeEach(() => { localStorage.clear() })

  it('remembers the machine that was connected to', () => {
    rememberMachine('m1')
    expect(lastMachineId()).toBe('m1')
    expect(localStorage.getItem(LAST_MACHINE_KEY)).toBe('m1')
  })

  it('forgets it when the user leaves the machine on purpose', () => {
    rememberMachine('m1')
    forgetMachine()
    expect(lastMachineId()).toBeNull()
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
