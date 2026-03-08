// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { parsePath, useRouter } from './useRouter'

/* Minimal renderHook using React 19's act + createRoot (no @testing-library needed) */
function renderHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as T }
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot>

  function TestComponent() {
    result.current = hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    result,
    unmount: () => act(() => root.unmount()),
  }
}

describe('parsePath', () => {
  it('extracts session ID from /s/:id', () => {
    const result = parsePath('/s/550e8400-e29b-41d4-a716-446655440000')
    expect(result.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(result.path).toBe('/s/550e8400-e29b-41d4-a716-446655440000')
  })

  it('handles trailing slash', () => {
    const result = parsePath('/s/550e8400-e29b-41d4-a716-446655440000/')
    expect(result.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('returns null sessionId for root path', () => {
    const result = parsePath('/')
    expect(result.sessionId).toBeNull()
    expect(result.path).toBe('/')
  })

  it('returns null sessionId for /s/ with no id', () => {
    const result = parsePath('/s/')
    expect(result.sessionId).toBeNull()
  })

  it('returns null sessionId for unknown paths', () => {
    expect(parsePath('/unknown').sessionId).toBeNull()
    expect(parsePath('/settings').sessionId).toBeNull()
    expect(parsePath('/s').sessionId).toBeNull()
  })

  it('rejects non-hex characters in session ID', () => {
    expect(parsePath('/s/not-a-valid-uuid!').sessionId).toBeNull()
    expect(parsePath('/s/ZZZZ').sessionId).toBeNull()
  })

  it('matches short hex IDs', () => {
    // The regex is loose ([a-f0-9-]+), so short hex strings match
    expect(parsePath('/s/abc123').sessionId).toBe('abc123')
  })
})

describe('useRouter', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/')
  })

  afterEach(() => {
    history.replaceState(null, '', '/')
  })

  it('initializes with root path', () => {
    const { result, unmount } = renderHook(() => useRouter())
    expect(result.current.path).toBe('/')
    expect(result.current.sessionId).toBeNull()
    unmount()
  })

  it('initializes with session path from current URL', () => {
    history.replaceState(null, '', '/s/abc123')
    const { result, unmount } = renderHook(() => useRouter())
    expect(result.current.path).toBe('/s/abc123')
    expect(result.current.sessionId).toBe('abc123')
    unmount()
  })

  it('navigate() pushes state and updates route', () => {
    const { result, unmount } = renderHook(() => useRouter())
    act(() => {
      result.current.navigate('/s/def456')
    })
    expect(result.current.path).toBe('/s/def456')
    expect(result.current.sessionId).toBe('def456')
    expect(window.location.pathname).toBe('/s/def456')
    unmount()
  })

  it('navigate() with replace=true uses replaceState', () => {
    const { result, unmount } = renderHook(() => useRouter())
    const spy = vi.spyOn(history, 'replaceState')
    act(() => {
      result.current.navigate('/s/aaa', true)
    })
    expect(spy).toHaveBeenCalledWith(null, '', '/s/aaa')
    expect(result.current.path).toBe('/s/aaa')
    spy.mockRestore()
    unmount()
  })

  it('navigate() is no-op when path matches current', () => {
    history.replaceState(null, '', '/s/same')
    const { result, unmount } = renderHook(() => useRouter())
    const pushSpy = vi.spyOn(history, 'pushState')
    const replaceSpy = vi.spyOn(history, 'replaceState')
    act(() => {
      result.current.navigate('/s/same')
    })
    expect(pushSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
    unmount()
  })

  it('responds to popstate events', () => {
    const { result, unmount } = renderHook(() => useRouter())
    act(() => {
      result.current.navigate('/s/abc123')
    })
    expect(result.current.sessionId).toBe('abc123')
    // Simulate browser back — change URL and fire popstate
    act(() => {
      history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(result.current.path).toBe('/')
    expect(result.current.sessionId).toBeNull()
    unmount()
  })

  it('cleans up popstate listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useRouter())
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function))
    removeSpy.mockRestore()
  })
})
