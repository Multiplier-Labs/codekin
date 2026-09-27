/** Tests for the generated install / pair commands. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { InstallCommand } from './InstallCommand'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('InstallCommand', () => {
  it('renders an https installer command carrying the token in CODEKIN_PAIR_TOKEN', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pairingToken: 'tok-abc', expiresAt: Date.now() + 10 * 60_000 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root.render(<InstallCommand />)
    })

    await act(async () => {
      container!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const codes = [...container.querySelectorAll('code')].map(c => c.textContent)
    // jsdom's origin is not the default relay, so it is named explicitly
    const origin = window.location.origin
    expect(codes).toEqual([
      `curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=tok-abc bash -s -- --relay ${origin}`,
      `CODEKIN_PAIR_TOKEN=tok-abc codekin relay login --url ${origin}`,
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/machines/pair/precreate', expect.objectContaining({ method: 'POST' }))
  })
})
