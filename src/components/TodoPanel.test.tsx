/** Tests for TodoPanel — verifies show/hide/collapse behavior across task list updates and turn boundaries. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TodoPanel } from './TodoPanel.js'
import type { TaskItem } from '../types'

/* ------------------------------------------------------------------ */
/*  Minimal component renderer                                          */
/* ------------------------------------------------------------------ */

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

function render(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    activeRoot = createRoot(container)
    activeRoot.render(ui)
  })
  activeContainer = container
  return container
}

function rerender(ui: React.ReactElement) {
  act(() => {
    activeRoot!.render(ui)
  })
}

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function task(id: string, status: TaskItem['status'], subject = `Task ${id}`): TaskItem {
  return { id, subject, status }
}

function isVisible(container: HTMLElement): boolean {
  return container.children.length > 0
}

function isExpanded(container: HTMLElement): boolean {
  return container.textContent?.includes('Tasks') ?? false
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('TodoPanel', () => {
  it('renders nothing with no tasks', () => {
    const c = render(<TodoPanel tasks={[]} isProcessing />)
    expect(isVisible(c)).toBe(false)
  })

  it('auto-expands when new tasks arrive while processing', () => {
    const c = render(<TodoPanel tasks={[]} isProcessing />)
    rerender(<TodoPanel tasks={[task('1', 'in_progress'), task('2', 'pending')]} isProcessing />)
    expect(isVisible(c)).toBe(true)
    expect(isExpanded(c)).toBe(true)
  })

  it('shows a collapsed pill (not expanded) when restoring an unfinished list while idle', () => {
    const c = render(<TodoPanel tasks={[task('1', 'in_progress')]} isProcessing={false} />)
    expect(isVisible(c)).toBe(true)
    expect(isExpanded(c)).toBe(false)
  })

  it('auto-dismisses 3s after all tasks complete once the turn is over', () => {
    const c = render(<TodoPanel tasks={[task('1', 'in_progress')]} isProcessing />)
    rerender(<TodoPanel tasks={[task('1', 'completed')]} isProcessing={false} />)
    expect(isVisible(c)).toBe(true)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(isVisible(c)).toBe(false)
  })

  it('keeps the panel for 10s after completion while still processing', () => {
    const c = render(<TodoPanel tasks={[task('1', 'in_progress')]} isProcessing />)
    rerender(<TodoPanel tasks={[task('1', 'completed')]} isProcessing />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(isVisible(c)).toBe(true)
    act(() => { vi.advanceTimersByTime(7000) })
    expect(isVisible(c)).toBe(false)
  })

  it('collapses to the pill when a turn ends with unfinished tasks', () => {
    const c = render(<TodoPanel tasks={[]} isProcessing />)
    rerender(<TodoPanel tasks={[task('1', 'in_progress'), task('2', 'pending')]} isProcessing />)
    expect(isExpanded(c)).toBe(true)
    rerender(<TodoPanel tasks={[task('1', 'in_progress'), task('2', 'pending')]} isProcessing={false} />)
    expect(isVisible(c)).toBe(true)
    expect(isExpanded(c)).toBe(false)
  })

  it('re-shows a dismissed panel when a replaced list with new ids arrives (same length)', () => {
    const c = render(<TodoPanel tasks={[]} isProcessing />)
    rerender(<TodoPanel tasks={[task('1', 'in_progress')]} isProcessing />)
    // complete + dismiss
    rerender(<TodoPanel tasks={[task('1', 'completed')]} isProcessing={false} />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(isVisible(c)).toBe(false)
    // new list generation, same length but different id
    rerender(<TodoPanel tasks={[task('2', 'in_progress')]} isProcessing />)
    expect(isVisible(c)).toBe(true)
  })

  it('dismisses immediately when restoring an already-completed list', () => {
    const c = render(<TodoPanel tasks={[task('1', 'completed')]} isProcessing={false} />)
    act(() => { vi.advanceTimersByTime(0) })
    expect(isVisible(c)).toBe(false)
  })

  it('updates the progress count in the pill', () => {
    const c = render(<TodoPanel tasks={[task('1', 'completed'), task('2', 'in_progress')]} isProcessing={false} />)
    expect(c.textContent).toContain('1/2')
  })
})
