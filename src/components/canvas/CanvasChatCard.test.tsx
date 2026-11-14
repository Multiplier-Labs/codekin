/** Tests for CanvasChatCard — new, updated, open, pinned-behind and deleted states. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasChatCard, type CanvasCardContext } from './CanvasChatCard'
import type { CanvasItem, ChatMessage } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function render(msg: Extract<ChatMessage, { type: 'canvas_card' }>, ctx: CanvasCardContext): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<CanvasChatCard msg={msg} ctx={ctx} />) })
  return container
}
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
})

const item = (over: Partial<CanvasItem> = {}): CanvasItem => ({
  id: 'i1', kind: 'table', title: 'Bench', source: { type: 'agent' }, latest: 1,
  revisions: [], createdAt: '', updatedAt: '', ...over,
})
const card = (over: Partial<Extract<ChatMessage, { type: 'canvas_card' }>> = {}) =>
  ({ type: 'canvas_card', itemId: 'i1', kind: 'table', title: 'Bench', revision: 1, action: 'created', ...over }) as const

describe('CanvasChatCard', () => {
  it('says new, and opens the item on click', () => {
    const onOpen = vi.fn()
    const el = render(card(), { items: [item()], openItemId: null, onOpen })
    expect(el.textContent).toContain('Bench')
    expect(el.textContent).toContain('new')
    act(() => { el.querySelector('button')!.click() })
    expect(onOpen).toHaveBeenCalledWith('i1')
  })

  it('shows updates, the open item, and a pinned item that moved on', () => {
    expect(render(card({ action: 'updated', revision: 3 }), { items: [item()], openItemId: null, onOpen: vi.fn() }).textContent).toContain('updated · rev 3')
    expect(render(card(), { items: [item()], openItemId: 'i1', onOpen: vi.fn() }).textContent).toContain('open')
    expect(render(card(), { items: [item({ latest: 4, pinnedRevision: 3 })], openItemId: null, onOpen: vi.fn() }).textContent).toContain("rev 4 · you're on rev 3")
  })

  it('becomes a quiet deleted row once the list shows the item gone, but not before the list loads', () => {
    const gone = render(card(), { items: [], openItemId: null, onOpen: vi.fn() })
    expect(gone.textContent).toContain('Bench · deleted')
    expect(gone.querySelector('button')).toBeNull()
    expect(render(card(), { items: null, openItemId: null, onOpen: vi.fn() }).querySelector('button')).not.toBeNull()
  })
})
