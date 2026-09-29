/** Tests for ReviewCommentsTray — sends fresh drafts by default, stale ones only when opted in, lists sent history, and hints when empty. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ReviewCommentsTray } from './ReviewCommentsTray.js'
import type { ReviewComment } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

const comment = (id: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id, body: `comment ${id}`, status: 'draft', author: 'owner', authorRole: 'owner', createdAt: '',
  anchor: { path: 'src/a.ts', side: 'new', startLine: 3, endLine: 3, view: 'branch', source: 'worktree', excerpt: [], fingerprint: 'f' },
  ...extra,
})

function render(comments: ReviewComment[], props: Partial<React.ComponentProps<typeof ReviewCommentsTray>> = {}) {
  const handlers = { onSend: vi.fn(), onDelete: vi.fn(), onSelectFile: vi.fn(), onDismissError: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<ReviewCommentsTray comments={comments} view="branch" sending={false} error={null} hasFiles {...handlers} {...props} />)
  })
  return { c: container, ...handlers }
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const sendButton = (c: HTMLElement) => [...c.querySelectorAll('button')].find(b => b.textContent?.includes('to agent'))!

describe('ReviewCommentsTray', () => {
  it('hints how to comment when there are none', () => {
    expect(render([]).c.textContent).toContain('Click a line number to comment')
  })

  it('sends fresh drafts, and stale ones only after opting in', () => {
    const { c, onSend } = render([comment('a'), comment('b', { stale: true }), comment('s', { status: 'sent' })])

    expect(c.textContent).toContain('2 drafts · 1 changed')
    expect(sendButton(c).textContent).toContain('Send 1 to agent')
    act(() => { sendButton(c).click() })
    expect(onSend).toHaveBeenLastCalledWith(['a'], false)

    act(() => { (c.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
    expect(sendButton(c).textContent).toContain('Send 2 to agent')
    act(() => { sendButton(c).click() })
    expect(onSend).toHaveBeenLastCalledWith(['a', 'b'], true)
  })

  it('disables sending when only stale drafts remain and none are included', () => {
    const { c } = render([comment('b', { stale: true })])
    expect(sendButton(c).disabled).toBe(true)
  })

  it('labels comments from other views, jumps to files, and shows sent history on demand', () => {
    const { c, onSelectFile } = render([comment('a', { anchor: { ...comment('a').anchor, view: 'committed' } }), comment('s', { status: 'sent' })], { view: 'branch' })

    expect(c.textContent).toContain('src/a.ts:3')
    expect(c.textContent).toContain('· committed')
    act(() => { [...c.querySelectorAll('button')].find(b => b.textContent === 'src/a.ts:3')!.click() })
    expect(onSelectFile).toHaveBeenCalledWith('src/a.ts')

    expect(c.textContent).not.toContain('comment s')
    act(() => { [...c.querySelectorAll('button')].find(b => b.textContent?.includes('1 sent'))!.click() })
    expect(c.textContent).toContain('comment s')
  })

  it('shows errors', () => {
    const { c } = render([comment('a')], { error: '1 comment(s) point at code that has changed' })
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('point at code that has changed')
  })
})
