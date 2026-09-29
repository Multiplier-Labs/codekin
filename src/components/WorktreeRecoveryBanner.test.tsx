/** Tests for WorktreeRecoveryBanner — verifies failed/missing copy, the server's reason, and Retry / shared-checkout click handlers. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { WorktreeRecoveryBanner } from './WorktreeRecoveryBanner.js'

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

function click(container: HTMLElement, label: string) {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button "${label}" not found`)
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('WorktreeRecoveryBanner', () => {
  it('explains a failed creation with the server reason and that input is held', () => {
    const c = render(
      <WorktreeRecoveryBanner state="failed" error="Branch x is already checked out at /y." onRetry={vi.fn()} onUseExistingCheckout={vi.fn()} />,
    )

    expect(c.textContent).toContain('Worktree could not be created')
    expect(c.textContent).toContain('Branch x is already checked out at /y.')
    expect(c.textContent).toContain('messages you send are held')
    expect(c.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('names a missing worktree', () => {
    const c = render(<WorktreeRecoveryBanner state="missing" onRetry={vi.fn()} onUseExistingCheckout={vi.fn()} />)

    expect(c.textContent).toContain('Worktree is missing')
  })

  it('calls the matching handler for each action', () => {
    const onRetry = vi.fn()
    const onUseExistingCheckout = vi.fn()
    const c = render(<WorktreeRecoveryBanner state="failed" onRetry={onRetry} onUseExistingCheckout={onUseExistingCheckout} />)

    click(c, 'Retry worktree')
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onUseExistingCheckout).not.toHaveBeenCalled()

    click(c, 'Use shared checkout')
    expect(onUseExistingCheckout).toHaveBeenCalledOnce()
  })
})
