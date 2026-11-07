/** Tests for the desktop app's sign-in approval page. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopAuthPage } from './DesktopAuthPage'
import { isDesktopApp, desktopSignInUrl } from './desktopAuth'

const ID = '3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b'
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
const assign = vi.fn()

beforeEach(() => {
  history.replaceState(null, '', `/desktop-auth?request=${ID}`)
  vi.stubGlobal('location', { ...window.location, search: `?request=${ID}`, assign })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  assign.mockReset()
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

async function render(fetchImpl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(fetchImpl(url, init))))
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<DesktopAuthPage login="owner" />)
  })
  await act(async () => { await Promise.resolve() })
}

describe('DesktopAuthPage', () => {
  it('asks first, then hands the code to the app', async () => {
    const redirectUrl = 'codekin://auth?relay=https%3A%2F%2Fapp.example.com&code=c&state=s'
    await render(url =>
      url.endsWith('/approve') ? json(200, { redirectUrl }) : json(200, { status: 'pending', relayName: 'Example' }),
    )
    expect(container!.textContent).toContain('asking to sign in to Example as @owner')
    expect(assign).not.toHaveBeenCalled()
    const button = [...container!.querySelectorAll('button')].find(b => b.textContent === 'Sign in to the app')!
    await act(async () => { button.click() })
    await act(async () => { await Promise.resolve() })
    expect(assign).toHaveBeenCalledWith(redirectUrl)
    expect(container!.textContent).toContain('You can return to Codekin')
  })

  it('says when the request was already used', async () => {
    await render(() => json(200, { status: 'used', relayName: 'Example' }))
    expect(container!.textContent).toContain('already used')
    expect(container!.querySelector('button')).toBeNull()
  })

  it('says when the request is unknown', async () => {
    await render(() => json(404, { error: 'not_found' }))
    expect(container!.textContent).toContain('not found')
  })
})

describe('desktop detection', () => {
  it('recognises the app by its user-agent token', () => {
    expect(isDesktopApp('Mozilla/5.0 AppleWebKit/605.1.15 CodekinDesktop/0.10.0')).toBe(true)
    expect(isDesktopApp('Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15')).toBe(false)
    expect(desktopSignInUrl()).toBe('codekin://sign-in')
    expect(desktopSignInUrl('step_up')).toBe('codekin://sign-in?reason=step_up')
  })
})
