// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

import { usePageVisibility } from './usePageVisibility.js'

/* ------------------------------------------------------------------ */
/*  Minimal renderHook                                                 */
/* ------------------------------------------------------------------ */

function renderHook<T>(hookFn: () => T): {
  result: { current: T }
  unmount: () => void
} {
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

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  })
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event('visibilitychange'))
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('usePageVisibility', () => {
  afterEach(() => {
    // Restore default visibility state
    setVisibilityState('visible')
  })

  it('fires callback when page transitions to visible', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => usePageVisibility(callback))

    // Simulate hidden → visible
    setVisibilityState('hidden')
    fireVisibilityChange()
    expect(callback).not.toHaveBeenCalled()

    setVisibilityState('visible')
    fireVisibilityChange()
    expect(callback).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('does NOT fire callback on initial mount', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => usePageVisibility(callback))

    // No visibilitychange event dispatched — callback should not fire
    expect(callback).not.toHaveBeenCalled()
    unmount()
  })

  it('does not fire when transitioning to hidden', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => usePageVisibility(callback))

    setVisibilityState('hidden')
    fireVisibilityChange()

    expect(callback).not.toHaveBeenCalled()
    unmount()
  })

  it('fires multiple times on repeated visibility changes', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => usePageVisibility(callback))

    for (let i = 0; i < 3; i++) {
      setVisibilityState('hidden')
      fireVisibilityChange()
      setVisibilityState('visible')
      fireVisibilityChange()
    }

    expect(callback).toHaveBeenCalledTimes(3)
    unmount()
  })

  it('uses latest callback via ref (no stale closure)', () => {
    let callCount = 0
    const callback1 = vi.fn(() => { callCount = 1 })
    const callback2 = vi.fn(() => { callCount = 2 })

    const container = document.createElement('div')
    let root: ReturnType<typeof createRoot>
    let currentCallback = callback1

    function TestComponent() {
      usePageVisibility(currentCallback)
      return null
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(TestComponent))
    })

    // Re-render with new callback
    currentCallback = callback2
    act(() => {
      root.render(createElement(TestComponent))
    })

    // Fire visibility change — should use callback2
    setVisibilityState('visible')
    fireVisibilityChange()

    expect(callCount).toBe(2)

    act(() => root.unmount())
  })

  it('removes event listener on unmount', () => {
    const callback = vi.fn()
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = renderHook(() => usePageVisibility(callback))
    unmount()

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // Firing after unmount should not call callback
    setVisibilityState('visible')
    fireVisibilityChange()
    expect(callback).not.toHaveBeenCalled()

    removeSpy.mockRestore()
  })
})
