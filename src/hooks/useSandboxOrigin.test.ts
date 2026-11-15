/**
 * Tests for when the Canvas sandbox frame may be created. In the desktop app
 * a refused frame opens in the default browser, so the frame is only made
 * where the app's window will load it.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { desktopLoadsFrames } from './useSandboxOrigin'

/** Render `useHook` and keep its latest value. */
function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T }
  function Probe() { result.current = useHook(); return null }
  const root = createRoot(document.createElement('div'))
  act(() => { root.render(createElement(Probe)) })
  return { result, unmount: () => { act(() => { root.unmount() }) } }
}

/** Let pending fetch promises settle. */
async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
}

const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
const OLD_DESKTOP = `${BROWSER} CodekinDesktop/0.12.0`
const NEW_DESKTOP = `${BROWSER} CodekinFrames/1 CodekinDesktop/0.12.1`

describe('desktopLoadsFrames', () => {
  it('is true in a browser and in desktop builds that allow the frame', () => {
    expect(desktopLoadsFrames(BROWSER)).toBe(true)
    expect(desktopLoadsFrames(NEW_DESKTOP)).toBe(true)
  })

  it('is false in older desktop builds', () => {
    expect(desktopLoadsFrames(OLD_DESKTOP)).toBe(false)
  })
})

describe('useSandboxOrigin in the hosted web app', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function load(userAgent: string, relayInfo: Record<string, unknown> | null) {
    vi.stubEnv('VITE_CANVAS_SANDBOX_ORIGIN', 'https://sandbox.example.net')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    const fetchMock = vi.fn(() => Promise.resolve(relayInfo
      ? new Response(JSON.stringify(relayInfo), { status: 200 })
      : new Response('{}', { status: 404 })))
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { useSandboxOrigin } = await import('./useSandboxOrigin')
    return { fetchMock, hook: renderHook(() => useSandboxOrigin('')) }
  }

  it('uses the built-in sandbox in a browser without asking the relay', async () => {
    const { fetchMock, hook } = await load(BROWSER, null)
    expect(hook.result.current).toBe('https://sandbox.example.net')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no sandbox in a desktop build that would refuse the frame', async () => {
    const { fetchMock, hook } = await load(OLD_DESKTOP, null)
    expect(hook.result.current).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the sandbox in the desktop app once the relay advertises it', async () => {
    const { hook } = await load(NEW_DESKTOP, { app: 'codekin-relay', canvasSandboxOrigin: 'https://sandbox.example.net' })
    expect(hook.result.current).toBeUndefined()
    await settle()
    expect(hook.result.current).toBe('https://sandbox.example.net')
  })

  it('has no sandbox in the desktop app when the relay advertises none, or another', async () => {
    for (const info of [{ app: 'codekin-relay' }, { app: 'codekin-relay', canvasSandboxOrigin: 'https://other.example.net' }, null]) {
      const { hook } = await load(NEW_DESKTOP, info)
      await settle()
      expect(hook.result.current).toBeNull()
      hook.unmount()
    }
  })
})
