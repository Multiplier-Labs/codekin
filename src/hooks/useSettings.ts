/**
 * Persists user settings (auth token, font size) to localStorage.
 *
 * On load, restores the saved token but always uses the current default
 * font size so new defaults take effect without migration.
 */

import { useState, useCallback } from 'react'
import type { Settings } from '../types'

const STORAGE_KEY = 'codekin-settings'

const defaults: Settings = {
  token: '',
  fontSize: 16,
  theme: 'dark',
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const saved = JSON.parse(raw)
    // Only restore token and theme; fontSize always uses the current default
    return {
      ...defaults,
      token: saved.token ?? defaults.token,
      theme: saved.theme === 'light' ? 'light' : 'dark',
    }
  } catch {
    return defaults
  }
}

function save(settings: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(load)

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState(prev => {
      const next = { ...prev, ...patch }
      save(next)
      return next
    })
  }, [])

  return { settings, updateSettings }
}
