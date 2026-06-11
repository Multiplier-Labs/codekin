import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchCodexModels } from '../lib/ccApi'
import type { ModelOption, CodingProvider } from '../types'

interface UseCodexModelSyncOptions {
  token: string
  activeSessionProvider: CodingProvider
  currentModel: string | null
  setModel: (model: string) => void
  codexDisabled: boolean
}

/**
 * Manages Codex model list and connectivity state.
 * - Probes Codex availability on startup.
 * - Fetches models when switching to a Codex session.
 * - Auto-selects an appropriate default model when current selection is invalid.
 */
export function useCodexModelSync({
  token,
  activeSessionProvider,
  currentModel,
  setModel,
  codexDisabled,
}: UseCodexModelSyncOptions) {
  const [codexModels, setCodexModels] = useState<ModelOption[]>([])
  const [codexConnected, setCodexConnected] = useState<boolean | null>(null)
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  // Probe Codex availability on startup
  useEffect(() => {
    if (!token || codexDisabled) return
    fetchCodexModels(token).then(result => {
      setCodexConnected(result.models.length > 0)
    }).catch(() => { setCodexConnected(false) })
  }, [token, codexDisabled])

  // Fetch models when switching to a Codex session
  useEffect(() => {
    if (activeSessionProvider !== 'codex' || !token) return
    const currentIsValidCodex = currentModelRef.current && codexModels.some(m => m.id === currentModelRef.current)
    if (codexModels.length > 0 && currentIsValidCodex) return
    fetchCodexModels(token).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: m.id,
        label: m.name,
      }))
      setCodexModels(models)
      setCodexConnected(models.length > 0)
      const currentIsCodex = currentModelRef.current && models.some(m => m.id === currentModelRef.current)
      if (!currentIsCodex) {
        const savedModel = localStorage.getItem('codex-model')
        const savedIsValid = savedModel && models.some(m => m.id === savedModel)
        if (savedIsValid) {
          setModel(savedModel)
        } else {
          const defaultModel = result.models.find(m => m.isDefault)
          if (defaultModel) setModel(defaultModel.id)
          else if (models.length > 0) setModel(models[0].id)
        }
      }
    }).catch(() => { setCodexConnected(false) })
  }, [activeSessionProvider, token, codexModels.length, setModel])

  /** Re-fetch models to check connection (used when re-enabling Codex). */
  const reconnect = useCallback(() => {
    if (!token) return
    fetchCodexModels(token).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: m.id,
        label: m.name,
      }))
      setCodexModels(models)
      setCodexConnected(models.length > 0)
    }).catch(() => { setCodexConnected(false) })
  }, [token])

  return { codexModels, codexConnected, setCodexConnected, reconnect }
}
