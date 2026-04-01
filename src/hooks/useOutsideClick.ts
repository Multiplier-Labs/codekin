import { useEffect, type RefObject } from 'react'

/**
 * Calls `onClose` when a mousedown event occurs outside the referenced element.
 * The listener is only attached while `isOpen` is true.
 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen, ref, onClose])
}
