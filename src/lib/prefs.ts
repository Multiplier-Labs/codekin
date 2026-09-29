/**
 * User preferences, stored on the server rather than in the browser.
 *
 * Everything the UI remembers between visits — theme, new-session defaults,
 * layout, starred docs, queued drafts — lives in one JSON blob behind
 * /api/settings/prefs, so it follows the user across browsers and devices.
 * The auth token and the hosted machine/workspace choice are the only things
 * still kept in localStorage: they are needed before any server is reachable.
 *
 * The blob is loaded once (see `loadPrefs`, awaited by App before it renders),
 * then read synchronously from an in-memory cache. Writes update the cache
 * immediately and are sent to the server in small debounced patches.
 *
 * On first load, values a previous version kept in localStorage are copied up
 * to the server and the old keys are removed. A server that predates the
 * endpoint gets a local fallback so preferences are not silently dropped.
 */

import { useSyncExternalStore } from 'react'
import type { CodingProvider, PermissionMode } from '../types'
import type { ThemeId } from '../themes/registry'
import { getPrefs, putPrefs } from './ccApi'

export interface Prefs {
  theme: ThemeId
  /** Start new sessions in a git worktree. */
  useWorktree: boolean
  /** Permission mode new sessions start in. */
  permissionMode: PermissionMode
  /** Coding provider new sessions start with. */
  provider: CodingProvider
  /** Last model used per provider, offered to the next session. */
  claudeModel: string
  codexModel: string
  opencodeModel: string
  /** Carry conversation context when switching a session's provider. */
  handoffCarryContext: boolean
  /** Starred doc paths, keyed by repo dir. */
  starredDocs: Record<string, string[]>
  /** Recently picked model IDs in the composer and the workflow picker. */
  recentModels: string[]
  workflowRecentModels: string[]
  /** Texts of messages queued behind a busy session, keyed by session ID. */
  tentativeQueues: Record<string, string[]>
  /** Session reopened on the next visit. */
  activeSessionId: string
  sidebarCollapsed: boolean
  sidebarWidth: number
  diffPanelWidth: number
  repoDrawerWidth: number
  /** Last repo drawer tab, keyed by repo dir. */
  repoDrawerTabs: Record<string, string>
}

export type PrefKey = keyof Prefs

/** Where preferences go when the server has no prefs endpoint (older server). */
const FALLBACK_KEY = 'codekin-prefs'
const FLUSH_DELAY_MS = 300

let cache: Partial<Prefs> = {}
let token = ''
let useLocalFallback = false
let pending: Record<string, unknown> = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read a preference from the cache. */
export function getPref<K extends PrefKey>(key: K): Prefs[K] | undefined {
  return cache[key]
}

/** Update a preference; `undefined` removes it. Persisted in the background. */
export function setPref<K extends PrefKey>(key: K, value: Prefs[K] | undefined): void {
  if (cache[key] === value) return
  const next: Partial<Prefs> = Object.fromEntries(Object.entries(cache).filter(([k]) => k !== key))
  cache = value === undefined ? next : { ...next, [key]: value }
  pending[key] = value ?? null
  notify()
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

/** Subscribe a component to one preference. */
export function usePref<K extends PrefKey>(key: K): Prefs[K] | undefined {
  return useSyncExternalStore(subscribe, () => cache[key])
}

/** Send queued changes now. Called on a timer and when the page is hidden. */
export function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const patch = pending
  pending = {}
  if (Object.keys(patch).length === 0) return
  if (useLocalFallback) {
    try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(cache)) } catch { /* quota or disabled storage */ }
    return
  }
  if (!token) return
  putPrefs(token, patch).catch(() => {
    // Keep the cache as-is; the next change retries with a fresh patch.
    // Re-queue so a transient failure doesn't lose this change.
    pending = { ...patch, ...pending }
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
}

// ---------------------------------------------------------------------------
// Legacy localStorage migration
// ---------------------------------------------------------------------------

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function positiveNumber(raw: string | null): number | undefined {
  const n = Number(raw)
  return raw !== null && Number.isFinite(n) && n > 0 ? n : undefined
}

function bool(raw: string | null): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined
}

