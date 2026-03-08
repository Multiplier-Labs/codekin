// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

import { useSettings } from './useSettings.js'

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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'codekin-settings'

describe('useSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('initial state (load)', () => {
    it('returns defaults when localStorage is empty', () => {
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings).toEqual({ token: '', fontSize: 16, theme: 'dark' })
      unmount()
    })

    it('restores token from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'my-token', fontSize: 20 }))
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.token).toBe('my-token')
      unmount()
    })

    it('always uses default fontSize regardless of saved value', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'x', fontSize: 42 }))
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.fontSize).toBe(16) // default, not 42
      unmount()
    })

    it('returns defaults on corrupt JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not valid json{{{')
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings).toEqual({ token: '', fontSize: 16, theme: 'dark' })
      unmount()
    })

    it('handles missing token field in saved data', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 20 }))
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.token).toBe('')
      unmount()
    })
  })

  describe('updateSettings', () => {
    it('updates token in state and localStorage', () => {
      const { result, unmount } = renderHook(() => useSettings())

      act(() => {
        result.current.updateSettings({ token: 'new-token' })
      })

      expect(result.current.settings.token).toBe('new-token')
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(stored.token).toBe('new-token')
      unmount()
    })

    it('updates fontSize in state', () => {
      const { result, unmount } = renderHook(() => useSettings())

      act(() => {
        result.current.updateSettings({ fontSize: 20 })
      })

      expect(result.current.settings.fontSize).toBe(20)
      unmount()
    })

    it('partial update preserves other fields', () => {
      const { result, unmount } = renderHook(() => useSettings())

      act(() => {
        result.current.updateSettings({ token: 'abc' })
      })

      expect(result.current.settings.fontSize).toBe(16) // preserved

      act(() => {
        result.current.updateSettings({ fontSize: 18 })
      })

      expect(result.current.settings.token).toBe('abc') // preserved
      unmount()
    })
  })
})
