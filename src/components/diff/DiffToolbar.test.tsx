/** Tests for DiffToolbar — verifies branch views hide discard and expose the review-base picker, and uncommitted views keep discard. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DiffToolbar } from './DiffToolbar.js'
import type { DiffReview } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function render(ui: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(ui)
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const summary = { filesChanged: 3, insertions: 10, deletions: 2, truncated: false }
const review: DiffReview = { baseRef: 'main', baseSource: 'default', mergeBase: 'abcdef1234', head: 'fedcba', candidates: ['feat/x', 'main', 'develop', 'origin/main'] }

describe('DiffToolbar', () => {
  it('shows the base picker and no discard button for a branch view', () => {
    const onReviewBaseChange = vi.fn()
    const c = render(
      <DiffToolbar branch="feat/x" scope="branch" summary={summary} review={review} loading={false} hasUntrackedFiles={false}
        onScopeChange={vi.fn()} onReviewBaseChange={onReviewBaseChange} onRefresh={vi.fn()} />,
    )

    expect(c.textContent).toContain('All task changes')
    expect(c.querySelector('[title="Discard all changes"]')).toBeNull()
    const select = c.querySelector('select')!
    expect([...select.options].map(o => o.value)).toEqual(['__automatic__', 'main', 'develop', 'origin/main'])
    expect(select.options[0].textContent).toBe('main (automatic)')

    act(() => {
      select.value = 'develop'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onReviewBaseChange).toHaveBeenCalledWith('develop')

    act(() => {
      select.value = '__automatic__'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onReviewBaseChange).toHaveBeenLastCalledWith(null)
  })

  it('keeps discard for uncommitted views', () => {
    const c = render(
      <DiffToolbar branch="feat/x" scope="all" summary={summary} review={null} loading={false} hasUntrackedFiles={false}
        onScopeChange={vi.fn()} onReviewBaseChange={vi.fn()} onRefresh={vi.fn()} onDiscardAll={vi.fn()} />,
    )

    expect(c.textContent).toContain('Uncommitted')
    expect(c.querySelector('[title="Discard all changes"]')).not.toBeNull()
    expect(c.querySelector('select')).toBeNull()
  })
})
