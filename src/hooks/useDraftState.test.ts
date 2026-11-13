/** The new-session composer keeps what was sent until the session exists, and starts in the saved mode. */
// @vitest-environment jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { getPref, resetPrefsForTest } from '../lib/prefs'
import { useDraftPermissionMode, useDraftState } from './useDraftState'
import type { CodingProvider } from '../types'

const place = { kind: 'scratch' } as const

/** Mount a hook; `result.current` is its latest return value. */
function renderHook<P, R>(hook: (props: P) => R, opts?: { initialProps: P }) {
  const result = { current: undefined as unknown as R }
  function Probe(props: { p: P }) { result.current = hook(props.p); return null }
  const root = createRoot(document.createElement('div'))
  const render = (p: P) => act(() => { root.render(createElement(Probe, { p })) })
  render(opts?.initialProps as P)
  return { result, rerender: render }
}

describe('useDraftState', () => {
  it('puts the sent text back when setup fails, after the composer cleared its textarea', () => {
    const { result } = renderHook(() => useDraftState())
    act(() => { result.current.setText('fix the login bug') })
    act(() => { expect(result.current.begin('fix the login bug')).toBe(true) })
    // InputBar reports an empty value right after handing the text over.
    act(() => { result.current.setText('') })
    const keyBefore = result.current.resetKey
    act(() => { result.current.fail('Could not create a scratch folder') })
    expect(result.current.text).toBe('fix the login bug')
    expect(result.current.error).toBe('Could not create a scratch folder')
    expect(result.current.progress).toBeNull()
    expect(result.current.resetKey).toBe(keyBefore + 1)
  })

  it('puts the sent text back when the server rejects the create', () => {
    const { result } = renderHook(() => useDraftState())
    act(() => { result.current.begin('add tests') })
    act(() => { result.current.setText('') })
    act(() => { result.current.awaitCreated({ firstMessage: 'add tests', place }) })
    expect(result.current.isAwaitingCreate()).toBe(true)
    act(() => { result.current.fail('Path is outside the allowed roots') })
    expect(result.current.text).toBe('add tests')
    expect(result.current.isAwaitingCreate()).toBe(false)
  })

  it('refuses a second send while one is in flight, from the start of setup', () => {
    const { result } = renderHook(() => useDraftState())
    act(() => { expect(result.current.begin('first')).toBe(true) })
    act(() => { expect(result.current.begin('second')).toBe(false) })
    act(() => { result.current.fail('upload failed') })
    expect(result.current.text).toBe('first')
    // Retrying after a failure is allowed and sends the original text once.
    act(() => { expect(result.current.begin('first')).toBe(true) })
  })

  it('clears the draft once the session exists and hands over the first message', () => {
    const { result } = renderHook(() => useDraftState())
    act(() => { result.current.begin('hello') })
    act(() => { result.current.awaitCreated({ firstMessage: 'hello\n\n[file]', place }) })
    let created: ReturnType<typeof result.current.takeCreated> = null
    act(() => { created = result.current.takeCreated() })
    expect(created).toEqual({ firstMessage: 'hello\n\n[file]', place })
    expect(result.current.text).toBe('')
    // Nothing left to fail, nothing left to take.
    act(() => { result.current.fail('late error') })
    expect(result.current.error).toBeNull()
    expect(result.current.takeCreated()).toBeNull()
  })
})

describe('useDraftPermissionMode', () => {
  beforeEach(() => { resetPrefsForTest({ permissionMode: 'acceptEdits' }) })

  it('starts in the saved default, not whatever mode another session runs in', () => {
    const { result } = renderHook(() => useDraftPermissionMode('claude'))
    expect(result.current[0]).toBe('acceptEdits')
  })

  it('defaults to Accept edits when nothing is saved', () => {
    resetPrefsForTest({})
    const { result } = renderHook(() => useDraftPermissionMode('claude'))
    expect(result.current[0]).toBe('acceptEdits')
  })

  it('saves a mode chosen in the composer as the new-session default', () => {
    const { result } = renderHook(() => useDraftPermissionMode('claude'))
    act(() => { result.current[1]('plan') })
    expect(result.current[0]).toBe('plan')
    expect(getPref('permissionMode')).toBe('plan')
  })

  it('maps Claude-only Skip permissions to Bypass for other agents, without rewriting the default', () => {
    resetPrefsForTest({ permissionMode: 'dangerouslySkipPermissions' })
    const { result, rerender } = renderHook(({ provider }: { provider: CodingProvider }) => useDraftPermissionMode(provider), {
      initialProps: { provider: 'codex' },
    })
    expect(result.current[0]).toBe('bypassPermissions')
    rerender({ provider: 'claude' })
    expect(result.current[0]).toBe('dangerouslySkipPermissions')
    expect(getPref('permissionMode')).toBe('dangerouslySkipPermissions')
  })
})
