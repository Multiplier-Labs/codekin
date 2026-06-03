import { useEffect } from 'react'
import type { CodingProvider, ModelOption } from '../types'

/**
 * When the active session uses the Claude provider, ensures `currentModel`
 * is one of the known models. Falls back to the first model if not.
 */
export function useProviderValidation({
  activeSessionProvider,
  currentModel,
  setModel,
  claudeModels,
}: {
  activeSessionProvider: CodingProvider
  currentModel: string | null
  setModel: (model: string) => void
  claudeModels: ModelOption[]
}) {
  useEffect(() => {
    if (activeSessionProvider !== 'claude') return
    if (claudeModels.length === 0) return
    if (!claudeModels.some(m => m.id === currentModel)) {
      setModel(claudeModels[0].id)
    }
  }, [activeSessionProvider, currentModel, setModel, claudeModels])
}
