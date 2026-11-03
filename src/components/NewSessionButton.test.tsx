/**
 * Tests for NewSessionButton — the popover hangs from the button's right edge
 * and grows leftward, so in a narrow sidebar it used to run off the left edge
 * of the window. Guards the measured nudge that keeps it on screen.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { NewSessionButton } from './NewSessionButton.js'

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

const POPUP_WIDTH = 288

function renderAt(anchorRight: number): HTMLElement {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { right: anchorRight, left: anchorRight - 80, top: 0, bottom: 32, width: 80, height: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  )
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(POPUP_WIDTH)
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    activeRoot = createRoot(container)
    activeRoot.render(<NewSessionButton groups={[]} onOpen={() => {}} />)
  })
  activeContainer = container
  act(() => { container.querySelector('button')!.click() })
  return container
}

function popover(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-expanded="true"]')!.nextElementSibling as HTMLElement
}

afterEach(() => {
  if (activeRoot) act(() => { activeRoot!.unmount() })
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
  vi.restoreAllMocks()
})

describe('NewSessionButton popover placement', () => {
  it('stays right-aligned to the button when there is room', () => {
    const c = renderAt(400)
    expect(popover(c).style.right).toBe('0px')
  })

  it('shifts right so it does not overflow the left edge in a narrow sidebar', () => {
    // Button ends 180px from the left; a 288px popover would start at -108px.
    const c = renderAt(180)
    expect(popover(c).style.right).toBe(`-${POPUP_WIDTH - 180 + 8}px`)
  })

  it('caps its width to the viewport', () => {
    const c = renderAt(400)
    expect(popover(c).style.maxWidth).toBe('calc(100vw - 16px)')
  })
})