/** Scalar legacy keys and how to decode them. */
const LEGACY_SCALARS: Array<[string, PrefKey, (raw: string | null) => unknown]> = [
  ['codekin-use-worktree', 'useWorktree', bool],
  ['claude-permission-mode', 'permissionMode', r => r ?? undefined],
  ['codekin-provider', 'provider', r => r ?? undefined],
  ['claude-model', 'claudeModel', r => r ?? undefined],
  ['codex-model', 'codexModel', r => r ?? undefined],
  ['opencode-model', 'opencodeModel', r => r ?? undefined],
  ['codekin.handoffCarryContext', 'handoffCarryContext', bool],
  ['codekin-starred-docs', 'starredDocs', parseJson],
  ['codekin.recentModels', 'recentModels', parseJson],
  ['codekin.workflowRecentModels', 'workflowRecentModels', parseJson],
  ['codekin-active-session', 'activeSessionId', r => r ?? undefined],
  ['codekin-left-sidebar-collapsed', 'sidebarCollapsed', bool],
  ['codekin-left-sidebar-width', 'sidebarWidth', positiveNumber],
  ['codekin-diff-panel-width', 'diffPanelWidth', positiveNumber],
  ['codekin-repo-drawer-width', 'repoDrawerWidth', positiveNumber],
]
const LEGACY_TENTATIVE_PREFIX = 'codekin-tentative-'
const LEGACY_DRAWER_TAB_PREFIX = 'codekin.repoDrawerTab:'
/** Holds the token (which stays) and the theme (which moves). */
const LEGACY_SETTINGS_KEY = 'codekin-settings'

/** Collect every legacy value still in localStorage, plus the keys it came from. */
function readLegacy(): { values: Partial<Prefs>; keys: string[] } {
  const values: Record<string, unknown> = {}
  const keys: string[] = []
  try {
    for (const [lsKey, pref, decode] of LEGACY_SCALARS) {
      const raw = localStorage.getItem(lsKey)
      if (raw === null) continue
      keys.push(lsKey)
      const v = decode(raw)
      if (v !== undefined) values[pref] = v
    }
    const queues: Record<string, string[]> = {}
    const tabs: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.startsWith(LEGACY_TENTATIVE_PREFIX)) {
        keys.push(k)
        const texts = parseJson(localStorage.getItem(k))
        if (Array.isArray(texts) && texts.length > 0) queues[k.slice(LEGACY_TENTATIVE_PREFIX.length)] = texts as string[]
      } else if (k.startsWith(LEGACY_DRAWER_TAB_PREFIX)) {
        keys.push(k)
        const tab = localStorage.getItem(k)
        if (tab) tabs[k.slice(LEGACY_DRAWER_TAB_PREFIX.length)] = tab
      }
    }
    if (Object.keys(queues).length > 0) values.tentativeQueues = queues
    if (Object.keys(tabs).length > 0) values.repoDrawerTabs = tabs
    const settings = parseJson(localStorage.getItem(LEGACY_SETTINGS_KEY)) as { theme?: unknown } | undefined
    if (settings && typeof settings.theme === 'string') values.theme = settings.theme
    const fallback = parseJson(localStorage.getItem(FALLBACK_KEY))
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      keys.push(FALLBACK_KEY)
      Object.assign(values, fallback)
    }
  } catch { /* storage disabled */ }
  return { values: values as Partial<Prefs>, keys }
}

function clearLegacy(keys: string[]) {
  try {
    for (const k of keys) localStorage.removeItem(k)
    // Keep the token in codekin-settings; drop the theme that moved.
    const settings = parseJson(localStorage.getItem(LEGACY_SETTINGS_KEY)) as Record<string, unknown> | undefined
    if (settings && ('theme' in settings || 'fontSize' in settings)) {
      localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ token: settings.token ?? '' }))
    }
  } catch { /* storage disabled */ }
}

/**
 * Load preferences for this server and migrate any legacy localStorage values.
 * Never rejects: on failure the app runs on defaults.
 */
export async function loadPrefs(authToken: string): Promise<void> {
  token = authToken
  useLocalFallback = false
  pending = {}
  const legacy = readLegacy()
  let server: Record<string, unknown> | null
  try {
    server = await getPrefs(authToken)
  } catch {
    // Unreachable or unauthorized: run on legacy values for this visit
    // without deleting them, so nothing is lost.
    cache = { ...legacy.values }
    notify()
    return
  }
  if (server === null) {
    // Older server without the prefs endpoint — keep preferences in this browser.
    useLocalFallback = true
    cache = { ...legacy.values }
    notify()
    return
  }
  // Server values win; legacy values only fill gaps.
  const migrated: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(legacy.values)) {
    if (!(k in server)) migrated[k] = v
  }
  cache = { ...(server as Partial<Prefs>), ...(migrated as Partial<Prefs>) }
  notify()
  if (legacy.keys.length === 0) return
  try {
    if (Object.keys(migrated).length > 0) await putPrefs(authToken, migrated)
    clearLegacy(legacy.keys)
  } catch { /* try again next load; values stay in localStorage */ }
}

/** Test helper: reset module state. */
export function resetPrefsForTest(initial: Partial<Prefs> = {}): void {
  cache = { ...initial }
  token = ''
  useLocalFallback = false
  pending = {}
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  notify()
}
