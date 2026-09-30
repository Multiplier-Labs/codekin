/** Tests for useDiff — verifies per-session default views, requestId/sessionId filtering of late responses, review-base requests, read-only branch views and turn-end refresh. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useDiff } from './useDiff'
import type { DiffView, WsClientMessage, WsServerMessage } from '../types'

type Hook = ReturnType<typeof useDiff>
interface Props { sessionId: string | null; defaultView: DiffView; isOpen: boolean }

let hook: Hook
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
let sent: WsClientMessage[]
const send = (msg: WsClientMessage) => { sent.push(msg) }

function Harness(props: Props) {
  hook = useDiff({ send, ...props })
  return null
}

function render(props: Props) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => { root!.render(createElement(Harness, props)) })
}

function lastRequestId(): number {
  const m = sent.at(-1) as { requestId?: number }
  return m.requestId!
}

function result(extra: Partial<Extract<WsServerMessage, { type: 'diff_result' }>> = {}): WsServerMessage {
  return {
    type: 'diff_result', branch: 'feat/x', scope: 'branch', sessionId: 's1',
    files: [{ path: 'a.ts', status: 'modified', isBinary: false, additions: 1, deletions: 0, hunks: [] }],
    summary: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    ...extra,
  }
}

beforeEach(() => { sent = [] })

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useDiff', () => {
  it('opens an isolated session on the branch view and tags the request', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })

    expect(hook.scope).toBe('branch')
    expect(sent.at(-1)).toMatchObject({ type: 'get_diff', scope: 'branch' })
    expect(typeof lastRequestId()).toBe('number')
  })

  it('accepts the latest response and drops older ones', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })
    const first = lastRequestId()
    act(() => { hook.changeScope('committed') })
    const second = lastRequestId()

    act(() => { hook.handleMessage(result({ requestId: first, files: [] })) })
    expect(hook.files).toEqual([])
    expect(hook.loading).toBe(true)

    act(() => { hook.handleMessage(result({ requestId: second, scope: 'committed' })) })
    expect(hook.files.map(f => f.path)).toEqual(['a.ts'])
    expect(hook.loading).toBe(false)
  })

  it("ignores responses for another session and resets on switch", () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })
    act(() => { hook.handleMessage(result({ requestId: lastRequestId() })) })
    expect(hook.files).toHaveLength(1)

    render({ sessionId: 's2', defaultView: 'all', isOpen: true })
    expect(hook.files).toEqual([])
    expect(hook.scope).toBe('all')

    act(() => { hook.handleMessage(result({ sessionId: 's1', requestId: lastRequestId() })) })
    expect(hook.files).toEqual([])
  })

  it('clears the previous result when a request fails', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })
    act(() => { hook.handleMessage(result({ requestId: lastRequestId() })) })
    act(() => { hook.refresh() })

    act(() => { hook.handleMessage({ type: 'diff_error', message: 'no common history', requestId: lastRequestId(), sessionId: 's1' }) })

    expect(hook.error).toBe('no common history')
    expect(hook.files).toEqual([])
  })

  it('sends a review-base change for the current view', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })

    act(() => { hook.changeReviewBase('develop') })

    expect(sent.at(-1)).toMatchObject({ type: 'set_review_base', base: 'develop', scope: 'branch' })
  })

  it('never sends a discard from a branch view', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: true })
    const before = sent.length

    act(() => { hook.discard(['a.ts']) })
    expect(sent).toHaveLength(before)

    act(() => { hook.changeScope('all') })
    act(() => { hook.discard(['a.ts']) })
    expect(sent.at(-1)).toMatchObject({ type: 'discard_changes', scope: 'all', paths: ['a.ts'] })
  })

  it('refreshes after an agent turn while open', () => {
    vi.useFakeTimers()
    try {
      render({ sessionId: 's1', defaultView: 'branch', isOpen: true })
      const before = sent.length

      act(() => { hook.handleTurnDone() })
      act(() => { vi.advanceTimersByTime(600) })

      expect(sent).toHaveLength(before + 1)
      expect(sent.at(-1)).toMatchObject({ type: 'get_diff', scope: 'branch' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing while closed', () => {
    render({ sessionId: 's1', defaultView: 'branch', isOpen: false })
    act(() => { hook.refresh() })
    act(() => { hook.handleTurnDone() })

    expect(sent).toEqual([])
  })
})
