/** Tests for DiffToolbar — verifies the view tabs and "…" menu, the narrow dropdown, and the branch/base picker shown only for branch views. */
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

const click = (el: Element | null | undefined) => { act(() => { (el as HTMLElement).click() }) }
const byText = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(text))

describe('DiffToolbar', () => {
  it('shows views as tabs with the count on the active one', () => {
    const onScopeChange = vi.fn()
    const c = render(
      <DiffToolbar branch="feat/x" scope="branch" summary={summary} review={review} onScopeChange={onScopeChange} onReviewBaseChange={vi.fn()} />,
    )

    const tabs = [...c.querySelectorAll('[role="tab"]')]
    expect(tabs.map(t => t.textContent)).toEqual(['All task changes3', 'Committed', 'Uncommitted'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    click(tabs[2])
    expect(onScopeChange).toHaveBeenCalledWith('all')

    click(c.querySelector('[aria-label="More views"]'))
    click(byText(c, 'Staged'))
    expect(onScopeChange).toHaveBeenLastCalledWith('staged')
  })

  it('shows the branch once and picks the review base from a menu', () => {
    const onReviewBaseChange = vi.fn()
    const c = render(
      <DiffToolbar branch="feat/x" scope="branch" summary={summary} review={review} onScopeChange={vi.fn()} onReviewBaseChange={onReviewBaseChange} />,
    )

    expect(c.textContent?.split('feat/x').length).toBe(2)
    expect(c.textContent).toContain('Compared with')
    expect(c.textContent).toContain('default branch')

    click(c.querySelector('[aria-label="Compared with main"]'))
    const items = [...c.querySelectorAll('[role="menuitem"]')].map(i => i.textContent)
    expect(items).toEqual(['Automaticmain · default branch', 'main', 'develop', 'origin/main'])

    click(byText(c, 'develop'))
    expect(onReviewBaseChange).toHaveBeenCalledWith('develop')

    click(c.querySelector('[aria-label="Compared with main"]'))
    click(byText(c, 'Automatic'))
    expect(onReviewBaseChange).toHaveBeenLastCalledWith(null)
  })

  it('shows a hint instead of the base for uncommitted views', () => {
    const c = render(
      <DiffToolbar branch="feat/x" scope="all" summary={summary} review={null} onScopeChange={vi.fn()} onReviewBaseChange={vi.fn()} />,
    )

    expect(c.textContent).toContain('Edits not yet committed, including new files')
    expect(c.textContent).not.toContain('Compared with')
  })

  it('collapses the views into a dropdown when narrow', () => {
    const onScopeChange = vi.fn()
    const c = render(
      <DiffToolbar branch="feat/x" scope="branch" summary={summary} review={review} narrow onScopeChange={onScopeChange} onReviewBaseChange={vi.fn()} />,
    )

    expect(c.querySelector('[role="tab"]')).toBeNull()
    click(byText(c, 'All task changes'))
    expect([...c.querySelectorAll('[role="menuitem"]')].map(i => i.textContent)).toEqual(['All task changes', 'Committed', 'Uncommitted', 'Staged', 'Unstaged'])
    click(byText(c, 'Unstaged'))
    expect(onScopeChange).toHaveBeenCalledWith('unstaged')
  })
})
