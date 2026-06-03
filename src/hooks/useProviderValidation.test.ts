/** Tests for useProviderValidation — verifies that the active Claude model is
 *  reconciled against the available model list, auto-selecting the first when
 *  the current selection is unknown, and that non-claude providers are skipped. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

import { useProviderValidation } from './useProviderValidation.js'
import type { CodingProvider, ModelOption } from '../types'

interface Props {
  activeSessionProvider: CodingProvider
  currentModel: string | null
  setModel: (model: string) => void
  claudeModels: ModelOption[]
}

function renderHook(initial: Props): {
  rerender: (next: Props) => void
  unmount: () => void
} {
  const container = document.createElement('div')
  const root = createRoot(container)

  function TestComponent(props: Props) {
    useProviderValidation(props)
    return null
  }

  act(() => {
    root.render(createElement(TestComponent, initial))
  })

  return {
    rerender: (next: Props) => act(() => root.render(createElement(TestComponent, next))),
    unmount: () => act(() => root.unmount()),
  }
}

const MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
]

describe('useProviderValidation', () => {
  it('auto-selects the first model when currentModel is unknown', () => {
    const setModel = vi.fn()
    renderHook({
      activeSessionProvider: 'claude',
      currentModel: 'claude-gone-1-0',
      setModel,
      claudeModels: MODELS,
    })
    expect(setModel).toHaveBeenCalledWith('claude-opus-4-8')
  })

  it('does not reassign when currentModel is already valid', () => {
    const setModel = vi.fn()
    renderHook({
      activeSessionProvider: 'claude',
      currentModel: 'claude-sonnet-4-6',
      setModel,
      claudeModels: MODELS,
    })
    expect(setModel).not.toHaveBeenCalled()
  })

  it('does nothing for non-claude providers', () => {
    const setModel = vi.fn()
    renderHook({
      activeSessionProvider: 'opencode' as CodingProvider,
      currentModel: 'something-else',
      setModel,
      claudeModels: MODELS,
    })
    expect(setModel).not.toHaveBeenCalled()
  })

  it('does nothing when the model list is empty (discovery not yet loaded)', () => {
    const setModel = vi.fn()
    renderHook({
      activeSessionProvider: 'claude',
      currentModel: 'claude-gone-1-0',
      setModel,
      claudeModels: [],
    })
    expect(setModel).not.toHaveBeenCalled()
  })

  it('reconciles after the model list changes on rerender', () => {
    const setModel = vi.fn()
    const { rerender } = renderHook({
      activeSessionProvider: 'claude',
      currentModel: 'claude-opus-4-8',
      setModel,
      claudeModels: MODELS,
    })
    expect(setModel).not.toHaveBeenCalled()

    // New discovery result no longer contains the current model → reconcile.
    rerender({
      activeSessionProvider: 'claude',
      currentModel: 'claude-opus-4-8',
      setModel,
      claudeModels: [{ id: 'claude-opus-5-0', label: 'Opus 5.0' }],
    })
    expect(setModel).toHaveBeenCalledWith('claude-opus-5-0')
  })
})
