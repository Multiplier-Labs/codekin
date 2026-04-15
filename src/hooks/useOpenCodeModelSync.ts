import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchOpenCodeModels } from '../lib/ccApi'
import type { ModelOption, CodingProvider } from '../types'

interface UseOpenCodeModelSyncOptions {
  token: string
  activeSessionProvider: CodingProvider
  activeOpenCodeWd: string | undefined
  currentModel: string | null
  setModel: (model: string) => void
  openCodeDisabled: boolean
}

/**
 * Manages OpenCode model list and connectivity state.
 * - Probes OpenCode availability on startup.
 * - Fetches models when switching to an OpenCode session or when the working directory changes.
 * - Auto-selects an appropriate default model when current selection is invalid.
 */
export function useOpenCodeModelSync({
  token,
  activeSessionProvider,
  activeOpenCodeWd,
  currentModel,
  setModel,
  openCodeDisabled,
}: UseOpenCodeModelSyncOptions) {
  const [openCodeModels, setOpenCodeModels] = useState<ModelOption[]>([])
  const [openCodeConnected, setOpenCodeConnected] = useState<boolean | null>(null)
  const openCodeModelsDirRef = useRef<string | undefined>(undefined)
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  // Probe OpenCode availability on startup
  useEffect(() => {
    if (!token || openCodeDisabled) return
    fetchOpenCodeModels(token).then(result => {
      setOpenCodeConnected(result.models.length > 0)
    }).catch(() => { setOpenCodeConnected(false) })
  }, [token, openCodeDisabled])

  // Fetch models when switching to an OpenCode session
  useEffect(() => {
    if (activeSessionProvider !== 'opencode' || !token) return
    const wdChanged = activeOpenCodeWd && activeOpenCodeWd !== openCodeModelsDirRef.current
    const currentIsValidOpenCode = currentModelRef.current && openCodeModels.some(m => m.id === currentModelRef.current)
    if (!wdChanged && openCodeModels.length > 0 && currentIsValidOpenCode) return
    const activeWd = activeOpenCodeWd
    fetchOpenCodeModels(token, activeWd).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: `${m.providerID}/${m.id}`,
        label: `${m.name} (${m.providerName})`,
      }))
      setOpenCodeModels(models)
      setOpenCodeConnected(models.length > 0)
      openCodeModelsDirRef.current = activeWd
      const currentIsOpenCode = currentModelRef.current && models.some(m => m.id === currentModelRef.current)
      if (!currentIsOpenCode) {
        const savedOcModel = localStorage.getItem('opencode-model')
        const savedIsValid = savedOcModel && models.some(m => m.id === savedOcModel)
        if (savedIsValid) {
          setModel(savedOcModel)
        } else {
          const [defaultProvider, defaultModelId] = Object.entries(result.defaults)[0] ?? []
          if (defaultProvider && defaultModelId) setModel(`${defaultProvider}/${defaultModelId}`)
          else if (models.length > 0) setModel(models[0].id)
        }
      }
    }).catch(() => { setOpenCodeConnected(false) })
  }, [activeSessionProvider, token, openCodeModels.length, setModel, activeOpenCodeWd])

  /** Re-fetch models to check connection (used when re-enabling OpenCode). */
  const reconnect = useCallback(() => {
    if (!token) return
    fetchOpenCodeModels(token).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: `${m.providerID}/${m.id}`,
        label: `${m.name} (${m.providerName})`,
      }))
      setOpenCodeModels(models)
      setOpenCodeConnected(models.length > 0)
    }).catch(() => { setOpenCodeConnected(false) })
  }, [token])

  return { openCodeModels, openCodeConnected, setOpenCodeConnected, reconnect }
}
