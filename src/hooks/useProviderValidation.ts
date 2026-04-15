import { useEffect } from 'react'
import { CLAUDE_MODELS } from '../types'
import type { CodingProvider } from '../types'

/**
 * When the active session uses the Claude provider, ensures `currentModel`
 * is one of the known CLAUDE_MODELS. Falls back to the first model if not.
 */
export function useProviderValidation({
  activeSessionProvider,
  currentModel,
  setModel,
}: {
  activeSessionProvider: CodingProvider
  currentModel: string | null
  setModel: (model: string) => void
}) {
  useEffect(() => {
    if (activeSessionProvider !== 'claude') return
    if (!CLAUDE_MODELS.some(m => m.id === currentModel)) {
      setModel(CLAUDE_MODELS[0].id)
    }
  }, [activeSessionProvider, currentModel, setModel])
}
