/** Tests for useSessions — verifies session list management and CRUD operations with mocked ccApi (listSessions, renameSession). */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/ccApi', () => ({
  listSessions: vi.fn(async () => []),
  renameSession: vi.fn(async () => undefined),
}))

import { useSessions } from './useSessions.js'
import type { Session } from '../types'
import * as api from '../lib/ccApi'

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

describe('useSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(api.listSessions).mockResolvedValue([])
    vi.mocked(api.renameSession).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('initial mount', () => {
    it('calls listSessions on mount with token', async () => {
      const { unmount } = renderHook(() => useSessions('my-token'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(api.listSessions).toHaveBeenCalledWith('my-token')
      unmount()
    })

    it('sets sessions from API response', async () => {
      const fakeSessions = [{ id: 's1', name: 'session-1' }] as unknown as Session[]
      vi.mocked(api.listSessions).mockResolvedValue(fakeSessions)

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(result.current.sessions).toEqual(fakeSessions)
      unmount()
    })

    it('does not fetch when token is empty', async () => {
      const { unmount } = renderHook(() => useSessions(''))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(api.listSessions).not.toHaveBeenCalled()
      unmount()
    })
  })

  describe('refresh', () => {
    it('does nothing when token is empty', async () => {
      const { result, unmount } = renderHook(() => useSessions(''))

      await act(async () => {
        await result.current.refresh()
      })

      expect(api.listSessions).not.toHaveBeenCalled()
      unmount()
    })

    it('keeps the last list on failure', async () => {
      const fakeSessions = [{ id: 's1', name: 'session-1' }] as unknown as Session[]
      vi.mocked(api.listSessions).mockResolvedValueOnce(fakeSessions)

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      vi.mocked(api.listSessions).mockRejectedValueOnce(new Error('network down'))
      await act(async () => {
        await result.current.refresh()
      })

      expect(result.current.sessions).toEqual(fakeSessions)
      unmount()
    })
  })

  describe('polling', () => {
    it('polls every 10 seconds', async () => {
      const { unmount } = renderHook(() => useSessions('tok'))

      // Initial fetch
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(api.listSessions).toHaveBeenCalledTimes(1)

      // After 10s
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(api.listSessions).toHaveBeenCalledTimes(2)

      // After another 10s
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(api.listSessions).toHaveBeenCalledTimes(3)

      unmount()
    })

    it('clears interval on unmount', async () => {
      const { unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      unmount()

      const callsBefore = vi.mocked(api.listSessions).mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(api.listSessions).toHaveBeenCalledTimes(callsBefore)
    })

    it('does not poll when token is empty', async () => {
      const { unmount } = renderHook(() => useSessions(''))
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

      expect(api.listSessions).not.toHaveBeenCalled()
      unmount()
    })
  })

  describe('rename', () => {
    it('calls renameSession and refreshes', async () => {
      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.rename('s1', 'New Name')
      })

      expect(api.renameSession).toHaveBeenCalledWith('tok', 's1', 'New Name')
      // Should have refreshed
      expect(api.listSessions).toHaveBeenCalledTimes(2)
      unmount()
    })

    it('swallows a rename failure', async () => {
      vi.mocked(api.renameSession).mockRejectedValueOnce(new Error('rename failed'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await expect(result.current.rename('s1', 'New Name')).resolves.toBeUndefined()
      })

      // No refresh after a failed rename
      expect(api.listSessions).toHaveBeenCalledTimes(1)
      unmount()
    })

    it('does nothing when token is empty', async () => {
      const { result, unmount } = renderHook(() => useSessions(''))

      await act(async () => {
        await result.current.rename('s1', 'New Name')
      })

      expect(api.renameSession).not.toHaveBeenCalled()
      unmount()
    })
  })
})
