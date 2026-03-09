/**
 * HTTP + WebSocket client for the Codekin server API.
 *
 * All REST calls (including uploads) go through the /cc proxy (nginx → server on port 32352).
 */

import type { Session, WsServerMessage } from '../types'

/** Base path for the WebSocket server REST API (proxied by nginx). */
const BASE = '/cc'

/** Authelia login page — redirect here when session expires. */
const LOGIN_URL = '/authelia/login'

function headers(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/**
 * Redirect to Authelia login when the session has expired.
 * Uses a flag to prevent multiple concurrent redirects.
 */
let redirecting = false
export function redirectToLogin() {
  if (redirecting) return
  redirecting = true
  window.location.href = LOGIN_URL
}

/**
 * Check if a fetch response indicates an expired Authelia session.
 * Authelia may return a 401, or nginx may return a 302 redirect to the login page.
 * Also handles the case where the response is an HTML login page instead of JSON.
 */
function checkAuthResponse(res: Response): boolean {
  // Authelia redirects may come back as opaque redirects or HTML responses
  if (res.redirected && res.url.includes('/authelia')) return true
  // 502/503/504 = backend is down (e.g. during deploy restart), not an auth failure
  if (res.status >= 502 && res.status <= 504) return false
  const ct = res.headers.get('content-type') || ''
  // If the response is JSON, it came from our own API — not an auth proxy intercept
  if (ct.includes('application/json')) return false
  // Non-JSON 401/403 likely means Authelia intercepted the request
  if (res.status === 401 || res.status === 403) return true
  // HTML response when expecting JSON means the auth proxy intercepted the request
  if (res.ok && ct.includes('text/html')) return true
  return false
}

/**
 * Probe whether the Authelia session is still valid by hitting a lightweight endpoint.
 * Returns false if the session has expired.
 */
export async function checkAuthSession(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
      redirect: 'manual',
    })
    // If Authelia intercepts with a redirect or non-JSON response, session is expired.
    // A 401 from our own server (invalid token) is fine — means Authelia let us through.
    if (res.type === 'opaqueredirect') return false
    // 502/503/504 = backend is down (e.g. during deploy restart), not an auth failure
    if (res.status >= 502 && res.status <= 504) return true
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/html')) return false
    return true
  } catch {
    // Network error — don't treat as auth failure
    return true
  }
}

/** Wrapper around fetch that checks for expired Authelia sessions. */
async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = init ? await fetch(input, init) : await fetch(input)
  if (checkAuthResponse(res)) {
    redirectToLogin()
    throw new Error('Session expired')
  }
  return res
}

/** Validate an auth token against the server. Returns true if valid. */
export async function verifyToken(token: string): Promise<boolean> {
  const res = await authFetch(`${BASE}/auth-verify`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ token }),
  })
  if (!res.ok) return false
  const data = await res.json()
  return data.valid === true
}

/** Fetch all sessions from the server. */
export async function listSessions(token: string): Promise<Session[]> {
  const res = await authFetch(`${BASE}/api/sessions/list?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  const data = await res.json()
  return data.sessions ?? []
}

/** Create a new session. Returns the session ID and full session info. */
export async function createSession(
  token: string,
  name: string,
  workingDir: string,
): Promise<{ sessionId: string; session: Session }> {
  const res = await authFetch(`${BASE}/api/sessions/create`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ name, workingDir }),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
  return res.json()
}

/** Rename a session. */
export async function renameSession(token: string, sessionId: string, name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/sessions/${sessionId}/rename`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`)
}

/** Delete a session by ID. Kills any running Claude process. */
export async function deleteSession(token: string, sessionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/sessions/${sessionId}?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`)
}

