/** Tests for the GitHub webhook row in the Machines section. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MachineWebhook } from './MachineWebhook'
import type { Machine } from './machines'

const machine: Machine = {
  id: 'm1',
  displayName: 'hatchery',
  hostname: 'hatchery',
  platform: 'linux',
  connectorVersion: '0.10.6',
  localCodekinVersion: '0.10.6',
  status: 'online',
  lastSeenAt: null,
  access: 'owner',
}

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<MachineWebhook machine={machine} />)
  })
  return container
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) })
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('MachineWebhook', () => {
  it('turns the receiver on and shows the URL once', async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(respond({ enabled: false, createdAt: null, lastDeliveryAt: null }))
      .mockReturnValueOnce(respond({
        enabled: true, createdAt: '2026-11-08 10:00:00', lastDeliveryAt: null,
        url: 'https://relay.example.com/api/hooks/github/tok',
      }))
    vi.stubGlobal('fetch', fetchMock)
    const el = await render()

    await act(async () => { button(el, 'Turn on').click() })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/machines/m1/webhook', expect.objectContaining({ method: 'POST' }))
    expect(el.textContent).toContain('https://relay.example.com/api/hooks/github/tok')
    expect(el.textContent).toContain('application/json')
    expect(button(el, 'New URL')).toBeTruthy()
  })

  it('asks before turning it off', async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(respond({ enabled: true, createdAt: '2026-11-08 10:00:00', lastDeliveryAt: null }))
      .mockReturnValueOnce(respond({ enabled: false, createdAt: null, lastDeliveryAt: null }))
    vi.stubGlobal('fetch', fetchMock)
    const el = await render()
    expect(el.textContent).not.toContain('/api/hooks/github/')

    await act(async () => { button(el, 'Turn off').click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const confirm = el.querySelector('[aria-label="Confirm turning off"]') as HTMLElement
    await act(async () => { button(confirm, 'Turn off').click() })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/machines/m1/webhook', expect.objectContaining({ method: 'DELETE' }))
    expect(button(el, 'Turn on')).toBeTruthy()
  })

  it('says so when the setting cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respond({}, false)))
    const el = await render()
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
  })
})
