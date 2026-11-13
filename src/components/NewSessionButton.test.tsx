/**
 * Tests for NewSessionButton — New opens the new-session composer and is
 * marked current while the composer is up.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NewSessionButton } from './NewSessionButton.js'

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
  if (activeRoot) act(() => { activeRoot!.unmount() })
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

describe('NewSessionButton', () => {
  it('opens the composer', () => {
    const onNewSession = vi.fn()
    const c = render(<NewSessionButton onNewSession={onNewSession} />)
    const button = c.querySelector('button')!
    expect(button.textContent).toBe('New')
    expect(button.hasAttribute('aria-current')).toBe(false)
    act(() => { button.click() })
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('is marked current while the composer is up', () => {
    const c = render(<NewSessionButton onNewSession={() => {}} current />)
    expect(c.querySelector('button')!.getAttribute('aria-current')).toBe('page')
  })
})