/** Server health check. Returns active/total session counts. */
export async function getHealth(token: string): Promise<{ status: string; claudeSessions: number }> {
  const res = await authFetch(`${BASE}/api/health?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  return res.json()
}

/** Upload a file via the server. Returns the server-side file path. */
export async function uploadFile(token: string, file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const res = await authFetch(`${BASE}/api/upload?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json()
  return data.path
}

/** Auto-approval rules for a repo. */
export interface RepoApprovals {
  tools: string[]
  commands: string[]
  patterns: string[]
}

/** Fetch the auto-approval rules for a repo (by workingDir path). */
export async function getRepoApprovals(token: string, workingDir: string): Promise<RepoApprovals> {
  const params = new URLSearchParams({ token, path: workingDir })
  const res = await authFetch(`${BASE}/api/approvals?${params}`)
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`)
  return res.json()
}

/** Remove an auto-approval rule for a repo (by workingDir path). */
export async function removeRepoApproval(
  token: string,
  workingDir: string,
  opts: { tool?: string; command?: string },
): Promise<void> {
  const params = new URLSearchParams({ token, path: workingDir })
  const res = await authFetch(`${BASE}/api/approvals?${params}`, {
    method: 'DELETE',
    headers: headers(token),
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error(`Failed to remove approval: ${res.status}`)
}

/** Bulk remove multiple auto-approval rules in a single request. */
export async function bulkRemoveRepoApprovals(
  token: string,
  workingDir: string,
  items: Array<{ tool?: string; command?: string }>,
): Promise<void> {
  const params = new URLSearchParams({ token, path: workingDir })
  const res = await authFetch(`${BASE}/api/approvals?${params}`, {
    method: 'DELETE',
    headers: headers(token),
    body: JSON.stringify({ items }),
  })
  if (!res.ok) throw new Error(`Failed to bulk remove approvals: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Session archive
// ---------------------------------------------------------------------------

/** Archived session metadata returned by list queries. */
export interface ArchivedSessionInfo {
  id: string
  name: string
  workingDir: string
  groupDir: string | null
  source: string
  created: string
  archivedAt: string
  messageCount: number
}

/** Full archived session with chat history. */
export interface ArchivedSessionFull extends ArchivedSessionInfo {
  outputHistory: WsServerMessage[]
}

/** Fetch all archived sessions (metadata only). Optionally filtered by workingDir. */
export async function listArchivedSessions(token: string, workingDir?: string): Promise<ArchivedSessionInfo[]> {
  const params = new URLSearchParams({ token })
  if (workingDir) params.set('workingDir', workingDir)
  const res = await authFetch(`${BASE}/api/sessions/archived?${params}`)
  if (!res.ok) throw new Error(`Failed to list archived sessions: ${res.status}`)
  const data = await res.json()
  return data.sessions ?? []
}

/** Fetch a single archived session with full chat history. */
export async function getArchivedSession(token: string, sessionId: string): Promise<ArchivedSessionFull> {
  const res = await authFetch(`${BASE}/api/sessions/archived/${sessionId}?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Failed to get archived session: ${res.status}`)
  return res.json()
}

/** Delete an archived session permanently. */
export async function deleteArchivedSession(token: string, sessionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/sessions/archived/${sessionId}?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete archived session: ${res.status}`)
}

/** Get the session retention period in days. */
export async function getRetentionDays(token: string): Promise<number> {
  const res = await authFetch(`${BASE}/api/settings/retention?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Failed to get retention settings: ${res.status}`)
  const data = await res.json()
  return data.days
}

/** Set the session retention period in days. */
export async function setRetentionDays(token: string, days: number): Promise<number> {
  const res = await authFetch(`${BASE}/api/settings/retention?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ days }),
  })
  if (!res.ok) throw new Error(`Failed to update retention settings: ${res.status}`)
  const data = await res.json()
  return data.days
}

/** Supported AI provider identifiers for support actions. */
export type SupportProvider = 'auto' | 'groq' | 'openai' | 'gemini' | 'anthropic'

/** Get the preferred support provider and list of available providers. */
export async function getSupportProvider(token: string): Promise<{ preferred: SupportProvider; available: string[] }> {
  const res = await authFetch(`${BASE}/api/settings/support-provider?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`Failed to get support provider: ${res.status}`)
  return res.json()
}

/** Set the preferred support provider. */
export async function setSupportProvider(token: string, provider: SupportProvider): Promise<void> {
  const res = await authFetch(`${BASE}/api/settings/support-provider?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error(`Failed to set support provider: ${res.status}`)
}

/**
 * Build the WebSocket URL, auto-selecting wss: or ws: based on current page protocol.
 * Auth token is sent as a post-connect message (not in the URL) to avoid log exposure.
 */
export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/cc/`
}
