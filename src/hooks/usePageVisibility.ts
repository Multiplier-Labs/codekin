import { useEffect, useRef } from 'react'

/**
 * Calls `onVisible` when the page transitions from hidden to visible.
 * Does NOT fire on initial mount.
 */
export function usePageVisibility(onVisible: () => void) {
  const callbackRef = useRef(onVisible)
  useEffect(() => {
    callbackRef.current = onVisible
  })

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        callbackRef.current()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])
}
