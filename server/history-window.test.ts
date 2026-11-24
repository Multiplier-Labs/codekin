import { describe, expect, it } from 'vitest'
import { joinWindow, pageBefore, windowBefore } from './history-window.js'
import type { WsServerMessage } from './types.js'

const out = (data: string): WsServerMessage => ({ type: 'output', data })
const user = (text: string): WsServerMessage => ({ type: 'user_echo', text })
const result: WsServerMessage = { type: 'result' }
const big = (n: number) => out('x'.repeat(n))

describe('windowBefore', () => {
  it('returns everything when it fits, with no more to load', () => {
    const history = [user('hi'), out('a'), result]
    expect(windowBefore(history, 3, 0)).toEqual({ entries: history, start: 0, hasMore: false })
  })

  it('stops at the byte budget, counting positions from the base', () => {
    const history = [big(100), big(100), big(100), big(100)]
    const win = windowBefore(history, 4, 10, 300)
    expect(win.entries).toHaveLength(2)
    expect(win.start).toBe(12)
    expect(win.hasMore).toBe(true)
  })

  it('stops at the entry cap', () => {
    const history = Array.from({ length: 10 }, (_, i) => out(String(i)))
    const win = windowBefore(history, 10, 0, 1_000_000, 4)
    expect(win.entries.map(m => (m as { data: string }).data)).toEqual(['6', '7', '8', '9'])
  })

  it('always takes one entry, however large', () => {
    const win = windowBefore([out('a'), big(5000)], 2, 0, 100)
    expect(win.entries).toEqual([big(5000)])
    expect(win.hasMore).toBe(true)
  })

  it('starts at a turn boundary in the older half of the window', () => {
    // Budget takes the last five; the first of them is mid-turn.
    const history = [user('one'), big(50), big(50), result, user('two'), big(50), big(50), big(50)]
    const win = windowBefore(history, history.length, 0, 5 * 70)
    expect(win.entries[0]).toEqual(user('two'))
    expect(win.start).toBe(4)
  })

  it('keeps a mid-turn start when no boundary is in the older half', () => {
    const history = [user('one'), ...Array.from({ length: 6 }, () => big(50))]
    const win = windowBefore(history, history.length, 0, 4 * 80)
    expect(win.entries).toHaveLength(4)
    expect(win.entries[0].type).toBe('output')
  })
})

describe('pageBefore', () => {
  it('returns the page ending before an absolute position', () => {
    const history = [user('a'), out('1'), result, user('b'), out('2')]
    const page = pageBefore(history, 100, 103)
    expect(page.entries).toEqual([user('a'), out('1'), result])
    expect(page.start).toBe(100)
    expect(page.hasMore).toBe(false)
  })

  it('is empty for a position already trimmed away', () => {
    expect(pageBefore([out('a')], 50, 40)).toEqual({ entries: [], start: 50, hasMore: false })
  })
})

describe('joinWindow', () => {
  it('puts the last task list in front of a window that does not include it', () => {
    const todo: WsServerMessage = { type: 'todo_update', tasks: [] }
    const history = [todo, big(100), big(100), big(100)]
    const win = joinWindow(history, 0)
    expect(win.hasMore).toBe(false) // all fit the default budget
    const small = [todo, ...Array.from({ length: 30 }, () => big(30_000))]
    const capped = joinWindow(small, 0)
    expect(capped.hasMore).toBe(true)
    expect(capped.entries[0]).toBe(todo)
    expect(capped.start).toBeGreaterThan(1)
  })
})
