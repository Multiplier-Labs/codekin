/** Tests for DiffHunkView commenting — gutter-click selection, shift-click ranges per side, the composer, and inline comment cards with edit/delete. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DiffHunkView, type DiffCommenting } from './DiffHunkView.js'
import type { DiffHunk, ReviewComment } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

const hunks: DiffHunk[] = [{
  header: '@@ -1,3 +1,4 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
  lines: [
    { type: 'context', content: 'const a = 1', oldLineNo: 1, newLineNo: 1 },
    { type: 'delete', content: 'const b = 2', oldLineNo: 2 },
    { type: 'add', content: 'const b = 20', newLineNo: 2 },
    { type: 'add', content: 'const c = 3', newLineNo: 3 },
    { type: 'context', content: 'export {}', oldLineNo: 3, newLineNo: 4 },
  ],
}]

function commenting(extra: Partial<DiffCommenting> = {}): DiffCommenting {
  return { comments: [], onAdd: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), ...extra }
}

function render(c?: DiffCommenting): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<DiffHunkView hunks={hunks} commenting={c} />)
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

/** Click the gutter of the diff row showing `content`. */
function clickLine(c: HTMLElement, content: string, shiftKey = false) {
  const row = [...c.querySelectorAll('tr')].find(tr => tr.textContent?.includes(content))
  if (!row) throw new Error(`row "${content}" not found`)
  const gutter = row.querySelector('td')!
  act(() => { gutter.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })) })
}

function type(c: HTMLElement, text: string) {
  const textarea = c.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(c: HTMLElement, label: string): HTMLButtonElement {
  const b = [...c.querySelectorAll('button')].find(el => el.textContent?.trim() === label)
  if (!b) throw new Error(`button "${label}" not found`)
  return b
}

const comment = (extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1', body: 'Why 20?', status: 'draft', author: 'owner', authorRole: 'owner', createdAt: '',
  anchor: { path: 'a.ts', side: 'new', startLine: 2, endLine: 3, view: 'branch', source: 'worktree', excerpt: [], fingerprint: 'f' },
  ...extra,
})

describe('DiffHunkView commenting', () => {
  it('does nothing on gutter clicks without commenting', () => {
    const c = render()
    clickLine(c, 'const c = 3')
    expect(c.querySelector('textarea')).toBeNull()
  })

  it('selects a new-side range with shift-click and adds a comment', () => {
    const onAdd = vi.fn()
    const c = render(commenting({ onAdd }))

    clickLine(c, 'const b = 20')
    clickLine(c, 'const c = 3', true)
    expect(c.textContent).toContain('Comment on lines 2–3')
    type(c, 'Use a constant')
    act(() => { button(c, 'Add comment').click() })

    expect(onAdd).toHaveBeenCalledWith({ side: 'new', startLine: 2, endLine: 3 }, 'Use a constant')
    expect(c.querySelector('textarea')).toBeNull()
  })

  it('comments on removed lines on the old side and does not mix sides', () => {
    const onAdd = vi.fn()
    const c = render(commenting({ onAdd }))

    clickLine(c, 'const b = 2\n'.trim())
    clickLine(c, 'const c = 3', true)  // other side: starts a new selection
    expect(c.textContent).toContain('Comment on line 3')

    clickLine(c, 'const b = 2')
    expect(c.textContent).toContain('Comment on removed line 2')
    type(c, 'Keep this')
    act(() => { button(c, 'Add comment').click() })
    expect(onAdd).toHaveBeenCalledWith({ side: 'old', startLine: 2, endLine: 2 }, 'Keep this')
  })

  it('cancels without saving and refuses an empty comment', () => {
    const onAdd = vi.fn()
    const c = render(commenting({ onAdd }))
    clickLine(c, 'export {}')

    expect(button(c, 'Add comment').disabled).toBe(true)
    act(() => { button(c, 'Cancel').click() })

    expect(c.querySelector('textarea')).toBeNull()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('shows saved comments under their last line with status, edit and delete', () => {
    const onUpdate = vi.fn()
    const onDelete = vi.fn()
    const c = render(commenting({ comments: [comment({ stale: true }), comment({ id: 'c2', body: 'Done', status: 'sent', authorRole: 'grantee', author: 'u-alice-1234' })], onUpdate, onDelete }))

    const cards = [...c.querySelectorAll('[data-comment-id]')]
    expect(cards.map(el => el.getAttribute('data-comment-id'))).toEqual(['c1', 'c2'])
    const row = [...c.querySelectorAll('tr')].find(tr => tr.textContent?.includes('const c = 3'))!
    expect(row.nextElementSibling?.textContent).toContain('Why 20?')
    expect(cards[0].textContent).toContain('code changed')
    expect(cards[1].textContent).toContain('Shared user u-alice-')
    expect(cards[1].textContent).toContain('sent')
    expect([...cards[1].querySelectorAll('button')].map(b => b.textContent)).toEqual(['Delete'])

    act(() => { button(cards[0] as HTMLElement, 'Edit').click() })
    type(c, 'Why 20, not 2?')
    act(() => { button(c, 'Save').click() })
    expect(onUpdate).toHaveBeenCalledWith('c1', 'Why 20, not 2?')

    act(() => { button(c.querySelector('[data-comment-id="c2"]') as HTMLElement, 'Delete').click() })
    expect(onDelete).toHaveBeenCalledWith('c2')
  })
})
