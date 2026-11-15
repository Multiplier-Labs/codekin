/** Tests for CompareView: big comparisons fold unchanged runs and draw a page of rows at a time. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CompareView } from './CompareView'
import type { CanvasItem } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

function mount(kind: CanvasItem['kind'], a: string, b: string, mediaType = 'text/csv') {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const item = { kind, title: 't' } as CanvasItem
  act(() => root!.render(
    <CompareView item={item} from={1} to={2} a={{ content: a, encoding: 'utf8', mediaType }} b={{ content: b, encoding: 'utf8', mediaType }} source={false} />,
  ))
  return container
}

const button = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find(b => text.test(b.textContent ?? ''))

describe('CompareView', () => {
  it('folds unchanged table rows around a small edit', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `r${i}`)
    const a = ['value', ...rows].join('\n')
    const b = ['value', ...rows.map((r, i) => (i === 10_000 ? 'changed' : r))].join('\n')
    const el = mount('table', a, b)
    expect(el.querySelectorAll('tbody tr').length).toBeLessThan(20)
    // Three rows of context stay on each side of the edit.
    expect(el.textContent).toContain('9,997 unchanged rows')
    expect(el.textContent).toContain('9,996 unchanged rows')
    expect(el.textContent).toContain('1 added · 1 removed')
  })

  it('draws a page of rows at a time when everything changed', () => {
    const a = Array.from({ length: 2_000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 2_000 }, (_, i) => `b${i}`).join('\n')
    const el = mount('code', a, b, 'text/plain')
    const drawn = () => el.querySelectorAll('pre > div').length
    expect(drawn()).toBe(500)
    act(() => button(el, /Show 500 more/)!.click())
    expect(drawn()).toBe(1000)
  })

  it('opens a folded run', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`)
    const el = mount('code', lines.join('\n'), [...lines, 'new'].join('\n'), 'text/plain')
    // Three lines of context, then the added line.
    expect(el.querySelectorAll('pre > div').length).toBe(4)
    act(() => button(el, /47 unchanged lines/)!.click())
    expect(el.querySelectorAll('pre > div').length).toBe(51)
  })
})
