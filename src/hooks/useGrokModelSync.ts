import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchGrokModels } from '../lib/ccApi'
import type { ModelOption, CodingProvider } from '../types'
import { getPref } from '../lib/prefs'

interface UseGrokModelSyncOptions {
  token: string
  activeSessionProvider: CodingProvider
  currentModel: string | null
  setModel: (model: string) => void
  grokDisabled: boolean
}

/**
 * Manages Grok model list and connectivity state.
 * - Probes Grok availability on startup.
 * - Fetches models when switching to a Grok session.
 * - Auto-selects an appropriate default model when current selection is invalid.
 */
export function useGrokModelSync({
  token,
  activeSessionProvider,
  currentModel,
  setModel,
  grokDisabled,
}: UseGrokModelSyncOptions) {
  const [grokModels, setGrokModels] = useState<ModelOption[]>([])
  const [grokConnected, setGrokConnected] = useState<boolean | null>(null)
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  // Probe Grok availability on startup
  useEffect(() => {
    if (!token || grokDisabled) return
    fetchGrokModels(token).then(result => {
      setGrokConnected(result.models.length > 0)
    }).catch(() => { setGrokConnected(false) })
  }, [token, grokDisabled])

  // Fetch models when switching to a Grok session
  useEffect(() => {
    if (activeSessionProvider !== 'grok' || !token) return
    const currentIsValidGrok = currentModelRef.current && grokModels.some(m => m.id === currentModelRef.current)
    if (grokModels.length > 0 && currentIsValidGrok) return
    fetchGrokModels(token).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: m.id,
        label: m.name,
      }))
      setGrokModels(models)
      setGrokConnected(models.length > 0)
      const currentIsGrok = currentModelRef.current && models.some(m => m.id === currentModelRef.current)
      if (!currentIsGrok) {
        const savedModel = getPref('grokModel')
        const savedIsValid = savedModel && models.some(m => m.id === savedModel)
        if (savedIsValid) {
          setModel(savedModel)
        } else {
          const defaultModel = result.models.find(m => m.isDefault)
          if (defaultModel) setModel(defaultModel.id)
          else if (models.length > 0) setModel(models[0].id)
        }
      }
    }).catch(() => { setGrokConnected(false) })
  }, [activeSessionProvider, token, grokModels.length, setModel])

  /** Re-fetch models to check connection (used when re-enabling Grok). */
  const reconnect = useCallback(() => {
    if (!token) return
    fetchGrokModels(token).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: m.id,
        label: m.name,
      }))
      setGrokModels(models)
      setGrokConnected(models.length > 0)
    }).catch(() => { setGrokConnected(false) })
  }, [token])

  return { grokModels, grokConnected, setGrokConnected, reconnect }
}
