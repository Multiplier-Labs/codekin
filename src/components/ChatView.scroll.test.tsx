/** ChatView keeps a reader's scroll position when a rejoin rebuilds the transcript. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatView } from './ChatView'
import type { ChatMessage } from '../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function transcript(prefix: string): ChatMessage[] {
  return Array.from({ length: 6 }, (_, i) => ({ type: 'user', text: `message ${i}`, key: `${prefix}-${i}` }))
}

/** jsdom has no layout: give the scroll container fixed metrics and a writable scrollTop. */
function fakeScroller(el: HTMLElement): { top: number } {
  const state = { top: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (v: number) => { state.top = v },
  })
  return state
}

function render(messages: ChatMessage[]) {
  act(() => { root!.render(<ChatView messages={messages} fontSize={14} />) })
}

describe('ChatView scroll on transcript rebuild', () => {
  it('restores the offset of a reader who scrolled up', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(transcript('a'))

    const scroller = container.querySelector('.chat-scroll') as HTMLElement
    const state = fakeScroller(scroller)
    state.top = 600
    act(() => { scroller.dispatchEvent(new Event('scroll')) })

    // The browser clamps the position while the nodes are replaced.
    state.top = 0
    render(transcript('b'))
    expect(state.top).toBe(600)
  })

  it('leaves a new message alone when the transcript only grows', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const first = transcript('a')
    render(first)

    const scroller = container.querySelector('.chat-scroll') as HTMLElement
    const state = fakeScroller(scroller)
    state.top = 600
    act(() => { scroller.dispatchEvent(new Event('scroll')) })

    state.top = 550
    render([...first, { type: 'user', text: 'new', key: 'a-new' }])
    expect(state.top).toBe(550)
  })
})

describe('ChatView stays pinned when content resizes without a new message', () => {
  it('follows the bottom only for a reader who is there', () => {
    const callbacks: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe() {}
      disconnect() {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(transcript('a'))
    const scroller = container.querySelector('.chat-scroll') as HTMLElement
    const state = fakeScroller(scroller)

    // At the bottom (scrollHeight 2000 - clientHeight 500): a tool group expands below.
    state.top = 1500
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    state.top = 1400
    act(() => { callbacks.forEach(cb => { cb() }) })
    expect(state.top).toBe(2000)

    // Scrolled up: a resize leaves the reader alone.
    state.top = 300
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    act(() => { callbacks.forEach(cb => { cb() }) })
    expect(state.top).toBe(300)
    vi.unstubAllGlobals()
  })
})
