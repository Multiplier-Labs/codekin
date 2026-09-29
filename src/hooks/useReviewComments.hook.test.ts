/** Tests for useReviewComments — loads per session, accepts only this session's broadcasts, and sends add/send frames. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useReviewComments } from './useReviewComments'
import type { ReviewComment, WsClientMessage } from '../types'

let hook: ReturnType<typeof useReviewComments>
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
let sent: WsClientMessage[]
const send = (m: WsClientMessage) => { sent.push(m) }

function Harness(props: { sessionId: string | null; isOpen: boolean }) {
  hook = useReviewComments({ send, ...props })
  return null
}

function render(props: { sessionId: string | null; isOpen: boolean }) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => { root!.render(createElement(Harness, props)) })
}

const c1 = { id: 'c1', body: 'x', status: 'draft' } as ReviewComment

beforeEach(() => { sent = [] })
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useReviewComments', () => {
  it('loads once when open and ignores other sessions', () => {
    render({ sessionId: 's1', isOpen: true })
    expect(sent).toEqual([{ type: 'review_comments_get' }])

    act(() => { hook.handleMessage({ type: 'review_comments', sessionId: 's2', comments: [c1] }) })
    expect(hook.comments).toEqual([])
    act(() => { hook.handleMessage({ type: 'review_comments', sessionId: 's1', comments: [c1] }) })
    expect(hook.comments).toEqual([c1])

    render({ sessionId: 's2', isOpen: true })
    expect(hook.comments).toEqual([])
  })

  it('sends add and batch frames and tracks the sending state', () => {
    render({ sessionId: 's1', isOpen: true })

    act(() => { hook.add({ path: 'a.ts', side: 'new', startLine: 1, endLine: 1, view: 'branch', body: 'hi' }) })
    expect(sent.at(-1)).toMatchObject({ type: 'review_comment_add', path: 'a.ts', body: 'hi' })

    act(() => { hook.sendToAgent(['c1'], false) })
    expect(sent.at(-1)).toEqual({ type: 'review_feedback_send', ids: ['c1'], includeStale: false })
    expect(hook.sending).toBe(true)

    act(() => { hook.handleMessage({ type: 'review_error', message: 'nope', sessionId: 's1' }) })
    expect(hook.sending).toBe(false)
    expect(hook.error).toBe('nope')
  })

  it('stays quiet while closed', () => {
    render({ sessionId: 's1', isOpen: false })
    expect(sent).toEqual([])
  })
})
