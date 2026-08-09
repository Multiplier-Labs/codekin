/**
 * Tests for the Machines section of Settings — the machine list in its new
 * home, where one of the rows is the machine you are already on.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MachinesSection } from './MachinesSection'
import type { Machine } from './machines'

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

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

/** Mount and let the machines fetch settle. */
async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    activeRoot = createRoot(container)
    activeRoot.render(ui)
  })
  activeContainer = container
  return container
}

function stubMachines(machines: Machine[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ machines }),
  }))
}

beforeEach(() => { vi.unstubAllGlobals() })

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
  vi.unstubAllGlobals()
})

describe('MachinesSection', () => {
  it('marks the machine the workspace is connected to', async () => {
    stubMachines([machine(), machine({ id: 'm2', displayName: 'other' })])
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={vi.fn()} />)
    const rows = [...container.querySelectorAll('li')]
    expect(rows[0].textContent).toContain('connected')
    expect(rows[1].textContent).not.toContain('connected')
  })

  it('does not offer to reconnect to the machine you are already on', async () => {
    // Switching to where you already are would tear the workspace down and
    // rebuild it for nothing, so that row is not a button at all.
    stubMachines([machine(), machine({ id: 'm2', displayName: 'other' })])
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={vi.fn()} />)
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('other')
  })

  it('switches to another machine when its row is clicked', async () => {
    const onSwitch = vi.fn()
    const other = machine({ id: 'm2', displayName: 'other' })
    stubMachines([machine(), other])
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={onSwitch} />)
    act(() => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSwitch).toHaveBeenCalledWith(other)
  })

  it('offers to disconnect, naming the machine it would leave', async () => {
    // The workspace has no exit button any more, so this is the only way back
    // to the picker — it must be plain text, not a hover or a menu.
    const onDisconnect = vi.fn()
    stubMachines([machine()])
    const container = await render(
      <MachinesSection currentMachineId="m1" onSwitch={vi.fn()} onDisconnect={onDisconnect} />,
    )
    const button = [...container.querySelectorAll('button')]
      .find(b => b.textContent?.startsWith('Disconnect'))
    expect(button?.textContent).toBe('Disconnect from hatchery')
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onDisconnect).toHaveBeenCalled()
  })

  it('omits the disconnect action where there is nothing to disconnect from', async () => {
    stubMachines([machine()])
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={vi.fn()} />)
    expect(container.textContent).not.toContain('Disconnect')
  })

  it('says so when the relay cannot be reached, rather than showing an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={vi.fn()} />)
    expect(container.textContent).toContain('Could not reach the relay')
  })
})
