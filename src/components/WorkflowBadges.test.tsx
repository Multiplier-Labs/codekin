/** Tests for WorkflowBadges — verifies StatusBadge covers every status branch (incl. fallback) and CategoryBadge maps kind→category. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusBadge, CategoryBadge } from './WorkflowBadges.js'

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

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

describe('StatusBadge', () => {
  it.each([
    'succeeded',
    'failed',
    'running',
    'queued',
    'canceled',
    'skipped',
  ])('renders the "%s" status label', (status) => {
    const container = render(<StatusBadge status={status} />)
    expect(container.textContent).toContain(status)
  })

  it('falls back to rendering the raw status for an unknown value', () => {
    const container = render(<StatusBadge status="mystery-state" />)
    expect(container.textContent).toContain('mystery-state')
  })
})

describe('CategoryBadge', () => {
  it('renders the mapped category for a known kind', () => {
    // coverage.daily → 'assessment'
    const container = render(<CategoryBadge kind="coverage.daily" />)
    expect(container.textContent?.trim()).toBe('assessment')
  })

  it('renders the event category for an event kind', () => {
    // pr-review → 'event'
    const container = render(<CategoryBadge kind="pr-review" />)
    expect(container.textContent?.trim()).toBe('event')
  })

  it('falls back to "assessment" for an unknown kind', () => {
    const container = render(<CategoryBadge kind="does-not-exist" />)
    expect(container.textContent?.trim()).toBe('assessment')
  })
})
