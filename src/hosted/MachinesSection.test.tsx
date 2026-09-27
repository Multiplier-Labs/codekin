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
    const rowButtons = [...container.querySelectorAll('button')].filter(b => b.title.startsWith('Connect to'))
    expect(rowButtons).toHaveLength(1)
    expect(rowButtons[0].textContent).toContain('other')
  })

  it('switches to another machine when its row is clicked', async () => {
    const onSwitch = vi.fn()
    const other = machine({ id: 'm2', displayName: 'other' })
    stubMachines([machine(), other])
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={onSwitch} />)
    act(() => {
      container.querySelector('button[title="Connect to other"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

  it('gives a user with nothing paired the two commands that pair a machine', async () => {
    stubMachines([])
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    expect(container.textContent).toContain('No machines paired yet.')
    expect(container.textContent).toContain('codekin relay login')
  })

  it('says so when the relay cannot be reached, rather than showing an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const container = await render(<MachinesSection currentMachineId="m1" onSwitch={vi.fn()} />)
    expect(container.textContent).toContain('Could not reach the relay')
  })
})

// ---------------------------------------------------------------------------
// Adding a computer: generate, follow setup, recover.
// ---------------------------------------------------------------------------

interface Call { method: string; url: string; body: unknown }

/**
 * A tiny fake relay. `state.machines` is what GET /api/machines returns next
 * (or `state.listFails` makes it fail); precreate answers from `state.precreate`.
 */
function fakeRelay() {
  const calls: Call[] = []
  const state = {
    machines: [] as Machine[],
    listFails: false,
    precreate: [] as Array<{ status: number; body: unknown }>,
  }
  const json = (status: number, body: unknown) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/machines' && method === 'GET') {
      return state.listFails ? Promise.reject(new Error('503')) : json(200, { machines: state.machines })
    }
    if (url === '/api/machines/pair/precreate') {
      const next = state.precreate.shift() ?? { status: 500, body: {} }
      return json(next.status, next.body)
    }
    if (method === 'DELETE') return json(200, { success: true })
    return json(404, {})
  }))
  return { calls, state }
}

function click(el: Element | undefined | null) {
  expect(el).toBeTruthy()
  act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))
}

