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
    expect(result.current.active).toBeNull()
    expect(result.current.queueSize).toBe(0)
  })

  it('enqueues a single prompt as the active entry', () => {
    const { result } = renderHook(() => usePromptState())
    const msg = makePrompt({ requestId: 'req-1' })

    act(() => result.current.enqueue(msg))

    expect(result.current.active).toMatchObject({
      requestId: 'req-1',
      question: 'Allow?',
      options: [{ label: 'Yes', value: 'yes' }],
      multiSelect: false,
    })
    expect(result.current.queueSize).toBe(1)
  })

  it('keeps the oldest prompt as active when multiple are enqueued', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1', question: 'First?' }))
      result.current.enqueue(makePrompt({ requestId: 'req-2', question: 'Second?' }))
    })

    expect(result.current.queueSize).toBe(2)
    expect(result.current.active?.requestId).toBe('req-1')
    expect(result.current.active?.question).toBe('First?')
  })

  it('dismisses a specific prompt by requestId', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1', question: 'First?' }))
      result.current.enqueue(makePrompt({ requestId: 'req-2', question: 'Second?' }))
    })

    act(() => result.current.dismiss('req-1'))

    expect(result.current.queueSize).toBe(1)
    expect(result.current.active?.requestId).toBe('req-2')
  })

  it('dismisses the oldest entry when called with no argument', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1', question: 'First?' }))
      result.current.enqueue(makePrompt({ requestId: 'req-2', question: 'Second?' }))
    })

    act(() => result.current.dismiss())

    expect(result.current.queueSize).toBe(1)
    expect(result.current.active?.requestId).toBe('req-2')
  })

  it('is a no-op when dismissing on an empty queue', () => {
    const { result } = renderHook(() => usePromptState())

    const before = result.current

    act(() => result.current.dismiss())

    expect(result.current.active).toBeNull()
    expect(result.current.queueSize).toBe(0)
    // useCallback references remain stable
    expect(result.current.dismiss).toBe(before.dismiss)
  })

  it('is a no-op when dismissing with an unknown requestId', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => result.current.enqueue(makePrompt({ requestId: 'req-1' })))

    act(() => result.current.dismiss('nonexistent'))

    expect(result.current.queueSize).toBe(1)
    expect(result.current.active?.requestId).toBe('req-1')
  })

  it('clears all prompts with clearAll', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: 'req-1' }))
      result.current.enqueue(makePrompt({ requestId: 'req-2' }))
    })

    act(() => result.current.clearAll())

    expect(result.current.active).toBeNull()
    expect(result.current.queueSize).toBe(0)
  })

  it('is a no-op when clearAll is called on an empty queue', () => {
    const { result } = renderHook(() => usePromptState())

    const before = result.current

    act(() => result.current.clearAll())

    expect(result.current.active).toBeNull()
    expect(result.current.queueSize).toBe(0)
    expect(result.current.clearAll).toBe(before.clearAll)
  })

  it('generates a requestId when none is provided', () => {
    const { result } = renderHook(() => usePromptState())

    act(() => {
      result.current.enqueue(makePrompt({ requestId: undefined }))
    })

    expect(result.current.queueSize).toBe(1)
    expect(result.current.active).not.toBeNull()
    expect(typeof result.current.active!.requestId).toBe('string')
    expect(result.current.active!.requestId.length).toBeGreaterThan(0)
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
      )
    })

    expect(result.current.active?.approvePattern).toBe('tool:*')
    expect(result.current.active?.questions).toEqual(questions)
  })
})
