/**
 * HTTP + WebSocket client for the Codekin server API.
 *
 * All calls go through the active transport (src/lib/transport), which in
 * local mode maps them onto the /cc proxy (nginx → server on port 32352).
 * This module stays the single facade components and hooks import from.
 */

import type { Session, WsServerMessage, CodingProvider } from '../types'
import { transport } from './transport'
import { enableRelayWebhook, fetchRelayWebhook } from './relayWebhook'

/**
 * Type-safe wrapper around Response.json().
 * Centralises the single unavoidable `any` → `T` assertion so call-sites stay clean.
 */
async function jsonBody<T>(res: Response): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return await res.json()
}

/**
 * Extract a JSON error body from a failed response, falling back to a default message.
 */
async function errorBody(res: Response, fallback: string): Promise<{ error?: string }> {
  return await jsonBody<{ error?: string }>(res).catch(() => ({ error: fallback }))
}

/** Build standard JSON + Bearer auth headers for REST calls. */
function headers(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/** Redirect to the hosting environment's login flow when the session has expired. */
export function redirectToLogin() {
  transport.redirectToLogin()
}

/**
 * Probe whether the hosting environment's auth session (Authelia in local
 * mode) is still valid. Returns false if the session has expired.
 */
export function checkAuthSession(): Promise<boolean> {
  return transport.checkAuthSession()
}

/** Validate an auth token against the server. Returns true if valid. */
export async function verifyToken(token: string): Promise<boolean> {
  const res = await transport.authFetch(`/auth-verify`, {
    method: 'POST',
    headers: headers(token),
  })
  if (!res.ok) return false
  const data = await jsonBody<{ valid?: boolean }>(res)
  return data.valid === true
}

/** Fetch all sessions from the server. */
export async function listSessions(token: string): Promise<Session[]> {
  const res = await transport.authFetch(`/api/sessions/list`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  const data = await jsonBody<{ sessions?: Session[] }>(res)
  return data.sessions ?? []
}

/** Create a new session. Returns the session ID and full session info. */
export async function createSession(
  token: string,
  name: string,
  workingDir: string,
): Promise<{ sessionId: string; session: Session }> {
  const res = await transport.authFetch(`/api/sessions/create`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ name, workingDir }),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
  return jsonBody<{ sessionId: string; session: Session }>(res)
}

/** Rename a session. */
export async function renameSession(token: string, sessionId: string, name: string): Promise<void> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}/rename`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`)
}

/** Delete a session by ID. Kills any running Claude process. */
export async function deleteSession(token: string, sessionId: string): Promise<void> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`)
}

/** List archived sessions — resumable, with their worktrees kept. */
export async function listArchivedLiveSessions(token: string): Promise<Session[]> {
  const res = await transport.authFetch(`/api/sessions/list?archived=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to list archived sessions: ${res.status}`)
  const data = await jsonBody<{ sessions?: Session[] }>(res)
  return data.sessions ?? []
}

/** Archive a session: stop it and hide it, keeping its worktree and branch. */
export async function archiveSession(token: string, sessionId: string): Promise<void> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}/archive`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to archive session: ${res.status}`)
}

/** Return an archived session to the active list. */
export async function resumeSession(token: string, sessionId: string): Promise<void> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to resume session: ${res.status}`)
}

/** What removing an archived session's working files would affect. */
export interface WorktreeRemovalPreflight {
  worktreePath: string | null
  branch?: string
  exists: boolean
  modified: string[]
  untracked: string[]
  uniqueCommits: number | null
  referencedBy: string[]
  safe: boolean
  blockers: string[]
}

export async function getRemovalPreflight(token: string, sessionId: string): Promise<WorktreeRemovalPreflight> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}/removal-preflight`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to check working files: ${res.status}`)
  return jsonBody<WorktreeRemovalPreflight>(res)
}

/** Remove an archived session's working files. The server re-checks and refuses unsafe removals. */
export async function removeSessionWorktree(token: string, sessionId: string): Promise<{ removed: boolean; error?: string }> {
  const res = await transport.authFetch(`/api/sessions/${sessionId}/remove-worktree`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) return { removed: true }
  const body = await jsonBody<{ error?: string }>(res).catch(() => ({ error: undefined }))
  return { removed: false, error: body.error ?? `Failed to remove working files: ${res.status}` }
}

