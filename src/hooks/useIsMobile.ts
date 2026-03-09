/**
 * Reactive hook that returns true when the viewport is narrower than the
 * mobile breakpoint (1024px by default). Uses `matchMedia` for efficiency.
 */

import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 1024

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  )

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])

  return isMobile
}
