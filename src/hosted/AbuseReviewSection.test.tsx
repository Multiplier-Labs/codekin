// @vitest-environment jsdom
/** Tests for the operator's abuse review list: shows flags, and resolving needs a note. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbuseReviewSection } from './AccountPages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./mfa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mfa')>()),
  stepUpFetch: (url: string, init: RequestInit) => fetch(url, init),
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

const FLAG = {
  id: 'f1', machineId: 'm1', machineName: 'box', ownerLogin: 'someone', signal: 'malformedStreamFrames',
  action: 'throttle', detail: { streamFrames: 400, malformed: 120 }, createdAt: '2026-11-08 12:00:00',
}

describe('AbuseReviewSection', () => {
  it('lists a flag and resolves it only with a note', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ flags: [FLAG] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ flag: FLAG }) })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { root.render(<AbuseReviewSection />) })

    expect(container.textContent).toContain('malformedStreamFrames')
    expect(container.textContent).toContain('throttled until resolved')
    expect(container.textContent).toContain('malformed=120')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Resolve')!
    expect(button.disabled).toBe(true)

    const input = container.querySelector('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'scraper, owner disabled')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })

    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/abuse-flags/f1/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'scraper, owner disabled' }) }))
    expect(container.textContent).toContain('Nothing to review.')
  })
})
