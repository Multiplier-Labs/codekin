/** Tests for useCodexModelSync — verifies it only ever pushes a Codex model
 *  onto a session that is (still) a Codex session. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mockFetchCodexModels = vi.hoisted(() => vi.fn())
vi.mock('../lib/ccApi', () => ({ fetchCodexModels: mockFetchCodexModels }))
vi.mock('../lib/prefs', () => ({ getPref: () => null }))

import { useCodexModelSync } from './useCodexModelSync.js'
import type { CodingProvider } from '../types'

const MODELS = { models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', isDefault: true }] }

function mount(provider: CodingProvider | null, setModel: (m: string) => void): { root: Root; render: (p: CodingProvider | null) => void } {
  const root = createRoot(document.createElement('div'))
  function TestComponent({ p }: { p: CodingProvider | null }) {
    useCodexModelSync({ token: 't', activeSessionProvider: p, currentModel: 'claude-opus-5-5', setModel, codexDisabled: true })
    return null
  }
  const render = (p: CodingProvider | null) => { root.render(createElement(TestComponent, { p })) }
  act(() => { render(provider) })
  return { root, render }
}

describe('useCodexModelSync', () => {
  beforeEach(() => { mockFetchCodexModels.mockReset() })

  it('selects the default Codex model for a Codex session', async () => {
    mockFetchCodexModels.mockResolvedValue(MODELS)
    const setModel = vi.fn()
    const { root } = mount('codex', setModel)
    await act(async () => { await Promise.resolve() })
    expect(setModel).toHaveBeenCalledWith('gpt-6-astra')
    act(() => { root.unmount() })
  })

  it('does nothing while the harness is unknown', async () => {
    mockFetchCodexModels.mockResolvedValue(MODELS)
    const setModel = vi.fn()
    const { root } = mount(null, setModel)
    await act(async () => { await Promise.resolve() })
    expect(mockFetchCodexModels).not.toHaveBeenCalled()
    expect(setModel).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })

  it('drops an in-flight result once the active session turns out not to be Codex', async () => {
    let resolve!: (v: typeof MODELS) => void
    mockFetchCodexModels.mockReturnValue(new Promise(r => { resolve = r }))
    const setModel = vi.fn()
    const { root, render } = mount('codex', setModel)
    act(() => { render('claude') })
    await act(async () => { resolve(MODELS); await Promise.resolve() })
    expect(setModel).not.toHaveBeenCalled()
    act(() => { root.unmount() })
  })
})
