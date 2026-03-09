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
    const saved = raw ? JSON.parse(raw) : null
    const base: Settings = {
      ...defaults,
      token: saved?.token ?? defaults.token,
      theme: saved?.theme === 'light' ? 'light' : 'dark',
    }

    // Check URL for ?token= parameter (e.g. shared invite links)
    const url = new URL(window.location.href)
    const urlToken = url.searchParams.get('token')
    if (urlToken) {
      base.token = urlToken
      // Persist immediately so subsequent loads pick it up
      localStorage.setItem(STORAGE_KEY, JSON.stringify(base))
      // Strip the token from the URL for security
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    }

    return base
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
