/** Tests for useSettings — the token in localStorage and the theme in the prefs store. */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

import { useSettings, resetTokenForTest } from './useSettings.js'
import { getPref, resetPrefsForTest } from '../lib/prefs.js'

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
    resetTokenForTest()
    resetPrefsForTest()
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

    it('defaults theme to dark when saved theme is unknown', () => {
      resetPrefsForTest({ theme: 'blue' as never })
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.theme).toBe('dark')
      unmount()
    })

    it.each(['dark', 'light', 'midnight', 'paper', 'contrast', 'solarized', 'dracula', 'gruvbox', 'matrix'])('restores saved theme %s', (theme) => {
      resetPrefsForTest({ theme: theme as never })
      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.theme).toBe(theme)
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

    it('writes the theme to the prefs store, not localStorage', () => {
      const { result, unmount } = renderHook(() => useSettings())

      act(() => {
        result.current.updateSettings({ theme: 'light' })
      })

      expect(result.current.settings.theme).toBe('light')
      expect(getPref('theme')).toBe('light')
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      unmount()
    })

    it('partial update preserves other fields', () => {
      const { result, unmount } = renderHook(() => useSettings())

      act(() => {
        result.current.updateSettings({ token: 'abc' })
      })

      expect(result.current.settings.fontSize).toBe(16) // preserved

      act(() => {
        result.current.updateSettings({ theme: 'paper' })
      })

      expect(result.current.settings.token).toBe('abc') // preserved
      unmount()
    })

    it('remounting reads updated values from localStorage (round-trip)', () => {
      const { result: r1, unmount: u1 } = renderHook(() => useSettings())
      act(() => {
        r1.current.updateSettings({ token: 'round-trip-tok' })
      })
      u1()
      resetTokenForTest()

      const { result: r2, unmount: u2 } = renderHook(() => useSettings())
      expect(r2.current.settings.token).toBe('round-trip-tok')
      u2()
    })
  })

  describe('URL token parameter', () => {
    let originalReplaceState: typeof window.history.replaceState

    beforeEach(() => {
      originalReplaceState = window.history.replaceState
      window.history.replaceState = vi.fn()
    })

    afterEach(() => {
      window.history.replaceState = originalReplaceState
    })

    it('reads token from URL ?token= parameter and persists it', () => {
      // Use the real replaceState to set the URL, then swap in mock
      window.history.replaceState = originalReplaceState
      window.history.replaceState({}, '', '/?token=url-tok-123')
      window.history.replaceState = vi.fn()

      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.token).toBe('url-tok-123')

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(stored.token).toBe('url-tok-123')
      unmount()
    })

    it('strips token from URL after reading it', () => {
      window.history.replaceState = originalReplaceState
      window.history.replaceState({}, '', '/?token=strip-me')
      window.history.replaceState = vi.fn()

      const { unmount } = renderHook(() => useSettings())

      expect(window.history.replaceState).toHaveBeenCalled()
      const calledUrl = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
      expect(calledUrl).not.toContain('token=')
      unmount()
    })

    it('reads token from the #token= fragment, persists it and strips it', () => {
      window.history.replaceState = originalReplaceState
      window.history.replaceState({}, '', '/#token=frag-tok-456')
      window.history.replaceState = vi.fn()

      const { result, unmount } = renderHook(() => useSettings())
      expect(result.current.settings.token).toBe('frag-tok-456')
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).token).toBe('frag-tok-456')

      const calledUrl = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
      expect(calledUrl).toBe('/')
      unmount()
    })
  })
})