/** Read Joe's saved harness without starting an agent process. */
export async function getOrchestratorStatus(token: string): Promise<{ provider: CodingProvider | null; agentName?: string }> {
  const res = await transport.authFetch('/api/orchestrator/status', { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to load orchestrator: ${res.status}`)
  return jsonBody<{ provider: CodingProvider | null; agentName?: string }>(res)
}

/** Ensure the orchestrator session is running and return its session ID. */
export async function startOrchestrator(token: string, provider?: CodingProvider): Promise<{ sessionId: string; status: string; agentName?: string }> {
  const res = await transport.authFetch(`/api/orchestrator/start`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(provider ? { provider } : {}),
  })
  if (!res.ok) throw new Error(`Failed to start orchestrator: ${res.status}`)
  return jsonBody<{ sessionId: string; status: string; agentName?: string }>(res)
}

/** Upload a file via the server. Returns the server-side file path. */
export async function uploadFile(token: string, file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const res = await transport.authFetch(`/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await jsonBody<{ path: string }>(res)
  return data.path
}

/**
 * Upload files and build a message string with attached file paths.
 * Shared by handleSendWithFiles and handleExecuteTentative to eliminate
 * duplicated upload + fileLine construction logic.
 */
export async function uploadAndBuildMessage(
  token: string,
  files: File[],
  text: string,
): Promise<string> {
  const paths = await Promise.all(files.map(f => uploadFile(token, f)))
  const fileLine = `[Attached files: ${paths.join(', ')}]`
  return text.trim() ? `${fileLine}\n${text}` : fileLine
}

/** Auto-approval rules for a repo. */
export interface RepoApprovals {
  tools: string[]
  commands: string[]
  patterns: string[]
}

/** Fetch the auto-approval rules for a repo (by workingDir path). */
export async function getRepoApprovals(token: string, workingDir: string): Promise<RepoApprovals> {
  const params = new URLSearchParams({ path: workingDir })
  const res = await transport.authFetch(`/api/approvals?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`)
  return jsonBody<RepoApprovals>(res)
}

/** One repo's rules, as returned by the machine-wide listing. */
export interface RepoApprovalsEntry extends RepoApprovals {
  workingDir: string
}

/**
 * Every repo that has auto-approval rules, in one request. Servers that
 * predate `/api/approvals/all` answer 404; for those, fall back to asking
 * per repo, a few at a time — a burst of hundreds of requests trips the
 * hosted relay's frame limit and drops the whole connection.
 */
export async function getAllRepoApprovals(token: string, workingDirs: string[]): Promise<RepoApprovalsEntry[]> {
  const res = await transport.authFetch('/api/approvals/all', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) return (await jsonBody<{ repos: RepoApprovalsEntry[] }>(res)).repos
  if (res.status !== 404) throw new Error(`Failed to fetch approvals: ${res.status}`)

  const CONCURRENCY = 4
  const results: RepoApprovalsEntry[] = []
  let next = 0
  async function worker() {
    while (next < workingDirs.length) {
      const workingDir = workingDirs[next++]
      try {
        const a = await getRepoApprovals(token, workingDir)
        if (a.tools.length + a.commands.length + a.patterns.length > 0) results.push({ workingDir, ...a })
      } catch { /* one unreadable repo should not hide the rest */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, workingDirs.length) }, worker))
  return results.sort((a, b) => a.workingDir.localeCompare(b.workingDir))
}

/** Remove an auto-approval rule for a repo (by workingDir path). */
export async function removeRepoApproval(
  token: string,
  workingDir: string,
  opts: { tool?: string; command?: string },
): Promise<void> {
  const params = new URLSearchParams({ path: workingDir })
  const res = await transport.authFetch(`/api/approvals?${params}`, {
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
  const params = new URLSearchParams({ path: workingDir })
  const res = await transport.authFetch(`/api/approvals?${params}`, {
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
  const params = new URLSearchParams()
  if (workingDir) params.set('workingDir', workingDir)
  const qs = params.toString()
  const res = await transport.authFetch(`/api/sessions/archived${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to list archived sessions: ${res.status}`)
  const data = await jsonBody<{ sessions?: ArchivedSessionInfo[] }>(res)
  return data.sessions ?? []
}

/** Fetch a single archived session with full chat history. */
export async function getArchivedSession(token: string, sessionId: string): Promise<ArchivedSessionFull> {
  const res = await transport.authFetch(`/api/sessions/archived/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get archived session: ${res.status}`)
  return jsonBody<ArchivedSessionFull>(res)
}

/** Delete an archived session permanently. */
export async function deleteArchivedSession(token: string, sessionId: string): Promise<void> {
  const res = await transport.authFetch(`/api/sessions/archived/${sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to delete archived session: ${res.status}`)
}

/** Get the session retention period in days. */
export async function getRetentionDays(token: string): Promise<number> {
  const res = await transport.authFetch(`/api/settings/retention`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get retention settings: ${res.status}`)
  const data = await jsonBody<{ days: number }>(res)
  return data.days
}

/** Set the session retention period in days. */
export async function setRetentionDays(token: string, days: number): Promise<number> {
  const res = await transport.authFetch(`/api/settings/retention`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ days }),
  })
  if (!res.ok) throw new Error(`Failed to update retention settings: ${res.status}`)
  const data = await jsonBody<{ days: number }>(res)
  return data.days
}

/** Get the configured repos path (empty string means server default). */
export async function getReposPath(token: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/repos-path`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get repos path: ${res.status}`)
  const data = await jsonBody<{ path: string }>(res)
  return data.path
}

/** Set the repos path. Empty string resets to server default. */
export async function setReposPath(token: string, path: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/repos-path`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Failed to save repos path')
    throw new Error(data.error ?? `Failed to set repos path: ${res.status}`)
  }
  const data = await jsonBody<{ path: string }>(res)
  return data.path
}

/** Get the queue messages setting. */
export async function getQueueMessages(token: string): Promise<boolean> {
  const res = await transport.authFetch(`/api/settings/queue-messages`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get queue messages setting: ${res.status}`)
  const data = await jsonBody<{ enabled: boolean }>(res)
  return data.enabled
}

/** Set the queue messages setting. */
export async function setQueueMessages(token: string, enabled: boolean): Promise<boolean> {
  const res = await transport.authFetch(`/api/settings/queue-messages`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) throw new Error(`Failed to update queue messages setting: ${res.status}`)
  const data = await jsonBody<{ enabled: boolean }>(res)
  return data.enabled
}

/**
 * Get the UI preferences blob. Resolves to null when the server predates the
 * endpoint (404), so the caller can fall back instead of treating it as empty.
 */
export async function getPrefs(token: string): Promise<Record<string, unknown> | null> {
  const res = await transport.authFetch(`/api/settings/prefs`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to get preferences: ${res.status}`)
  const data = await jsonBody<{ prefs: Record<string, unknown> }>(res)
  return data.prefs
}

/** Merge a partial update into the UI preferences; null values remove keys. */
export async function putPrefs(token: string, patch: Record<string, unknown>): Promise<void> {
  const res = await transport.authFetch(`/api/settings/prefs`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ patch }),
  })
  if (!res.ok) throw new Error(`Failed to save preferences: ${res.status}`)
}

/** Get the worktree branch prefix setting. */
export async function getWorktreePrefix(token: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/worktree-prefix`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get worktree prefix: ${res.status}`)
  const data = await jsonBody<{ prefix: string }>(res)
  return data.prefix
}

/** Set the worktree branch prefix. */
export async function setWorktreePrefix(token: string, prefix: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/worktree-prefix`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ prefix }),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Failed to save worktree prefix')
    throw new Error(data.error ?? `Failed to set worktree prefix: ${res.status}`)
  }
  const data = await jsonBody<{ prefix: string }>(res)
  return data.prefix
}

/** Get the agent display name. */
export async function getAgentName(token: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/agent-name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get agent name: ${res.status}`)
  const data = await jsonBody<{ name: string }>(res)
  return data.name
}

