// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/ccApi', () => ({
  listSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ sessionId: 'new-session-1' })),
  deleteSession: vi.fn(async () => undefined),
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
    vi.mocked(api.createSession).mockResolvedValue({ sessionId: 'new-session-1' })
    vi.mocked(api.deleteSession).mockResolvedValue(undefined as never)
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

    it('sets error on failure', async () => {
      vi.mocked(api.listSessions).mockRejectedValueOnce(new Error('network down'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(result.current.error).toBe('network down')
      unmount()
    })
  })

  describe('create', () => {
    it('calls createSession and refreshes', async () => {
      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      let sessionId: string | null = null
      await act(async () => {
        sessionId = await result.current.create('test', '/tmp')
      })

      expect(api.createSession).toHaveBeenCalledWith('tok', 'test', '/tmp')
      expect(sessionId).toBe('new-session-1')
      // Should have refreshed (listSessions called again)
      expect(api.listSessions).toHaveBeenCalledTimes(2)
      unmount()
    })

    it('returns null and sets error on failure', async () => {
      vi.mocked(api.createSession).mockRejectedValueOnce(new Error('create failed'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      let sessionId: string | null = null
      await act(async () => {
        sessionId = await result.current.create('test', '/tmp')
      })

      expect(sessionId).toBeNull()
      expect(result.current.error).toBe('create failed')
      unmount()
    })

    it('returns null when token is empty', async () => {
      const { result, unmount } = renderHook(() => useSessions(''))

      let sessionId: string | null | undefined
      await act(async () => {
        sessionId = await result.current.create('test', '/tmp')
      })

      expect(sessionId).toBeNull()
      unmount()
    })
  })

  describe('remove', () => {
    it('calls deleteSession and refreshes', async () => {
      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.remove('s1')
      })

      expect(api.deleteSession).toHaveBeenCalledWith('tok', 's1')
      // Should have refreshed
      expect(api.listSessions).toHaveBeenCalledTimes(2)
      unmount()
    })

    it('sets error on failure', async () => {
      vi.mocked(api.deleteSession).mockRejectedValueOnce(new Error('delete failed'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.remove('s1')
      })

      expect(result.current.error).toBe('delete failed')
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

    it('sets error on rename failure', async () => {
      vi.mocked(api.renameSession).mockRejectedValueOnce(new Error('rename failed'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.rename('s1', 'New Name')
      })

      expect(result.current.error).toBe('rename failed')
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

    it('handles non-Error objects in catch', async () => {
      vi.mocked(api.renameSession).mockRejectedValueOnce('string error')

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.rename('s1', 'Name')
      })

      expect(result.current.error).toBe('Failed to rename session')
      unmount()
    })
  })

  describe('error handling edge cases', () => {
    it('handles non-Error objects in refresh catch', async () => {
      vi.mocked(api.listSessions).mockRejectedValueOnce('raw string error')

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      expect(result.current.error).toBe('Failed to load sessions')
      unmount()
    })

    it('handles non-Error objects in create catch', async () => {
      vi.mocked(api.createSession).mockRejectedValueOnce(42)

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.create('test', '/tmp')
      })

      expect(result.current.error).toBe('Failed to create session')
      unmount()
    })

    it('handles non-Error objects in remove catch', async () => {
      vi.mocked(api.deleteSession).mockRejectedValueOnce({ code: 500 })

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => {
        await result.current.remove('s1')
      })

      expect(result.current.error).toBe('Failed to delete session')
      unmount()
    })

    it('clears error on successful refresh after failure', async () => {
      vi.mocked(api.listSessions).mockRejectedValueOnce(new Error('fail'))

      const { result, unmount } = renderHook(() => useSessions('tok'))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.error).toBe('fail')

      // Next refresh succeeds
      vi.mocked(api.listSessions).mockResolvedValueOnce([])
      await act(async () => {
        await result.current.refresh()
      })
      expect(result.current.error).toBeNull()
      unmount()
    })
  })
})
