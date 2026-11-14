/** Tests for useCanvas — items per session, content fetches, open/selection state, opening files and errors. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useCanvas } from './useCanvas'
import { setPref } from '../lib/prefs'
import type { CanvasItem, WsClientMessage } from '../types'

let hook: ReturnType<typeof useCanvas>
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
let sent: WsClientMessage[]
const send = (m: WsClientMessage) => { sent.push(m) }

function Harness({ sessionId }: { sessionId: string | null }) {
  hook = useCanvas(sessionId, send)
  return null
}

function render(sessionId: string | null) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => { root!.render(createElement(Harness, { sessionId })) })
}

function item(id: string, over: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id, kind: 'markdown', title: id, source: { type: 'agent' }, latest: 1,
    revisions: [{ n: 1, createdAt: '2026-11-14T10:00:00Z', size: 3, mediaType: 'text/markdown' }],
    createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', ...over,
  }
}

const deliver = (msg: Parameters<typeof hook.handleMessage>[0]) => { act(() => { hook.handleMessage(msg) }) }

beforeEach(() => {
  sent = []
  setPref('canvasSessions', undefined)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useCanvas', () => {
  it('keeps items per session and selects the newest by default', () => {
    render('s1')
    deliver({ type: 'canvas_items', sessionId: 's2', items: [item('other')] })
    expect(hook.items).toEqual([])
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a'), item('b')] })
    expect(hook.items.map(i => i.id)).toEqual(['a', 'b'])
    expect(hook.selected?.id).toBe('b')
    expect(hook.view.state).toBe('loading')
  })

  it('fetches content only while open, then shows it', () => {
    render('s1')
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a')] })
    expect(sent).toEqual([])
    act(() => { hook.setOpen(true) })
    expect(hook.open).toBe(true)
    expect(sent).toEqual([{ type: 'canvas_get', itemId: 'a', revision: 1 }])
    deliver({ type: 'canvas_item', sessionId: 's1', item: item('a'), revision: 1, content: '# A', encoding: 'utf8' })
    expect(hook.view).toMatchObject({ state: 'ready', revision: 1, content: { content: '# A', mediaType: 'text/markdown' } })
  })

  it('shows the pinned revision, and fetches a new latest when not pinned', () => {
    render('s1')
    act(() => { hook.setOpen(true) })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3, pinnedRevision: 2 })] })
    expect(sent.at(-1)).toEqual({ type: 'canvas_get', itemId: 'a', revision: 2 })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3 })] })
    expect(sent.at(-1)).toEqual({ type: 'canvas_get', itemId: 'a', revision: 3 })
  })

  it('attributes an error to the content request in flight', () => {
    render('s1')
    act(() => { hook.setOpen(true) })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a')] })
    deliver({ type: 'canvas_error', sessionId: 's1', message: 'gone', itemId: 'a', revision: 1 })
    expect(hook.view).toMatchObject({ state: 'error', message: 'gone' })
    expect(hook.notice).toBeNull()
  })

  it('opens a file and shows its item when it appears; other failures become a notice', () => {
    render('s1')
    act(() => { hook.openFile('./docs/plan.md') })
    expect(sent).toEqual([{ type: 'canvas_open_file', path: 'docs/plan.md' }])
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('x'), item('p', { source: { type: 'file', path: 'docs/plan.md' } }), item('y')] })
    expect(hook.open).toBe(true)
    expect(hook.selected?.id).toBe('p')

    act(() => { hook.openFile('../secret.md') })
    deliver({ type: 'canvas_error', sessionId: 's1', message: 'outside' })
    expect(hook.notice).toBe('outside')
    act(() => { hook.dismissNotice() })
    expect(hook.notice).toBeNull()
  })

  it('steps through items with wrap-around, and remembers state per session', () => {
    render('s1')
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a'), item('b'), item('c')] })
    act(() => { hook.select('a') })
    act(() => { hook.step(-1) })
    expect(hook.selected?.id).toBe('c')
    act(() => { hook.step(1) })
    expect(hook.selected?.id).toBe('a')
    expect(hook.open).toBe(true)

    render('s2')
    expect(hook.open).toBe(false)
    render('s1')
    expect(hook.open).toBe(true)
    expect(hook.selected?.id).toBe('a')
    act(() => { hook.toggle() })
    expect(hook.open).toBe(false)
  })

  it('treats chat-card events as Canvas messages and ignores others', () => {
    render('s1')
    let handled = false
    act(() => { handled = hook.handleMessage({ type: 'canvas_event', sessionId: 's1', itemId: 'a', kind: 'markdown', title: 'A', revision: 1, action: 'created' }) })
    expect(handled).toBe(true)
    act(() => { handled = hook.handleMessage({ type: 'pong' }) })
    expect(handled).toBe(false)
  })
})

describe('useCanvas auto-open', () => {
  function AutoHarness({ sessionId, decide }: { sessionId: string; decide: (first: boolean) => boolean }) {
    hook = useCanvas(sessionId, send, { shouldAutoOpen: decide })
    return null
  }
  function renderAuto(decide: (first: boolean) => boolean) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(AutoHarness, { sessionId: 's1', decide })) })
  }
  const created = (itemId: string, by: 'agent' | 'file' = 'agent') =>
    ({ type: 'canvas_event', sessionId: 's1', itemId, kind: 'markdown', title: itemId, revision: 1, action: 'created', by }) as const

  it('asks with first=true for the first agent item and opens on it', () => {
    const asked: boolean[] = []
    renderAuto(first => { asked.push(first); return first })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('f', { source: { type: 'file', path: 'a.md' } })] })
    deliver(created('a1'))
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('f', { source: { type: 'file', path: 'a.md' } }), item('a1')] })
    expect(hook.open).toBe(true)
    expect(hook.selected?.id).toBe('a1')

    act(() => { hook.setOpen(false) })
    deliver(created('a2'))
    expect(asked).toEqual([true, false])
    expect(hook.open).toBe(false)
  })

  it('never asks for files the user opened or for revisions', () => {
    const asked: boolean[] = []
    renderAuto(first => { asked.push(first); return true })
    deliver(created('f1', 'file'))
    deliver({ ...created('a1'), action: 'updated' })
    expect(asked).toEqual([])
  })
})

describe('useCanvas revisions', () => {
  const revs = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, createdAt: '2026-11-14T10:00:00Z', size: 1, mediaType: 'text/markdown' }))

  it('replaces the view with a new revision when idle, and holds it while reading', () => {
    render('s1')
    act(() => { hook.select('a') })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 1, revisions: revs(1) })] })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 2, revisions: revs(2) })] })
    expect(hook.view).toMatchObject({ revision: 2 })

    act(() => { hook.setReading(true) })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3, revisions: revs(3) })] })
    expect(hook.view).toMatchObject({ revision: 2 })
    act(() => { hook.showRevision(null) })
    expect(hook.view).toMatchObject({ revision: 3 })
  })

  it('shows a chosen revision, pins and deletes through the socket', () => {
    render('s1')
    act(() => { hook.select('a') })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3, revisions: revs(3) })] })
    act(() => { hook.showRevision(1) })
    expect(hook.view).toMatchObject({ revision: 1 })
    expect(sent).toContainEqual({ type: 'canvas_get', itemId: 'a', revision: 1 })
    act(() => { hook.pin(1) })
    expect(sent.at(-1)).toEqual({ type: 'canvas_pin', itemId: 'a', revision: 1 })
    act(() => { hook.remove('a') })
    expect(sent.at(-1)).toEqual({ type: 'canvas_delete', itemId: 'a' })
  })

  it('fetches both revisions for compare and exposes their content', () => {
    render('s1')
    act(() => { hook.select('a') })
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3, revisions: revs(3) })] })
    act(() => { hook.setCompare({ from: 1, to: 3 }) })
    expect(sent.filter(m => m.type === 'canvas_get').map(m => (m as { revision: number }).revision).sort()).toEqual([1, 3])
    expect(hook.revisionContent(1)).toBe('loading')
    deliver({ type: 'canvas_item', sessionId: 's1', item: item('a', { latest: 3, revisions: revs(3) }), revision: 1, content: 'old', encoding: 'utf8' })
    expect(hook.revisionContent(1)).toMatchObject({ content: 'old' })
    deliver({ type: 'canvas_error', sessionId: 's1', message: 'gone', itemId: 'a', revision: 3 })
    expect(hook.revisionContent(3)).toEqual({ error: 'gone' })
  })
})

describe('useCanvas openAt', () => {
  it('opens an item at an earlier revision, or reports a deleted one', () => {
    render('s1')
    const revs = [1, 2, 3].map(n => ({ n, createdAt: '', size: 1, mediaType: 'text/markdown' }))
    deliver({ type: 'canvas_items', sessionId: 's1', items: [item('a', { latest: 3, revisions: revs }), item('b')] })
    act(() => { hook.select('b') })
    act(() => { hook.openAt('a', 2) })
    expect(hook.open).toBe(true)
    expect(hook.selected?.id).toBe('a')
    expect(hook.view).toMatchObject({ revision: 2 })
    act(() => { hook.openAt('gone', 1) })
    expect(hook.notice).toBe('That Canvas item no longer exists.')
  })
})