/** Set the agent display name. */
export async function setAgentName(token: string, name: string): Promise<string> {
  const res = await transport.authFetch(`/api/settings/agent-name`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Failed to save agent name')
    throw new Error(data.error ?? `Failed to set agent name: ${res.status}`)
  }
  const data = await jsonBody<{ name: string }>(res)
  return data.name
}

/** Browse directories at a given path (for folder picker). */
export async function browseDirs(token: string, path?: string): Promise<{ path: string; dirs: string[] }> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await transport.authFetch(`/api/browse-dirs${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Failed to browse directory')
    throw new Error(data.error ?? `Failed to browse: ${res.status}`)
  }
  return jsonBody<{ path: string; dirs: string[] }>(res)
}

let nativeFolderPickerAvailable: Promise<boolean> | null = null

/**
 * Whether the server can open the native macOS folder dialog for this browser
 * (macOS server, same machine, no proxy). Cached for the page's lifetime; any
 * failure — the hosted relay, an older server — counts as unavailable.
 */
export function getNativeFolderPickerAvailable(token: string): Promise<boolean> {
  nativeFolderPickerAvailable ??= transport.authFetch(`/api/native/folder-picker`, {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(async res => {
      // A stale token is not an answer — ask again next time.
      if (res.status === 401) nativeFolderPickerAvailable = null
      return res.ok && (await jsonBody<{ available?: boolean }>(res)).available === true
    })
    .catch(() => {
      nativeFolderPickerAvailable = null
      return false
    })
  return nativeFolderPickerAvailable
}

/** Test hook: forget the cached availability. */
export function resetNativeFolderPickerCache(): void {
  nativeFolderPickerAvailable = null
}

/** Open the native macOS folder dialog; resolves with the chosen path, or null if cancelled. */
export async function pickFolderNative(token: string, defaultPath?: string): Promise<string | null> {
  const res = await transport.authFetch(`/api/native/pick-folder`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(defaultPath ? { defaultPath } : {}),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Failed to open folder dialog')
    throw new Error(data.error ?? `Failed to open folder dialog: ${res.status}`)
  }
  const data = await jsonBody<{ path?: string; cancelled?: boolean }>(res)
  return data.path ?? null
}

/** Webhook configuration (public subset, no secret). */
export interface WebhookConfigInfo {
  enabled: boolean
  maxConcurrentSessions: number
  logLinesToInclude: number
}

/** Fetch the webhook configuration from the server. */
export async function getWebhookConfig(token: string): Promise<WebhookConfigInfo> {
  const res = await transport.authFetch(`/api/webhooks/config`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get webhook config: ${res.status}`)
  const data = await jsonBody<{ config: WebhookConfigInfo }>(res)
  return data.config
}

