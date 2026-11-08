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

function render(messages: ChatMessage[], sessionId?: string) {
  act(() => { root!.render(<ChatView messages={messages} fontSize={14} sessionId={sessionId} />) })
}

/** The reader scrolls the transcript themselves: a gesture, then the scroll it causes. */
function readerScrollsTo(scroller: HTMLElement, state: { top: number }, top: number) {
  act(() => { scroller.dispatchEvent(new Event('wheel')) })
  state.top = top
  act(() => { scroller.dispatchEvent(new Event('scroll')) })
}

describe('ChatView scroll on transcript rebuild', () => {
  it('restores the offset of a reader who scrolled up', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(transcript('a'))

    const scroller = container.querySelector('.chat-scroll') as HTMLElement
    const state = fakeScroller(scroller)
    readerScrollsTo(scroller, state, 600)

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
    readerScrollsTo(scroller, state, 600)

    state.top = 550
    render([...first, { type: 'user', text: 'new', key: 'a-new' }])
    expect(state.top).toBe(550)
  })
})

describe('ChatView opens a session at the bottom', () => {
  function mountEmpty(sessionId?: string) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render([], sessionId)
    const scroller = container.querySelector('.chat-scroll') as HTMLElement
    return { scroller, state: fakeScroller(scroller) }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('opens at the bottom when the transcript fills in', () => {
    const { state } = mountEmpty('s1')
    render(transcript('a'), 's1')
    expect(state.top).toBe(1500)
  })

  it('opens the next session at the bottom even if the reader had scrolled up in the last one', () => {
    const { scroller, state } = mountEmpty('s1')
    render(transcript('a'), 's1')
    readerScrollsTo(scroller, state, 300)

    // Switching clears the transcript (the browser clamps to the top), then joins the next one.
    render([], 's2')
    state.top = 0
    render(transcript('b'), 's2')
    expect(state.top).toBe(1500)
  })

  it('opens at the bottom when the session changes without the transcript being cleared', () => {
    const { scroller, state } = mountEmpty('s1')
    render(transcript('a'), 's1')
    readerScrollsTo(scroller, state, 300)

    state.top = 0
    render(transcript('b'), 's2')
    expect(state.top).toBe(1500)
  })

  it('holds a just-opened transcript at the bottom against scrolls the reader did not make', () => {
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { scroller, state } = mountEmpty('s1')
    render(transcript('a'), 's1')

    // The browser reports a stale position while the layout settles.
    state.top = 0
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    expect(state.top).toBe(1500)

    // Once settled, a scroll position is taken as it comes.
    now += 2000
    state.top = 300
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    expect(state.top).toBe(300)
  })

  it('lets the reader scroll away straight after opening', () => {
    const { scroller, state } = mountEmpty('s1')
    render(transcript('a'), 's1')
    readerScrollsTo(scroller, state, 300)
    expect(state.top).toBe(300)
    render([...transcript('a'), { type: 'user', text: 'new', key: 'a-new' }], 's1')
    expect(state.top).toBe(300)
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
    expect(state.top).toBe(1500)

    // Scrolled up: a resize leaves the reader alone.
    readerScrollsTo(scroller, state, 300)
    act(() => { callbacks.forEach(cb => { cb() }) })
    expect(state.top).toBe(300)
    vi.unstubAllGlobals()
  })
})

describe('ChatView never fights the reader’s own scrolling (WebKit snap-back)', () => {
  function setup() {
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
    let writes = 0
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => state.top,
      set: (v: number) => { writes++; state.top = v },
    })
    state.top = 1450
    act(() => { scroller.dispatchEvent(new Event('scroll')) })
    writes = 0
    return { scroller, state, resize: () => { act(() => { callbacks.forEach(cb => { cb() }) }) }, writes: () => writes }
  }

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('holds writes while the reader scrolls, then follows once they stop', () => {
    vi.useFakeTimers()
    const { scroller, state, resize, writes } = setup()
    act(() => { scroller.dispatchEvent(new Event('wheel')) })
    state.top = 1420
    resize()
    expect(writes()).toBe(0)
    act(() => { vi.advanceTimersByTime(400) })
    expect(writes()).toBe(1)
    expect(state.top).toBe(1500)
  })

  it('does not write when already at the bottom', () => {
    const { state, resize, writes } = setup()
    state.top = 1500
    resize()
    expect(writes()).toBe(0)
  })
})

describe('ChatView keeps rendered messages in place while output streams', () => {
  it('does not remount an earlier message’s code block when a new message arrives', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const first: ChatMessage[] = [
      { type: 'assistant', text: 'Here:\n\n```ts\nconst a = 1\n```\n\nSee `x` and [docs](https://example.com).', complete: true, key: 'm1' },
    ]
    render(first)
    const codeBlock = container.querySelector('.hljs')
    const inlineCode = container.querySelector('p code')
    const link = container.querySelector('a[href="https://example.com"]')
    expect(codeBlock).not.toBeNull()

    render([...first, { type: 'assistant', text: 'streaming…', complete: false, key: 'm2' }])
    expect(container.querySelector('.hljs')).toBe(codeBlock)
    expect(container.querySelector('p code')).toBe(inlineCode)
    expect(container.querySelector('a[href="https://example.com"]')).toBe(link)
  })

  it('keeps the code block of the streaming message itself while its text grows', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const text = 'Plan:\n\n```sh\nnpm test\n```\n\nRunning'
    render([{ type: 'assistant', text, complete: false, key: 'm1' }])
    const codeBlock = container.querySelector('.hljs')
    render([{ type: 'assistant', text: text + ' the suite now', complete: false, key: 'm1' }])
    expect(container.querySelector('.hljs')).toBe(codeBlock)
  })
})
