/**
 * The Machines section says when the relay alone can control a computer, and
 * offers the way to stop it (signed-intents spec §6.8).
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Machine } from './machines'

const trust = vi.hoisted(() => ({ pinned: new Set<string>(), raise: vi.fn() }))
vi.mock('./deviceTrust', async importOriginal => ({
  ...(await importOriginal<typeof import('./deviceTrust')>()),
  deviceTrustSupported: () => true,
  currentUserId: () => Promise.resolve('u-owner'),
  machinePin: (_userId: string, machineId: string) => Promise.resolve(trust.pinned.has(machineId) ? { machineId } : undefined),
  requireConfirmedDevices: trust.raise,
}))
vi.mock('../lib/transport/relay-client', () => ({
  RelayConnection: class { connect() {} close() {} enrol() { return Promise.resolve({}) } },
}))

import { MachinesSection } from './MachinesSection'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm1', displayName: 'hatchery', hostname: 'hatchery', platform: 'linux',
    connectorVersion: '0.10.6', localCodekinVersion: '0.10.6', status: 'online', lastSeenAt: null, access: 'owner',
    ...overrides,
  }
}

async function render(machines: Machine[]): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ machines }) }))
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<MachinesSection currentMachineId="other" onSwitch={vi.fn()} />)
  })
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
  return container
}

beforeEach(() => {
  trust.pinned = new Set()
  trust.raise.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  vi.unstubAllGlobals()
})

describe('MachinesSection policy', () => {
  it('says the relay can control a computer, and asks it to require confirmed devices from a confirmed browser', async () => {
    trust.pinned.add('m1')
    const el = await render([machine({ intentPolicy: 'warn' })])
    expect(el.textContent).toContain('The relay can control this computer (unsigned requests are only logged)')
    const button = [...el.querySelectorAll('button')].find(b => b.textContent === 'Require confirmed devices')!
    await act(async () => { button.click() })
    expect(trust.raise).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('Only devices confirmed on it can control it')
  })

  it('points an unconfirmed browser at confirming itself', async () => {
    const el = await render([machine({ intentPolicy: 'off' })])
    expect(el.textContent).toContain('Confirm this browser to protect it')
    expect([...el.querySelectorAll('button')].some(b => b.textContent === 'Require confirmed devices')).toBe(false)
  })

  it('asks for an update where the connector reports no policy, and is quiet once required', async () => {
    expect((await render([machine({ intentPolicy: null })])).textContent).toContain('Update Codekin on it to protect it')
    act(() => { root!.unmount() })
    root = null
    expect((await render([machine({ intentPolicy: 'required' })])).textContent).toContain('Only devices confirmed on it can control it')
  })

  it('flags a computer the workspace refuses, or soon will, until a device is confirmed on it', async () => {
    const el = await render([
      machine({ confirmedDevices: 'refused' }),
      machine({ id: 'm2', displayName: 'laptop', confirmedDevices: 'grace' }),
      machine({ id: 'm3', displayName: 'fine', confirmedDevices: 'confirmed' }),
    ])
    const rows = [...el.querySelectorAll('li')]
    const badge = (row: Element) => [...row.querySelectorAll('span')].find(s => s.textContent === 'confirm a device')
    expect(badge(rows[0])?.getAttribute('title')).toContain('Confirm a browser on this computer to use it again')
    expect(badge(rows[1])?.getAttribute('title')).toContain('will soon require')
    expect(badge(rows[2])).toBeUndefined()
  })
})
