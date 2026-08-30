/** Tests for useWorkflows — verifies push-driven refresh on workflow events (debounced) with the slow poll as a safety net. */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/workflowApi', () => ({
  listRuns: vi.fn().mockResolvedValue([]),
  listSchedules: vi.fn().mockResolvedValue([]),
  getConfig: vi.fn().mockResolvedValue({ reviewRepos: [] }),
  triggerRun: vi.fn(),
  cancelRun: vi.fn(),
  triggerSchedule: vi.fn(),
  addRepoConfig: vi.fn(),
  removeRepoConfig: vi.fn(),
  patchRepoConfig: vi.fn(),
}))

import { useWorkflows } from './useWorkflows'
import { emitWorkflowEvent } from '../lib/workflowEvents'
import { listRuns } from '../lib/workflowApi'

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

  return { result, unmount: () => act(() => root.unmount()) }
}

/** Flush pending microtasks so mocked fetches resolve under fake timers. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const EVENT = { type: 'workflow_event', eventType: 'step_completed', runId: 'r1', kind: 'code-review.daily' } as const

describe('useWorkflows push-driven refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(listRuns).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes once per event burst (debounced)', async () => {
    const { unmount } = renderHook(() => useWorkflows('tok'))
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(1) // initial load

    act(() => {
      emitWorkflowEvent(EVENT)
      emitWorkflowEvent(EVENT)
      emitWorkflowEvent(EVENT)
    })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(2) // burst collapsed into one refresh
    unmount()
  })

  it('polls only at the slow fallback interval', async () => {
    const { unmount } = renderHook(() => useWorkflows('tok'))
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(30_000) // old fast-poll cadence — nothing should fire
    })
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(31_000) // crosses the 60s fallback
    })
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('ignores loop-engine events — those belong to LoopsView', async () => {
    const { unmount } = renderHook(() => useWorkflows('tok'))
    await flush()
    expect(listRuns).toHaveBeenCalledTimes(1)

    act(() => {
      emitWorkflowEvent({ ...EVENT, engine: 'loop' })
    })
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(listRuns).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('stops listening after unmount', async () => {
    const { unmount } = renderHook(() => useWorkflows('tok'))
    await flush()
    unmount()

    emitWorkflowEvent(EVENT)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(listRuns).toHaveBeenCalledTimes(1) // only the initial load
  })
})