/** Let pending promises (fetch mocks) settle inside act. */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('MachinesSection — adding a computer', () => {
  afterEach(() => { vi.useRealTimers() })

  it('offers "Add computer" alongside existing machines, including shared ones', async () => {
    const relay = fakeRelay()
    relay.state.machines = [machine({ access: 'shared' })]
    relay.state.precreate.push({ status: 200, body: { pairingToken: 'tok-1', machineId: 'm-new', expiresAt: Date.now() + 600_000 } })
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)

    click(buttonWithText(container, 'Add computer'))
    await flush()

    expect(relay.calls.some(c => c.url === '/api/machines/pair/precreate')).toBe(true)
    expect(container.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-1')
    expect(container.textContent).toContain('Waiting for installation')
  })

  it('shows an unfinished setup as waiting, and regenerates it with replaceMachineId', async () => {
    const relay = fakeRelay()
    relay.state.machines = [
      machine(),
      machine({ id: 'm-pending', displayName: 'Unnamed machine', status: 'offline', setupPending: true, pairingExpiresAt: Date.now() + 300_000, access: 'owner' }),
    ]
    relay.state.precreate.push({ status: 200, body: { pairingToken: 'tok-2', machineId: 'm-fresh', expiresAt: Date.now() + 600_000 } })
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)

    expect(container.textContent).toContain('Waiting for installation')
    expect(container.textContent).toContain("can't be displayed again")
    // Not presented as an ordinary machine you could connect to
    expect(container.querySelector('button[title="Connect to Unnamed machine"]')).toBeNull()

    click(buttonWithText(container, 'Regenerate'))
    await flush()
    const precreate = relay.calls.find(c => c.url === '/api/machines/pair/precreate')
    expect(precreate?.body).toEqual({ replaceMachineId: 'm-pending' })
    expect(container.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-2')
  })

  it('cancels an unfinished setup with DELETE', async () => {
    const relay = fakeRelay()
    relay.state.machines = [machine({ id: 'm-pending', setupPending: true, status: 'offline', pairingExpiresAt: Date.now() + 300_000 })]
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)

    relay.state.machines = []
    click(buttonWithText(container, 'Cancel'))
    await flush()
    expect(relay.calls.some(c => c.method === 'DELETE' && c.url === '/api/machines/m-pending')).toBe(true)
    expect(container.textContent).not.toContain('Waiting for installation')
  })

  it('polls while setup is pending and offers Open once the machine is online', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const relay = fakeRelay()
    relay.state.precreate.push({ status: 200, body: { pairingToken: 'tok-3', machineId: 'm-new', expiresAt: Date.now() + 600_000 } })
    const onSwitch = vi.fn()
    const container = await render(<MachinesSection currentMachineId="" onSwitch={onSwitch} />)

    relay.state.machines = [machine({ id: 'm-new', displayName: 'Unnamed machine', status: 'offline', setupPending: true, pairingExpiresAt: Date.now() + 600_000 })]
    click(buttonWithText(container, 'Add computer'))
    await flush()
    expect(container.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-3')

    // The installer runs; the machine is claimed and connects.
    const online = machine({ id: 'm-new', displayName: 'laptop', status: 'online', setupPending: false, pairingExpiresAt: null })
    relay.state.machines = [online]
    await act(async () => { vi.advanceTimersByTime(2600) })
    await flush()

    expect(container.textContent).toContain('laptop is online and ready')
    click(buttonWithText(container, 'Open laptop'))
    expect(onSwitch).toHaveBeenCalledWith(online)
  })

  it('does not poll when nothing is pending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const relay = fakeRelay()
    relay.state.machines = [machine()]
    await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    const before = relay.calls.length
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(relay.calls.length).toBe(before)
  })

  it('retries a failed list in place', async () => {
    const relay = fakeRelay()
    relay.state.listFails = true
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    expect(container.textContent).toContain('Could not reach the relay')

    relay.state.listFails = false
    relay.state.machines = [machine()]
    click(buttonWithText(container, 'Retry'))
    await flush()
    expect(container.textContent).toContain('hatchery')
    expect(container.textContent).not.toContain('Could not reach the relay')
  })

  it('keeps a displayed command when a refresh fails, and offers Retry', async () => {
    const relay = fakeRelay()
    relay.state.precreate.push({ status: 200, body: { pairingToken: 'tok-4', machineId: 'm-new', expiresAt: Date.now() + 600_000 } })
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    click(buttonWithText(container, 'Add computer'))
    await flush()

    relay.state.listFails = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(container.textContent).toContain('Could not refresh the machine list')
    expect(container.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-4')
    expect(buttonWithText(container, 'Retry')).toBeDefined()
  })

  it('shows a rate-limited regeneration next to the still-displayed command', async () => {
    const relay = fakeRelay()
    relay.state.precreate.push(
      { status: 200, body: { pairingToken: 'tok-5', machineId: 'm-new', expiresAt: Date.now() + 600_000 } },
      { status: 429, body: { error: 'Too many requests' } },
    )
    relay.state.machines = [machine({ id: 'm-new', setupPending: true, status: 'offline', pairingExpiresAt: Date.now() + 600_000 })]
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    click(buttonWithText(container, 'Add computer'))
    await flush()

    click(buttonWithText(container, 'regenerate'))
    await flush()
    const regen = relay.calls.filter(c => c.url === '/api/machines/pair/precreate')[1]
    expect(regen.body).toEqual({ replaceMachineId: 'm-new' })
    expect(container.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-5')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many install commands')
  })

  it('lets an owner remove a machine after confirming; shared machines have no Remove', async () => {
    const relay = fakeRelay()
    relay.state.machines = [
      machine({ id: 'mine', displayName: 'mine', access: 'owner' }),
      machine({ id: 'theirs', displayName: 'theirs', access: 'shared' }),
    ]
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    expect(container.querySelector('button[aria-label="Remove theirs"]')).toBeNull()

    click(container.querySelector('button[aria-label="Remove mine"]'))
    expect(container.textContent).toContain('revokes the credential')
    expect(relay.calls.some(c => c.method === 'DELETE')).toBe(false)

    relay.state.machines = [machine({ id: 'theirs', displayName: 'theirs', access: 'shared' })]
    click([...container.querySelectorAll('button')].find(b => b.textContent === 'Remove'))
    await flush()
    expect(relay.calls.some(c => c.method === 'DELETE' && c.url === '/api/machines/mine')).toBe(true)
    expect(container.querySelector('button[title="Connect to mine"]')).toBeNull()
  })

  it('never writes the pairing token to storage or the URL', async () => {
    const relay = fakeRelay()
    relay.state.precreate.push({ status: 200, body: { pairingToken: 'tok-secret', machineId: 'm-new', expiresAt: Date.now() + 600_000 } })
    localStorage.clear()
    sessionStorage.clear()
    const container = await render(<MachinesSection currentMachineId="" onSwitch={vi.fn()} />)
    click(buttonWithText(container, 'Add computer'))
    await flush()
    expect(container.textContent).toContain('tok-secret')
    const stored = [
      ...Object.keys(localStorage).map(k => localStorage.getItem(k) ?? ''),
      ...Object.keys(sessionStorage).map(k => sessionStorage.getItem(k) ?? ''),
    ].join('\n')
    expect(stored).not.toContain('tok-secret')
    expect(window.location.href).not.toContain('tok-secret')
  })
})
