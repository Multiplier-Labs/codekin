import { useEffect, useRef } from 'react'

/**
 * Calls `onVisible` when the page transitions from hidden to visible, with how
 * long it was hidden (Infinity if the hide wasn't observed). Does NOT fire on
 * initial mount.
 */
export function usePageVisibility(onVisible: (hiddenForMs: number) => void) {
  const callbackRef = useRef(onVisible)
  useEffect(() => {
    callbackRef.current = onVisible
  })

  useEffect(() => {
    let hiddenAt: number | null = null
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      const hiddenFor = hiddenAt === null ? Infinity : Date.now() - hiddenAt
      hiddenAt = null
      callbackRef.current(hiddenFor)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])
}