/** Fetch recent webhook events. */
export async function getWebhookEvents(token: string): Promise<Array<{ id: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; receivedAt: string }>> {
  const res = await transport.authFetch(`/api/webhooks/events`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to get webhook events: ${res.status}`)
  type Event = { id: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; receivedAt: string }
  const data = await jsonBody<{ events?: Event[] }>(res)
  return data.events ?? []
}

/**
 * Build the WebSocket URL, auto-selecting wss: or ws: based on current page protocol.
 * Auth token is sent as a post-connect message (not in the URL) to avoid log exposure.
 */
export function wsUrl(): string {
  return transport.wsUrl()
}

/** Open the session-stream WebSocket (caller performs the `auth` handshake). */
export function openSocket(): WebSocket {
  return transport.openSocket()
}

/**
 * Browser-facing URL of the machine's own GitHub webhook receiver. Only
 * meaningful when talking to the machine directly; through a relay, GitHub
 * posts to the relay's receiver instead (resolveWebhookEndpointUrl).
 */
export function webhookEndpointUrl(): string {
  return transport.externalUrl('/api/webhooks/github')
}

/** The machine's id on the relay in hosted mode; null when talking to it directly. */
export function relayMachineId(): string | null {
  return transport.relayMachineId ?? null
}

/**
 * The URL GitHub should post to for this machine. Directly: the machine's own
 * receiver. Through a relay: the relay's receiver for this machine, turned on
 * if it is off. An existing receiver is never rotated here, since that would
 * break webhooks already pointing at it.
 */
export async function resolveWebhookEndpointUrl(): Promise<string> {
  const machineId = relayMachineId()
  if (!machineId) return webhookEndpointUrl()
  const current = await fetchRelayWebhook(machineId)
  if (current.url) return current.url
  if (current.enabled) {
    throw new Error("This machine's webhook URL can't be shown. Open Settings → This machine → Webhooks and choose New URL.")
  }
  const created = await enableRelayWebhook(machineId)
  if (!created.url) throw new Error('The relay did not return a webhook URL.')
  return created.url
}

/**
 * Clone a GitHub repo on the server. Resolves to the checkout's path — which
 * may be an existing checkout elsewhere under the repos root rather than a
 * fresh clone — or null if the server didn't say. Throws with the server's
 * error message on failure.
 */
export async function cloneRepo(token: string | undefined, owner: string, name: string): Promise<string | null> {
  const cloneHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) cloneHeaders['Authorization'] = `Bearer ${token}`
  const res = await transport.fetch('/api/clone', {
    method: 'POST',
    headers: cloneHeaders,
    body: JSON.stringify({ owner, name }),
  })
  if (!res.ok) {
    const data = await jsonBody<{ error?: string }>(res)
    throw new Error(data.error || 'Clone failed')
  }
  const data = await jsonBody<{ path?: unknown }>(res).catch(() => ({ path: undefined }))
  return typeof data.path === 'string' && data.path ? data.path : null
}

/** Fetch orchestrator dashboard stats. Returns null on any failure — stats are optional. */
export async function getOrchestratorDashboard<T>(token: string): Promise<T | null> {
  try {
    const res = await transport.fetch('/api/orchestrator/dashboard', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await jsonBody<{ stats: T }>(res)
    return data.stats
  } catch {
    return null
  }
}

/** Fetch available models from the OpenCode server. */
export async function fetchOpenCodeModels(
  token: string,
  workingDir?: string,
): Promise<{
  models: Array<{ id: string; name: string; providerID: string; providerName: string }>
  defaults: Record<string, string>
}> {
  const params = workingDir ? `?workingDir=${encodeURIComponent(workingDir)}` : ''
  const res = await transport.fetch(`/api/opencode/models${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { models: [], defaults: {} }
  return jsonBody<{
    models: Array<{ id: string; name: string; providerID: string; providerName: string }>
    defaults: Record<string, string>
  }>(res)
}

/** Fetch available models from the Codex CLI (via short-lived app-server). */
export async function fetchCodexModels(
  token: string,
): Promise<{
  models: Array<{ id: string; name: string; description?: string; isDefault?: boolean; efforts?: { id: string; description?: string }[]; defaultEffort?: string }>
}> {
  const res = await transport.fetch(`/api/codex/models`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { models: [] }
  return jsonBody<{
    models: Array<{ id: string; name: string; description?: string; isDefault?: boolean }>
  }>(res)
}

/** Fetch available models from the Grok Build CLI (via a short-lived ACP handshake). */
export async function fetchGrokModels(
  token: string,
): Promise<{
  models: Array<{ id: string; name: string; description?: string; isDefault?: boolean }>
}> {
  const res = await transport.fetch(`/api/grok/models`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return { models: [] }
  return jsonBody<{
    models: Array<{ id: string; name: string; description?: string; isDefault?: boolean }>
  }>(res)
}

/** Fetch the OpenCode command list (slash commands / skills / MCP prompts). */
export async function fetchOpenCodeCommands(
  token: string,
  workingDir?: string,
): Promise<Array<{ name: string; description?: string; source?: 'command' | 'mcp' | 'skill' }>> {
  const params = workingDir ? `?workingDir=${encodeURIComponent(workingDir)}` : ''
  const res = await transport.fetch(`/api/opencode/commands${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return []
  const data = await jsonBody<{ commands?: Array<{ name: string; description?: string; source?: 'command' | 'mcp' | 'skill' }> }>(res)
  return data.commands ?? []
}

/** Fetch available Claude models from the Anthropic API (via server proxy). */
export async function fetchClaudeModels(
  token: string,
): Promise<Array<{ id: string; label: string }>> {
  const res = await transport.fetch(`/api/claude/models`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return []
  const data = await jsonBody<{ models: Array<{ id: string; label: string }> }>(res)
  return data.models ?? []
}

// ---------------------------------------------------------------------------
// Integration health checks & setup
// ---------------------------------------------------------------------------

/** Health check detail for a single check. */
export interface HealthCheckDetail {
  ok: boolean
  message: string
}

/** Result from the integration health check endpoint. */
export interface HealthCheckResult {
  overall: 'healthy' | 'degraded' | 'broken' | 'unconfigured'
  checks: {
    ghCli: HealthCheckDetail
    config: HealthCheckDetail & { details?: { enabled: boolean; secretSet: boolean } }
    webhook: HealthCheckDetail & { details?: { id: number; active: boolean; events: string[]; url: string } }
    deliveries: HealthCheckDetail & { details?: { recent: Array<{ id: number; status: string; statusCode: number; deliveredAt: string; event: string }> } }
  }
}

/** Run the integration health check for a specific repo. */
export async function getIntegrationHealth(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<HealthCheckResult> {
  const params = new URLSearchParams({ repo, webhookUrl })
  const res = await transport.authFetch(`/api/integrations/github/pr-review/health?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  return jsonBody<HealthCheckResult>(res)
}

/** Preview for webhook setup (what would be created/changed). */
export interface SetupPreview {
  action: 'create' | 'update' | 'none'
  existing?: { id: number; active: boolean; events: string[]; config: { url: string } }
  proposed: { url: string; events: string[]; active: boolean }
  changes?: string[]
}

/** Preview what the webhook setup would do. */
export async function previewWebhookSetup(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ preview: SetupPreview; secretGenerated: boolean }> {
  const res = await transport.authFetch(`/api/integrations/github/pr-review/setup`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ repo, webhookUrl, dryRun: true }),
  })
  if (!res.ok) throw new Error(`Setup preview failed: ${res.status}`)
  return jsonBody<{ preview: SetupPreview; secretGenerated: boolean }>(res)
}

/** Apply webhook setup (create or update webhook on GitHub). */
export async function applyWebhookSetup(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ preview: SetupPreview; secretGenerated: boolean; webhook?: unknown }> {
  const res = await transport.authFetch(`/api/integrations/github/pr-review/setup`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ repo, webhookUrl }),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Setup failed')
    throw new Error(data.error ?? `Setup failed: ${res.status}`)
  }
  return jsonBody<{ preview: SetupPreview; secretGenerated: boolean; webhook?: unknown }>(res)
}

