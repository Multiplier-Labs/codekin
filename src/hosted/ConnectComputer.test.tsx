/** Tests for the first-run "Connect your computer" surface. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectComputer } from './ConnectComputer'
import { useMachineSetup } from './useMachineSetup'
import type { Machine } from './machines'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
})

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm1',
    displayName: 'laptop',
    hostname: 'laptop',
    platform: 'darwin',
    connectorVersion: '0.9.0',
    localCodekinVersion: '0.9.0',
    status: 'online',
    lastSeenAt: null,
    access: 'owner',
    setupPending: false,
    pairingExpiresAt: null,
    ...overrides,
  }
}

function Harness({ onOpen = vi.fn(), onAccount = vi.fn() }: { onOpen?: (m: Machine) => void; onAccount?: () => void }) {
  const setup = useMachineSetup({ pollWhileEmpty: true })
  return <ConnectComputer setup={setup} onOpen={onOpen} onAccount={onAccount} onSignOut={vi.fn()} signedInAs="octocat" />
}

function stubRelay(state: { machines: Machine[] }) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/machines') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ machines: state.machines }) })
    }
    if (url === '/api/machines/pair/precreate') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ pairingToken: 'tok-first', machineId: 'm-new', expiresAt: Date.now() + 600_000 }),
      })
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function render(ui: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(ui)
  })
  await act(async () => { await Promise.resolve() })
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

function button(text: string) {
  return [...container!.querySelectorAll('button')].find(b => b.textContent?.includes(text))
}

describe('ConnectComputer', () => {
  it('explains the model and prerequisites, without account administration', async () => {
    stubRelay({ machines: [] })
    await render(<Harness />)
    const text = container!.textContent ?? ''
    expect(text).toContain('Connect your computer')
    expect(text).toContain('runs coding agents on your own computer')
    expect(text).toContain('macOS or Linux')
    expect(text).toContain("Windows isn't supported yet")
    expect(text).toContain('Node.js 20')
    expect(text).toContain('Claude Code, Codex, or OpenCode')
    expect(text).toContain('Waiting for installation')
    // Account admin is one link away, not on this surface
    expect(text).not.toContain('Sign out everywhere')
    expect(text).not.toContain('Link a device')
    expect(button('Generate install command')).toBeDefined()
  })

  it('keeps polling while nothing is connected and offers Open when a machine comes online', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const state = { machines: [] as Machine[] }
    stubRelay(state)
    const onOpen = vi.fn()
    await render(<Harness onOpen={onOpen} />)

    await act(async () => { button('Generate install command')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(container!.textContent).toContain('CODEKIN_PAIR_TOKEN=tok-first')

    state.machines = [machine({ id: 'm-new', status: 'offline' })]
    await act(async () => { vi.advanceTimersByTime(2600) })
    await flush()
    expect(container!.textContent).toContain('laptop is paired')
    expect(container!.querySelector('[aria-current="step"]')?.textContent).toBe('2Paired')

    const online = machine({ id: 'm-new' })
    state.machines = [online]
    await act(async () => { vi.advanceTimersByTime(2600) })
    await flush()
    act(() => { button('Open laptop')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpen).toHaveBeenCalledWith(online)
  })

  it('opens the account view from the header', async () => {
    stubRelay({ machines: [] })
    const onAccount = vi.fn()
    await render(<Harness onAccount={onAccount} />)
    act(() => { button('Account')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onAccount).toHaveBeenCalled()
  })

  it('on a narrow screen, hands off to the computer with a token-free link', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, share, clipboard: { writeText } })
    stubRelay({ machines: [] })
    await render(<Harness />)

    expect(container!.querySelector('[data-testid="handoff"]')).not.toBeNull()
    expect(container!.textContent).toContain('Continue on your computer')

    await act(async () => { button('Copy link to this page')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/`)

    act(() => { button('Share')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/` }))

    // The command is still reachable, for someone reading it off the phone.
    act(() => { button('Show the install command here anyway')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(button('Generate install command')).toBeDefined()
  })
})
