import { useEffect } from 'react'
import { canvasStepFromKey, isCanvasToggleKey } from '../lib/canvas'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/**
 * Registers global keyboard shortcuts:
 * - Cmd/Ctrl+K → toggle command palette
 * - Cmd/Ctrl+Shift+D → toggle diff panel
 * - Cmd/Ctrl+\ → toggle Canvas (when a session is showing)
 * - ⌥⌘[ / ⌥⌘] (Ctrl+Alt+[ / ] elsewhere) → previous / next Canvas item
 */
export function useGlobalKeyBindings({
  onTogglePalette,
  onToggleDiffPanel,
  onToggleCanvas,
  onCanvasStep,
}: {
  onTogglePalette: () => void
  onToggleDiffPanel: () => void
  onToggleCanvas?: () => void
  onCanvasStep?: (dir: -1 | 1) => void
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
      if (onToggleCanvas && isCanvasToggleKey(e)) {
        e.preventDefault()
        onToggleCanvas()
      }
      if (onCanvasStep) {
        const dir = canvasStepFromKey(e, IS_MAC)
        if (dir !== 0) {
          e.preventDefault()
          onCanvasStep(dir)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onTogglePalette, onToggleDiffPanel, onToggleCanvas, onCanvasStep])
}
