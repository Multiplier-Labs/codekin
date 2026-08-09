/**
 * Tests for Settings in `machinesOnly` mode — what a hosted user sees when no
 * machine is connected. It is the whole screen, not a modal over an app, and
 * every other section is suppressed because those settings live on a machine.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Settings } from './Settings'
import type { Settings as SettingsType } from '../types'

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

const settings: SettingsType = { token: 'hosted', fontSize: 14, theme: 'dark' }

const machine = {
  id: 'm1', displayName: 'hatchery', hostname: 'hatchery', platform: 'linux',
  connectorVersion: '0.8.0', localCodekinVersion: '0.8.0',
  status: 'online' as const, lastSeenAt: null,
}

/**
 * Mount and settle. The machines section is lazy and then fetches, so the tree
 * needs several turns of the microtask queue before it is final — one flush
 * resolves the import, the next its request.
 */
async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    activeRoot = createRoot(container)
    activeRoot.render(ui)
  })
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  activeContainer = container
  return container
}

// The section is lazy in the app so the local build never pulls it in. Warm
// the module here, or the first mount of the suite settles on the fallback.
beforeAll(async () => { await import('../hosted/MachinesSection') })

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
  vi.unstubAllGlobals()
})

function stubMachines(machines: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ machines }),
  }))
}

describe('Settings — machines only', () => {
  it('shows the machine list and nothing that needs a machine to answer', async () => {
    stubMachines([machine])
    const container = await render(
      <Settings
        open machinesOnly
        settings={settings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        onSwitchMachine={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('Machines')
    expect(container.textContent).toContain('hatchery')
    // Every other section reads or writes through a machine.
    expect(container.textContent).not.toContain('Authentication')
    expect(container.textContent).not.toContain('Preferences')
    expect(container.textContent).not.toContain('Permissions')
    expect(container.textContent).not.toContain('GitHub Webhooks')
  })

  it('asks no machine-backed questions while disconnected', async () => {
    // The full dialog fetches retention, webhooks and approvals when it opens.
    // Disconnected there is nothing to ask, and asking would hit the relay's
    // own API rather than a machine.
    stubMachines([machine])
    await render(
      <Settings open machinesOnly settings={settings} onUpdate={vi.fn()} onClose={vi.fn()} onSwitchMachine={vi.fn()} />,
    )
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.every(([url]) => String(url) === '/api/machines')).toBe(true)
  })

  it('connects to the machine that is clicked', async () => {
    const onSwitchMachine = vi.fn()
    stubMachines([machine])
    const container = await render(
      <Settings open machinesOnly settings={settings} onUpdate={vi.fn()} onClose={vi.fn()} onSwitchMachine={onSwitchMachine} />,
    )
    const row = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('hatchery'))
    act(() => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSwitchMachine).toHaveBeenCalledWith(machine)
  })

  it('offers sign out, the only other thing there is to do here', async () => {
    const onSignOut = vi.fn()
    stubMachines([machine])
    const container = await render(
      <Settings
        open machinesOnly
        settings={settings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        onSwitchMachine={vi.fn()}
        onSignOut={onSignOut}
        signedInAs="alari76"
      />,
    )
    expect(container.textContent).toContain('alari76')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Sign out')
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSignOut).toHaveBeenCalled()
  })

  it('tells a user with nothing paired how to pair', async () => {
    stubMachines([])
    const container = await render(
      <Settings open machinesOnly settings={settings} onUpdate={vi.fn()} onClose={vi.fn()} onSwitchMachine={vi.fn()} />,
    )
    expect(container.textContent).toContain('No machines paired yet.')
    expect(container.textContent).toContain('codekin relay login')
    expect(container.textContent).toContain('codekin relay connect')
  })
})
