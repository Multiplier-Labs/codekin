/** Tests for the relay webhook URL on Settings → Webhooks (hosted mode). */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RelayWebhookUrl } from './RelayWebhookUrl'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(onUrl = vi.fn()): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<RelayWebhookUrl machineId="m1" onUrl={onUrl} />)
  })
  return container
}

function button(el: Element, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

function respond(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
}

const ON = { enabled: true, createdAt: '2026-11-08 10:00:00', lastDeliveryAt: '2026-11-08 10:17:15', url: 'https://relay.example.com/api/hooks/github/tok1' }
const OFF = { enabled: false, createdAt: null, lastDeliveryAt: null, url: null }

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('RelayWebhookUrl', () => {
  it('shows the existing URL and reports it to the page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respond(ON)))
    const onUrl = vi.fn()
    const el = await render(onUrl)
    expect(el.textContent).toContain(ON.url)
    expect(onUrl).toHaveBeenLastCalledWith(ON.url)
  })

  it('turns a URL on when there is none', async () => {
    const fetchMock = vi.fn().mockReturnValueOnce(respond(OFF)).mockReturnValueOnce(respond(ON))
    vi.stubGlobal('fetch', fetchMock)
    const onUrl = vi.fn()
    const el = await render(onUrl)
    expect(onUrl).toHaveBeenLastCalledWith(null)
    await act(async () => { button(el, 'Turn on').click() })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/machines/m1/webhook', expect.objectContaining({ method: 'POST' }))
    expect(el.textContent).toContain(ON.url)
    expect(onUrl).toHaveBeenLastCalledWith(ON.url)
  })

  it('asks before replacing the URL, since GitHub still points at the old one', async () => {
    const next = { ...ON, url: 'https://relay.example.com/api/hooks/github/tok2' }
    const fetchMock = vi.fn().mockReturnValueOnce(respond(ON)).mockReturnValueOnce(respond(next))
    vi.stubGlobal('fetch', fetchMock)
    const el = await render()
    await act(async () => { button(el, 'New URL').click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const confirm = el.querySelector('[aria-label="Confirm new URL"]')!
    await act(async () => { button(confirm, 'Replace URL').click() })
    expect(el.textContent).toContain(next.url)
  })

  it('asks before turning it off', async () => {
    const fetchMock = vi.fn().mockReturnValueOnce(respond(ON)).mockReturnValueOnce(respond(OFF))
    vi.stubGlobal('fetch', fetchMock)
    const el = await render()
    await act(async () => { button(el, 'Turn off').click() })
    const confirm = el.querySelector('[aria-label="Confirm turning off"]')!
    await act(async () => { button(confirm, 'Turn off').click() })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/machines/m1/webhook', expect.objectContaining({ method: 'DELETE' }))
    expect(button(el, 'Turn on')).toBeTruthy()
  })

  it('tells a non-owner the URL is the owner’s to manage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respond({ error: 'forbidden' }, 403)))
    const el = await render()
    expect(el.textContent).toContain('Only this machine’s owner')
    expect(el.querySelector('button')).toBeNull()
  })
})
