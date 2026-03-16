/**
 * Checks for newer Codekin versions on npm and caches the result.
 *
 * On server startup, fetches the latest published version from the npm registry.
 * The result is cached so that individual client connections can be notified
 * without repeated network calls.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

/** How long to cache the npm lookup result (6 hours). */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** npm registry endpoint for the package. */
const REGISTRY_URL = 'https://registry.npmjs.org/codekin/latest'

interface VersionState {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: number
}

const state: VersionState = {
  currentVersion: '',
  latestVersion: null,
  updateAvailable: false,
  checkedAt: 0,
}

/** Read the current version from package.json (once). */
function getCurrentVersion(): string {
  if (!state.currentVersion) {
    const pkgPath = join(import.meta.dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    state.currentVersion = pkg.version
  }
  return state.currentVersion
}

/** Simple semver comparison: returns true if a > b. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

/** Fetch the latest version from npm. Non-throwing — returns null on failure. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(REGISTRY_URL, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = await res.json() as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

/**
 * Check for updates (called once at server startup).
 * Logs the result and caches it for client notifications.
 */
export async function checkForUpdates(): Promise<void> {
  const current = getCurrentVersion()
  const latest = await fetchLatestVersion()
  state.checkedAt = Date.now()

  if (latest && isNewer(latest, current)) {
    state.latestVersion = latest
    state.updateAvailable = true
    console.log(`[update] Codekin ${latest} is available (current: ${current})`)
  } else {
    state.latestVersion = latest
    state.updateAvailable = false
    console.log(`[update] Codekin ${current} is up to date`)
  }
}

/**
 * Returns the update notification text if an update is available, or null.
 * Re-checks npm if the cache has expired.
 */
export async function getUpdateNotification(): Promise<string | null> {
  if (Date.now() - state.checkedAt > CACHE_TTL_MS) {
    await checkForUpdates()
  }
  if (state.updateAvailable && state.latestVersion) {
    return `Codekin v${state.latestVersion} is available (current: v${state.currentVersion}). Run "codekin upgrade" to update.`
  }
  return null
}
