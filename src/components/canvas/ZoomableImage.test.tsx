/** Tests for ZoomableImage: it opens fitted to the panel, and zooms with the buttons and double-click. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ZoomableImage } from './ZoomableImage'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
})

function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<ZoomableImage src="data:image/png;base64,AA==" alt="Shot" />) })
  const viewport = container.firstElementChild as HTMLElement
  // jsdom does no layout: a 532 px wide panel showing a 2000 x 1000 image.
  Object.defineProperty(viewport, 'clientWidth', { value: 532 })
  Object.defineProperty(viewport, 'clientHeight', { value: 600 })
  const img = container.querySelector('img')!
  Object.defineProperty(img, 'naturalWidth', { value: 2000 })
  Object.defineProperty(img, 'naturalHeight', { value: 1000 })
  act(() => { img.dispatchEvent(new Event('load')) })
  return { el: container, viewport, img }
}

const percent = (el: HTMLElement) => el.querySelector('[data-zoom-controls]')!.textContent

describe('ZoomableImage', () => {
  it('opens fitted to the panel width and zooms with the buttons', () => {
    const { el, img } = render()
    expect(img.getAttribute('width')).toBe('2000')
    expect(percent(el)).toContain('25%')
    act(() => { el.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click() })
    expect(percent(el)).toContain('31%')
    act(() => { el.querySelector<HTMLButtonElement>('[aria-label^="Zoom 31%"]')!.click() })
    expect(percent(el)).toContain('100%')
    act(() => { el.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]')!.click() })
    expect(percent(el)).toContain('25%')
  })

  it('double-click toggles between fitted and actual size', () => {
    const { el, viewport } = render()
    act(() => { viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 })) })
    expect(percent(el)).toContain('100%')
    act(() => { viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 })) })
    expect(percent(el)).toContain('25%')
  })
})
