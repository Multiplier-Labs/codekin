import { useState, useRef, useCallback } from 'react'

/**
 * Manages an error notification string that auto-dismisses after 5 seconds.
 * Returns the current error and a `showError` callback to set it.
 */
export function useErrorNotification() {
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showError = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setError(msg)
    timerRef.current = setTimeout(() => setError(null), 5000)
  }, [])

  return { error, showError }
}
