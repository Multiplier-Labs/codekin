/** Tests for TentativeBanner — verifies queued-message copy, pluralization, and Execute/Discard click handlers. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TentativeBanner } from './TentativeBanner.js'

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

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn as HTMLButtonElement
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('TentativeBanner', () => {
  it('renders the repo name and queued count', () => {
    const container = render(
      <TentativeBanner count={3} repoName="codekin" onExecute={() => {}} onDiscard={() => {}} />,
    )
    expect(container.textContent).toContain('codekin')
    expect(container.textContent).toContain('3 messages queued')
  })

  it('uses the plural "messages" when count is not 1', () => {
    const container = render(
      <TentativeBanner count={2} repoName="repo" onExecute={() => {}} onDiscard={() => {}} />,
    )
    expect(container.textContent).toContain('2 messages queued')
  })

  it('uses the singular "message" when count is exactly 1', () => {
    const container = render(
      <TentativeBanner count={1} repoName="repo" onExecute={() => {}} onDiscard={() => {}} />,
    )
    expect(container.textContent).toContain('1 message queued')
    expect(container.textContent).not.toContain('1 messages queued')
  })

  it('invokes onExecute when "Execute now" is clicked', () => {
    const onExecute = vi.fn()
    const container = render(
      <TentativeBanner count={1} repoName="repo" onExecute={onExecute} onDiscard={() => {}} />,
    )
    click(findButton(container, 'Execute now'))
    expect(onExecute).toHaveBeenCalledTimes(1)
  })

  it('invokes onDiscard when "Discard" is clicked', () => {
    const onDiscard = vi.fn()
    const container = render(
      <TentativeBanner count={1} repoName="repo" onExecute={() => {}} onDiscard={onDiscard} />,
    )
    click(findButton(container, 'Discard'))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})