/** Send a test ping to the webhook and check delivery. */
export async function testWebhookDelivery(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ success: boolean; message: string; delivery?: { id: number; statusCode: number; event: string } }> {
  const res = await transport.authFetch(`/api/integrations/github/pr-review/test`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ repo, webhookUrl }),
  })
  if (!res.ok) {
    const data = await errorBody(res, 'Test failed')
    throw new Error(data.error ?? `Test failed: ${res.status}`)
  }
  return jsonBody<{ success: boolean; message: string; delivery?: { id: number; statusCode: number; event: string } }>(res)
}

// ---------------------------------------------------------------------------
// Remote access: pairing this machine with a hosted relay (desktop plan D2).
// Local only: the relay connector never proxies /api/relay/*.
// ---------------------------------------------------------------------------

/** The embedded relay connector's state (GET /api/relay/status). */
export interface RelayStatus {
  paired: boolean
  managed: boolean
  state: 'disabled' | 'unpaired' | 'secret_unavailable' | 'unmanaged' | 'connecting' | 'connected' | 'update_required' | 'devices_unconfirmed' | 'disconnected' | 'replaced' | 'auth_failed' | 'stopped'
  machineId: string | null
  relayUrl: string | null
  detail?: string
}

/** An in-progress or finished pairing (GET/POST/DELETE /api/relay/pair). */
export type RelayPairingState =
  | { state: 'idle' }
  | { state: 'pending'; relayUrl: string; verificationUrl: string; userCode: string; expiresAt: number | null }
  | { state: 'complete'; relayUrl: string; machineId: string; ownerLogin: string | null }
  | { state: 'denied' | 'expired' | 'failed'; relayUrl: string; detail?: string }

