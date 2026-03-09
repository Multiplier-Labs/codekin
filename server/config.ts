/**
 * Centralized configuration for the Codekin server.
 *
 * All hardcoded paths, ports, and settings are replaced with environment
 * variables that have sensible defaults for bare-metal (dev) and can be
 * overridden in Docker / production environments.
 */

import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync, realpathSync } from 'fs'

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Main server port (WebSocket + REST + uploads). */
export const PORT = parseInt(process.env.PORT || '32352', 10)

/** CORS allowed origin. Defaults to localhost dev server; must be set explicitly for production. */
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

// Warn at startup if production is using the default localhost CORS origin
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.error('[config] ERROR: CORS_ORIGIN is not set in production. Defaulting to localhost is insecure.')
  console.error('[config] Set CORS_ORIGIN to the production frontend origin (e.g. https://example.com).')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && CORS_ORIGIN.includes('localhost')) {
  console.warn('[config] WARNING: CORS_ORIGIN contains "localhost" in production mode. This is likely misconfigured.')
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Auth token for the server. Loaded from AUTH_TOKEN env var, or falls back
 * to reading from AUTH_TOKEN_FILE (legacy --auth-file behavior).
 */
function loadAuthToken(): string {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN

  // Legacy: read from file path (bare-metal deploy compat)
  const tokenFile = process.env.AUTH_TOKEN_FILE || ''
  if (tokenFile && existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf-8').trim()
  }
  return ''
}

export const AUTH_TOKEN = loadAuthToken()

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root directory for cloned repositories. Resolved via realpathSync to follow symlinks. */
const rawReposRoot = process.env.REPOS_ROOT || join(homedir(), 'repos')
export const REPOS_ROOT = existsSync(rawReposRoot)
  ? realpathSync(rawReposRoot)
  : rawReposRoot

/** Codekin data directory (sessions, approvals, workflows, etc.). */
export const DATA_DIR = process.env.DATA_DIR || join(homedir(), '.codekin')

/** Directory for uploaded screenshots / file attachments. */
export const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || join(DATA_DIR, 'screenshots')

/**
 * Path to the built frontend dist directory.
 * When set and the directory exists, the server serves the frontend via express.static,
 * removing the need for nginx inside a Docker container.
 * Bare-metal deploys can leave this unset and continue using nginx.
 */
export const FRONTEND_DIST = process.env.FRONTEND_DIST || ''

/** GitHub organizations for repo listing (comma-separated). Empty string disables org listing. */
export const GH_ORGS: string[] = (process.env.GH_ORG || '').split(',').map(s => s.trim()).filter(Boolean)
