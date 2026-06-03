/** Tests for useClaudeModelSync — verifies dynamic Claude model fetching:
 *  initial fallback state, replacement with server results, auto-selection when
 *  the current model disappears, and silent fallback on empty/error responses. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

// Mock the API layer — the hook only depends on fetchClaudeModels.
const mockFetchClaudeModels = vi.hoisted(() => vi.fn())
vi.mock('../lib/ccApi', () => ({ fetchClaudeModels: mockFetchClaudeModels }))

import { useClaudeModelSync } from './useClaudeModelSync.js'
import { CLAUDE_MODELS, type ModelOption } from '../types'

interface Props {
  token: string
  currentModel: string | null
  setModel: (model: string) => void
}

async function renderHook(props: Props): Promise<{
  result: { current: { claudeModels: ModelOption[] } }
  unmount: () => void
}> {
  const result = { current: { claudeModels: [] as ModelOption[] } }
  const container = document.createElement('div')
  const root = createRoot(container)

  function TestComponent() {
    result.current = useClaudeModelSync(props)
    return null
  }

  // Mount + flush the fetch promise and resulting state updates.
  await act(async () => {
    root.render(createElement(TestComponent))
    await Promise.resolve()
    await Promise.resolve()
  })

  return { result, unmount: () => act(() => root.unmount()) }
}

describe('useClaudeModelSync', () => {
  beforeEach(() => {
    mockFetchClaudeModels.mockReset()
  })

  it('does not fetch when there is no token', async () => {
    const { result } = await renderHook({ token: '', currentModel: null, setModel: vi.fn() })
    expect(mockFetchClaudeModels).not.toHaveBeenCalled()
    expect(result.current.claudeModels).toEqual(CLAUDE_MODELS)
  })

  it('replaces the fallback list with fetched models', async () => {
    const fetched = [
      { id: 'claude-opus-5-0', label: 'Opus 5.0' },
      { id: 'claude-sonnet-4-7', label: 'Sonnet 4.7' },
    ]
    mockFetchClaudeModels.mockResolvedValue(fetched)

    const { result } = await renderHook({ token: 't', currentModel: 'claude-opus-5-0', setModel: vi.fn() })

    expect(mockFetchClaudeModels).toHaveBeenCalledWith('t')
    expect(result.current.claudeModels).toEqual(fetched)
  })

  it('auto-selects the first fetched model when the current one is gone', async () => {
    mockFetchClaudeModels.mockResolvedValue([
      { id: 'claude-opus-5-0', label: 'Opus 5.0' },
      { id: 'claude-sonnet-4-7', label: 'Sonnet 4.7' },
    ])
    const setModel = vi.fn()

    await renderHook({ token: 't', currentModel: 'claude-opus-4-6', setModel })

    expect(setModel).toHaveBeenCalledWith('claude-opus-5-0')
  })

  it('keeps the current model when it is still present in the fetched list', async () => {
    mockFetchClaudeModels.mockResolvedValue([
      { id: 'claude-opus-5-0', label: 'Opus 5.0' },
      { id: 'claude-sonnet-4-7', label: 'Sonnet 4.7' },
    ])
    const setModel = vi.fn()

    await renderHook({ token: 't', currentModel: 'claude-sonnet-4-7', setModel })

    expect(setModel).not.toHaveBeenCalled()
  })

  it('keeps the fallback list when the server returns no models', async () => {
    mockFetchClaudeModels.mockResolvedValue([])
    const setModel = vi.fn()

    const { result } = await renderHook({ token: 't', currentModel: 'claude-opus-4-6', setModel })

    expect(result.current.claudeModels).toEqual(CLAUDE_MODELS)
    expect(setModel).not.toHaveBeenCalled()
  })

  it('keeps the fallback list when the fetch rejects', async () => {
    mockFetchClaudeModels.mockRejectedValue(new Error('network'))
    const setModel = vi.fn()

    const { result } = await renderHook({ token: 't', currentModel: 'claude-opus-4-6', setModel })

    expect(result.current.claudeModels).toEqual(CLAUDE_MODELS)
    expect(setModel).not.toHaveBeenCalled()
  })
})
