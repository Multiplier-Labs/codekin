/**
 * Content-driven textarea height.
 *
 * Browsers that support `field-sizing: content` size the textarea themselves,
 * so this hook stays out of the way there. Everywhere else it measures
 * scrollHeight after each change and writes the height back; the element's CSS
 * `max-height` still caps it, at which point the textarea scrolls internally.
 */

import { useLayoutEffect, type RefObject } from 'react'

function supportsFieldSizing(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')
}

export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || supportsFieldSizing()) return
    // Collapse first so scrollHeight reports the content height, not the
    // previous (larger) box.
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}
