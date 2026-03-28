/** Tests for usePromptState — verifies permission prompt queue management and answer dispatch with no mocks. */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { usePromptState } from './usePromptState'
import type { WsServerMessage } from '../types'

type PromptMessage = WsServerMessage & { type: 'prompt' }

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

function makePrompt(overrides: Partial<PromptMessage> = {}): PromptMessage {
  return {
    type: 'prompt' as const,
    promptType: 'permission',
    question: 'Allow?',
    options: [{ label: 'Yes', value: 'yes' }],
    multiSelect: false,
    ...overrides,
  } as PromptMessage
}

describe('usePromptState', () => {
  it('returns null active and zero queueSize initially', () => {
    const { result } = renderHook(() => usePromptState())
    expect(result.current.getActive('s1')).toBeNull()
    expect(result.current.getQueueSize('s1')).toBe(0)
  })

  it('returns null active and zero queueSize for null sessionId', () => {
    const { result } = renderHook(() => usePromptState())
    expect(result.current.getActive(null)).toBeNull()
    expect(result.current.getQueueSize(null)).toBe(0)
  })

  it('enqueues a single prompt as the active entry', () => {
    const { result } = renderHook(() => usePromptState())
    const msg = makePrompt({ requestId: 'req-1' })

    act(() => result.current.enqueue(msg, 's1'))

    expect(result.current.getActive('s1')).toMatchObject({
      requestId: 'req-1',
      question: 'Allow?',
      options: [{ label: 'Yes', value: 'yes' }],
      multiSelect: false,
    })
    expect(result.current.getQueueSize('s1')).toBe(1)
  })

  it('keeps the oldest prompt as active when multiple are enqueued', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1', question: 'First?' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-2', question: 'Second?' }), 's1')
    })

    expect(result.current.getQueueSize('s1')).toBe(2)
    expect(result.current.getActive('s1')?.requestId).toBe('req-1')
    expect(result.current.getActive('s1')?.question).toBe('First?')
  })

  it('dismisses a specific prompt by requestId', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1', question: 'First?' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-2', question: 'Second?' }), 's1')
    })

    act(() => result.current.dismiss('req-1'))

    expect(result.current.getQueueSize('s1')).toBe(1)
    expect(result.current.getActive('s1')?.requestId).toBe('req-2')
  })

  it('is a no-op when dismissing with no argument', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1' }), 's1')
    })

    act(() => result.current.dismiss())

    expect(result.current.getQueueSize('s1')).toBe(1)
  })

  it('is a no-op when dismissing with an unknown requestId', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => result.current.enqueue(makePrompt({ requestId: 'req-1' }), 's1'))

    act(() => result.current.dismiss('nonexistent'))

    expect(result.current.getQueueSize('s1')).toBe(1)
    expect(result.current.getActive('s1')?.requestId).toBe('req-1')
  })

  it('clears all prompts with clearAll', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-2' }), 's2')
    })

    act(() => result.current.clearAll())

    expect(result.current.getActive('s1')).toBeNull()
    expect(result.current.getActive('s2')).toBeNull()
    expect(result.current.getQueueSize('s1')).toBe(0)
    expect(result.current.getQueueSize('s2')).toBe(0)
  })

  it('is a no-op when clearAll is called on an empty queue', () => {
    const { result } = renderHook(() => usePromptState())

    const before = result.current

    act(() => result.current.clearAll())

    expect(result.current.getActive('s1')).toBeNull()
    expect(result.current.getQueueSize('s1')).toBe(0)
    expect(result.current.clearAll).toBe(before.clearAll)
  })

  it('generates a requestId when none is provided', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: undefined }), 's1')
    })

    expect(result.current.getQueueSize('s1')).toBe(1)
    expect(result.current.getActive('s1')).not.toBeNull()
    expect(typeof result.current.getActive('s1')!.requestId).toBe('string')
    expect(result.current.getActive('s1')!.requestId.length).toBeGreaterThan(0)
  })

  it('preserves optional approvePattern and questions fields', () => {
    const { result } = renderHook(() => usePromptState())

    const questions = [
      { question: 'Pick one', options: [{ label: 'A', value: 'a' }], multiSelect: false },
    ]

    act(() => {
      result.current.enqueue(
        makePrompt({
          requestId: 'req-pattern',
          approvePattern: 'tool:*',
          questions,
        }),
        's1',
      )
    })

    expect(result.current.getActive('s1')?.approvePattern).toBe('tool:*')
    expect(result.current.getActive('s1')?.questions).toEqual(questions)
  })

  // --- Multi-session tests ---

  it('isolates prompts between sessions', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a', question: 'Session A?' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-b', question: 'Session B?' }), 's2')
    })

    expect(result.current.getActive('s1')?.requestId).toBe('req-a')
    expect(result.current.getActive('s1')?.question).toBe('Session A?')
    expect(result.current.getActive('s2')?.requestId).toBe('req-b')
    expect(result.current.getActive('s2')?.question).toBe('Session B?')
    expect(result.current.getQueueSize('s1')).toBe(1)
    expect(result.current.getQueueSize('s2')).toBe(1)
  })

  it('derives waitingSessions from non-empty queues', () => {
    const { result } = renderHook(() => usePromptState())

    expect(result.current.waitingSessions).toEqual({})

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-b' }), 's2')
    })

    expect(result.current.waitingSessions).toEqual({ s1: true, s2: true })
  })

  it('clearForSession only clears the specified session', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-b' }), 's2')
    })

    act(() => result.current.clearForSession('s1'))

    expect(result.current.getActive('s1')).toBeNull()
    expect(result.current.getQueueSize('s1')).toBe(0)
    expect(result.current.getActive('s2')?.requestId).toBe('req-b')
    expect(result.current.getQueueSize('s2')).toBe(1)
    expect(result.current.waitingSessions).toEqual({ s2: true })
  })

  it('clearForSession is a no-op for unknown session', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a' }), 's1')
    })

    const before = result.current.waitingSessions

    act(() => result.current.clearForSession('unknown'))

    expect(result.current.waitingSessions).toBe(before)
    expect(result.current.getQueueSize('s1')).toBe(1)
  })

  it('dismiss finds a requestId across sessions', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a' }), 's1')
      result.current.enqueue(makePrompt({ requestId: 'req-b' }), 's2')
    })

    act(() => result.current.dismiss('req-b'))

    expect(result.current.getQueueSize('s1')).toBe(1)
    expect(result.current.getQueueSize('s2')).toBe(0)
    expect(result.current.getActive('s2')).toBeNull()
    expect(result.current.waitingSessions).toEqual({ s1: true })
  })

  it('removes session entry from map when last prompt is dismissed', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-a' }), 's1')
    })

    act(() => result.current.dismiss('req-a'))

    expect(result.current.waitingSessions).toEqual({})
    expect(result.current.getActive('s1')).toBeNull()
  })
})
