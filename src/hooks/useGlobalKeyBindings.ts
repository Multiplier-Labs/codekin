import { useEffect } from 'react'

/**
 * Registers global keyboard shortcuts:
 * - Cmd/Ctrl+K → toggle command palette
 * - Cmd/Ctrl+Shift+D → toggle diff panel
 */
export function useGlobalKeyBindings({
  onTogglePalette,
  onToggleDiffPanel,
}: {
  onTogglePalette: () => void
  onToggleDiffPanel: () => void
}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        onTogglePalette()
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        onToggleDiffPanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onTogglePalette, onToggleDiffPanel])
}
