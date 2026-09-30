/**
 * App settings: the auth token plus the display preferences built on it.
 *
 * The token is the one value still kept in localStorage — it is needed to
 * reach the server that stores everything else. The theme lives in the
 * server-side prefs store (src/lib/prefs.ts). Font size is a fixed default
 * so new defaults take effect without migration.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Settings } from '../types'
import { DEFAULT_THEME, isThemeId } from '../themes/registry'
import { setPref, usePref } from '../lib/prefs'

const STORAGE_KEY = 'codekin-settings'

/**
 * Stand-in token for hosted mode. The browser has no local server token
 * there — the connector authenticates to the local server on the machine —
 * but the app still needs a non-empty token to leave setup mode and to fill
 * the `auth` frame the connector answers locally.
 */
export const HOSTED_TOKEN_SENTINEL = 'hosted-relay'

const isHosted = import.meta.env.VITE_APP_MODE === 'hosted'

const FONT_SIZE = 16

function saveToken(token: string) {
  try {
    // Merge rather than overwrite: legacy fields (the theme) stay put until
    // the prefs migration has copied them to the server.
    const raw = localStorage.getItem(STORAGE_KEY)
    const saved = raw ? JSON.parse(raw) as Record<string, unknown> | null : null
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, token }))
  } catch { /* storage disabled */ }
}

function loadToken(): string {
  // In hosted mode the sentinel always wins: a token saved by a previous
  // local session on the same origin would not authenticate anything.
  if (isHosted) return HOSTED_TOKEN_SENTINEL
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const saved = raw ? JSON.parse(raw) as { token?: string } | null : null
    let token = saved?.token ?? ''

    // Check the URL for a token: `#token=` is what the CLI prints (a fragment
    // never reaches server or proxy logs); `?token=` is still accepted for
    // links printed by older versions.
    const url = new URL(window.location.href)
    const hashParams = new URLSearchParams(url.hash.slice(1))
    const urlToken = hashParams.get('token') || url.searchParams.get('token')
    if (urlToken) {
      token = urlToken
      // Persist immediately so subsequent loads pick it up
      saveToken(token)
      // Strip the token from the URL for security
      url.searchParams.delete('token')
      hashParams.delete('token')
      const hash = hashParams.toString()
      window.history.replaceState({}, '', url.pathname + url.search + (hash ? `#${hash}` : ''))
    }
    return token
  } catch {
    return ''
  }
}

// The token is shared by every useSettings() caller (App's prefs gate and
// the app itself), so saving it in Settings re-runs the gate.
let currentToken: string | null = null
const tokenListeners = new Set<() => void>()
function getToken(): string {
  if (currentToken === null) currentToken = loadToken()
  return currentToken
}
function setToken(token: string) {
  currentToken = token
  saveToken(token)
  for (const l of tokenListeners) l()
}
function subscribeToken(listener: () => void) {
  tokenListeners.add(listener)
  return () => { tokenListeners.delete(listener) }
}

/** Test helper: forget the cached token so the next render reloads it. */
export function resetTokenForTest(): void {
  currentToken = null
}

export function useSettings() {
  const token = useSyncExternalStore(subscribeToken, getToken)
  const storedTheme = usePref('theme')
  const theme = isThemeId(storedTheme) ? storedTheme : DEFAULT_THEME

  const settings = useMemo<Settings>(() => ({ token, fontSize: FONT_SIZE, theme }), [token, theme])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    if (patch.theme !== undefined) setPref('theme', patch.theme)
    if (patch.token !== undefined) setToken(patch.token)
  }, [])

  return { settings, updateSettings }
}