export async function getRelayStatus(token: string): Promise<RelayStatus> {
  const res = await transport.authFetch('/api/relay/status', { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get relay status: ${res.status}`)
  return jsonBody<RelayStatus>(res)
}

export async function getRelayPairing(token: string): Promise<RelayPairingState> {
  const res = await transport.authFetch('/api/relay/pair', { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get pairing state: ${res.status}`)
  return jsonBody<RelayPairingState>(res)
}

/** Start pairing; resolves with the code to approve. Rejects with the server's message. */
export async function startRelayPairing(token: string, relayUrl?: string): Promise<RelayPairingState> {
  const res = await transport.authFetch('/api/relay/pair', {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(relayUrl ? { relayUrl } : {}),
  })
  if (!res.ok) {
    const body = await jsonBody<{ message?: string; error?: string }>(res).catch(() => ({ message: undefined, error: undefined }))
    throw new Error(body.message ?? body.error ?? `Pairing failed: ${res.status}`)
  }
  return jsonBody<RelayPairingState>(res)
}

export async function cancelRelayPairing(token: string): Promise<RelayPairingState> {
  const res = await transport.authFetch('/api/relay/pair', { method: 'DELETE', headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to cancel pairing: ${res.status}`)
  return jsonBody<RelayPairingState>(res)
}

/** Remove this machine's local relay credential. */
export async function unpairRelay(token: string): Promise<{ removed: boolean }> {
  const res = await transport.authFetch('/api/relay/unpair', { method: 'POST', headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to unpair: ${res.status}`)
  return jsonBody<{ removed: boolean }>(res)
}

// ---------------------------------------------------------------------------
// Devices that can control this machine through the relay (signed-intents
// spec §4.3, §5.5). Local only, like the rest of /api/relay/*.
// ---------------------------------------------------------------------------

export interface RelayDevice {
  keyId: string
  kind: 'browser' | 'passkey'
  userId: string
  label: string
  addedAt: string
  /** `local` (confirmed on this machine) or `passkey:<keyId>`. */
  addedBy: string
  lastUsedAt?: string
}

/** GET /api/relay/devices */
export interface RelayDevices {
  paired: boolean
  machineId: string | null
  identity: { keyId: string; createdAt: string } | null
  devices: {
    machineId: string
    ownerUserId: string | null
    policy: 'off' | 'warn' | 'required'
    /** "Only allow devices confirmed on this computer": passkeys may not add browsers. */
    localConfirmationOnly: boolean
    credentials: RelayDevice[]
    /** Browsers waiting for their code to be typed here. The code is never included. */
    pending: Array<{ enrolId: string; userId: string; label: string; createdAt: string; expiresAt: string }>
    pendingCount: number
    /** Approved here in the last hour: the code to type in each browser to finish. */
    approved: Array<{ enrolId: string; label: string; confirmCode: string; approvedAt: string }>
  } | null
  error?: string
}

export async function getRelayDevices(token: string): Promise<RelayDevices> {
  const res = await transport.authFetch('/api/relay/devices', { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to get devices: ${res.status}`)
  return jsonBody<RelayDevices>(res)
}

/** Confirm the browser showing `code`. Rejects with the server's message (e.g. no such code). */
/**
 * Confirm a browser on this computer: with the 8-character code it shows,
 * or its trust command pasted whole. `confirmCode` is null when a trust
 * command did it (the browser finishes by itself); `waiting` when no browser
 * has asked with that command yet.
 */
export async function approveRelayDevice(token: string, code: string): Promise<
  | { keyId: string; label: string; confirmCode: string | null; policyRaised?: boolean; waiting?: undefined }
  | { waiting: { expiresAt: string } }
> {
  const res = await transport.authFetch('/api/relay/devices/approve', {
    method: 'POST', headers: headers(token), body: JSON.stringify({ code }),
  })
  const body = await jsonBody<{
    added?: { keyId: string; label: string; confirmCode: string | null; policyRaised?: boolean }
    waiting?: { expiresAt: string }
    message?: string
  }>(res).catch(() => ({ added: undefined, waiting: undefined, message: undefined }))
  if (res.ok && body.waiting) return { waiting: body.waiting }
  if (!res.ok || !body.added) throw new Error(body.message ?? `Failed to confirm the browser: ${res.status}`)
  return body.added
}

/**
 * What this computer accepts through the relay (signed-intents spec §6.8).
 * Only here, on the computer itself, can it be lowered.
 */
export async function setRelayDevicePolicy(token: string, policy: 'off' | 'warn' | 'required'): Promise<void> {
  const res = await transport.authFetch('/api/relay/devices/policy', {
    method: 'PUT', headers: headers(token), body: JSON.stringify({ policy }),
  })
  if (!res.ok) {
    const body = await jsonBody<{ message?: string; error?: string }>(res).catch(() => ({ message: undefined, error: undefined }))
    throw new Error(body.message ?? body.error ?? `Failed to change the policy: ${res.status}`)
  }
}

/** Whether an enrolled passkey may add a browser without a code typed here. */
export async function setRelayLocalConfirmationOnly(token: string, value: boolean): Promise<void> {
  const res = await transport.authFetch('/api/relay/devices/settings', {
    method: 'PUT', headers: headers(token), body: JSON.stringify({ localConfirmationOnly: value }),
  })
  if (!res.ok) throw new Error(`Failed to change the setting: ${res.status}`)
}

/** Turn down a browser waiting to be confirmed. */
export async function rejectRelayEnrolment(token: string, enrolId: string): Promise<void> {
  const res = await transport.authFetch(`/api/relay/devices/pending/${encodeURIComponent(enrolId)}`, { method: 'DELETE', headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to turn the request down: ${res.status}`)
}

/** Remove a device from this machine's list. Rejects with the server's message. */
export async function revokeRelayDevice(token: string, keyId: string): Promise<void> {
  const res = await transport.authFetch(`/api/relay/devices/${encodeURIComponent(keyId)}`, { method: 'DELETE', headers: headers(token) })
  if (!res.ok) {
    const body = await jsonBody<{ message?: string }>(res).catch(() => ({ message: undefined }))
    throw new Error(body.message ?? `Failed to remove device: ${res.status}`)
  }
}

/** One line of the machine's intent log (GET /api/relay/intents). */
export interface RelayIntentEntry {
  seq: number
  at: string
  verdict: 'accepted' | 'rejected' | 'unsigned'
  reason?: string
  forwarded: boolean
  action: string
  sessionId: string | null
  userId: string | null
  keyId: string | null
  /** Privileged actions: whether a passkey or only the browser key confirmed it. */
  stepUp?: 'passkey' | 'passkey-recent' | 'browser-key'
}

export async function getRelayIntents(token: string, filter: { limit?: number; keyId?: string; verdict?: RelayIntentEntry['verdict'] } = {}): Promise<RelayIntentEntry[]> {
  const params = new URLSearchParams()
  if (filter.limit) params.set('limit', String(filter.limit))
  if (filter.keyId) params.set('keyId', filter.keyId)
  if (filter.verdict) params.set('verdict', filter.verdict)
  const res = await transport.authFetch(`/api/relay/intents?${params.toString()}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to read the activity log: ${res.status}`)
  return (await jsonBody<{ entries: RelayIntentEntry[] }>(res)).entries
}

/** Check the intent log's hash chain. */
export async function verifyRelayIntents(token: string): Promise<{ ok: boolean; entries: number; problem?: { line: number; reason: string } }> {
  const res = await transport.authFetch('/api/relay/intents/verify', { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to check the activity log: ${res.status}`)
  return jsonBody(res)
}
