/**
 * HTTP + WebSocket client for the Codekin server API.
 *
 * All calls go through the active transport (src/lib/transport), which in
 * local mode maps them onto the /cc proxy (nginx → server on port 32352).
 * This module stays the single facade components and hooks import from.
 */

import type { Session, SessionPlace, WsServerMessage, CodingProvider } from '../types'
import { transport } from './transport'
import { enableRelayWebhook, fetchRelayWebhook } from './relayWebhook'
import { failure, readJson, request, send, type RequestOptions, type SendOptions } from './request'

/**
 * Codekin server call through `transport.authFetch`, so an expired hosting
 * session (Authelia locally, the control plane when hosted) redirects to
 * login and rejects with `Error('Session expired')`.
 */
function api<T = unknown>(path: string, opts: RequestOptions): Promise<T> {
  return request<T>(path, { authFetch: true, ...opts })
}

/** Same as {@link api}, returning the raw Response for call sites with their own status handling. */
function apiSend(path: string, opts: SendOptions): Promise<Response> {
  return send(path, { authFetch: true, ...opts })
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
  const res = await apiSend(`/auth-verify`, { method: 'POST', token, jsonHeader: true })
  if (!res.ok) return false
  const data = await readJson<{ valid?: boolean }>(res)
  return data.valid === true
}

/** Fetch all sessions from the server. */
export async function listSessions(token: string): Promise<Session[]> {
  const data = await api<{ sessions?: Session[] }>(`/api/sessions/list`, { token, error: 'Failed to list sessions' })
  return data.sessions ?? []
}

/** Rename a session. */
export async function renameSession(token: string, sessionId: string, name: string): Promise<void> {
  await api(`/api/sessions/${sessionId}/rename`, { method: 'PATCH', token, body: { name }, parse: 'none', error: 'Failed to rename session' })
}

/** Delete a session by ID. Kills any running Claude process. */
export async function deleteSession(token: string, sessionId: string): Promise<void> {
  await api(`/api/sessions/${sessionId}`, { method: 'DELETE', token, parse: 'none', error: 'Failed to delete session' })
}

/** List archived sessions — resumable, with their worktrees kept. */
export async function listArchivedLiveSessions(token: string): Promise<Session[]> {
  const data = await api<{ sessions?: Session[] }>(`/api/sessions/list?archived=1`, { token, error: 'Failed to list archived sessions' })
  return data.sessions ?? []
}

/** Archive a session: stop it and hide it, keeping its worktree and branch. */
export async function archiveSession(token: string, sessionId: string): Promise<void> {
  await api(`/api/sessions/${sessionId}/archive`, { method: 'POST', token, parse: 'none', error: 'Failed to archive session' })
}

/** Return an archived session to the active list. */
export async function resumeSession(token: string, sessionId: string): Promise<void> {
  await api(`/api/sessions/${sessionId}/resume`, { method: 'POST', token, parse: 'none', error: 'Failed to resume session' })
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

export function getRemovalPreflight(token: string, sessionId: string): Promise<WorktreeRemovalPreflight> {
  return api<WorktreeRemovalPreflight>(`/api/sessions/${sessionId}/removal-preflight`, { token, error: 'Failed to check working files' })
}

/** Remove an archived session's working files. The server re-checks and refuses unsafe removals. */
export async function removeSessionWorktree(token: string, sessionId: string): Promise<{ removed: boolean; error?: string }> {
  const res = await apiSend(`/api/sessions/${sessionId}/remove-worktree`, { method: 'POST', token })
  if (res.ok) return { removed: true }
  const body = await readJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
  return { removed: false, error: body.error ?? `Failed to remove working files: ${res.status}` }
}

/** Read Joe's saved harness without starting an agent process. */
export function getOrchestratorStatus(token: string): Promise<{ provider: CodingProvider | null; agentName?: string }> {
  return api('/api/orchestrator/status', { token, jsonHeader: true, error: 'Failed to load orchestrator' })
}

/** Ensure the orchestrator session is running and return its session ID. */
export function startOrchestrator(token: string, provider?: CodingProvider): Promise<{ sessionId: string; status: string; agentName?: string }> {
  return api(`/api/orchestrator/start`, { method: 'POST', token, body: provider ? { provider } : {}, error: 'Failed to start orchestrator' })
}

/** Upload a file via the server. Returns the server-side file path. */
export async function uploadFile(token: string, file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const data = await api<{ path: string }>(`/api/upload`, { method: 'POST', token, rawBody: form, error: 'Upload failed' })
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
export function getRepoApprovals(token: string, workingDir: string): Promise<RepoApprovals> {
  const params = new URLSearchParams({ path: workingDir })
  return api<RepoApprovals>(`/api/approvals?${params}`, { token, error: 'Failed to fetch approvals' })
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
  const res = await apiSend('/api/approvals/all', { token })
  if (res.ok) return (await readJson<{ repos: RepoApprovalsEntry[] }>(res)).repos
  if (res.status !== 404) throw await failure(res, { error: 'Failed to fetch approvals' })

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
  await api(`/api/approvals?${params}`, { method: 'DELETE', token, body: opts, parse: 'none', error: 'Failed to remove approval' })
}

/** Bulk remove multiple auto-approval rules in a single request. */
export async function bulkRemoveRepoApprovals(
  token: string,
  workingDir: string,
  items: Array<{ tool?: string; command?: string }>,
): Promise<void> {
  const params = new URLSearchParams({ path: workingDir })
  await api(`/api/approvals?${params}`, { method: 'DELETE', token, body: { items }, parse: 'none', error: 'Failed to bulk remove approvals' })
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
  const data = await api<{ sessions?: ArchivedSessionInfo[] }>(`/api/sessions/archived${qs ? `?${qs}` : ''}`, { token, error: 'Failed to list archived sessions' })
  return data.sessions ?? []
}

/** Fetch a single archived session with full chat history. */
export function getArchivedSession(token: string, sessionId: string): Promise<ArchivedSessionFull> {
  return api<ArchivedSessionFull>(`/api/sessions/archived/${sessionId}`, { token, error: 'Failed to get archived session' })
}

/** Delete an archived session permanently. */
export async function deleteArchivedSession(token: string, sessionId: string): Promise<void> {
  await api(`/api/sessions/archived/${sessionId}`, { method: 'DELETE', token, parse: 'none', error: 'Failed to delete archived session' })
}

/** Get the session retention period in days. */
export async function getRetentionDays(token: string): Promise<number> {
  return (await api<{ days: number }>(`/api/settings/retention`, { token, error: 'Failed to get retention settings' })).days
}

/** Set the session retention period in days. */
export async function setRetentionDays(token: string, days: number): Promise<number> {
  return (await api<{ days: number }>(`/api/settings/retention`, { method: 'PUT', token, body: { days }, error: 'Failed to update retention settings' })).days
}

/** Get the configured repos path (empty string means server default). */
export async function getReposPath(token: string): Promise<string> {
  return (await api<{ path: string }>(`/api/settings/repos-path`, { token, error: 'Failed to get repos path' })).path
}

/** Set the repos path. Empty string resets to server default. */
export async function setReposPath(token: string, path: string): Promise<string> {
  return (await api<{ path: string }>(`/api/settings/repos-path`, { method: 'PUT', token, body: { path }, serverMessage: ['error'], unreadable: 'Failed to save repos path', error: 'Failed to set repos path' })).path
}

/** Get the queue messages setting. */
export async function getQueueMessages(token: string): Promise<boolean> {
  return (await api<{ enabled: boolean }>(`/api/settings/queue-messages`, { token, error: 'Failed to get queue messages setting' })).enabled
}

/** Set the queue messages setting. */
export async function setQueueMessages(token: string, enabled: boolean): Promise<boolean> {
  return (await api<{ enabled: boolean }>(`/api/settings/queue-messages`, { method: 'PUT', token, body: { enabled }, error: 'Failed to update queue messages setting' })).enabled
}

/**
 * Get the UI preferences blob. Resolves to null when the server predates the
 * endpoint (404), so the caller can fall back instead of treating it as empty.
 */
export async function getPrefs(token: string): Promise<Record<string, unknown> | null> {
  const res = await apiSend(`/api/settings/prefs`, { token })
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, { error: 'Failed to get preferences' })
  return (await readJson<{ prefs: Record<string, unknown> }>(res)).prefs
}

/** Merge a partial update into the UI preferences; null values remove keys. */
export async function putPrefs(token: string, patch: Record<string, unknown>): Promise<void> {
  await api(`/api/settings/prefs`, { method: 'PUT', token, body: { patch }, parse: 'none', error: 'Failed to save preferences' })
}

/** Get the worktree branch prefix setting. */
export async function getWorktreePrefix(token: string): Promise<string> {
  return (await api<{ prefix: string }>(`/api/settings/worktree-prefix`, { token, error: 'Failed to get worktree prefix' })).prefix
}

/** Set the worktree branch prefix. */
export async function setWorktreePrefix(token: string, prefix: string): Promise<string> {
  return (await api<{ prefix: string }>(`/api/settings/worktree-prefix`, { method: 'PUT', token, body: { prefix }, serverMessage: ['error'], unreadable: 'Failed to save worktree prefix', error: 'Failed to set worktree prefix' })).prefix
}

/** Get the agent display name. */
export async function getAgentName(token: string): Promise<string> {
  return (await api<{ name: string }>(`/api/settings/agent-name`, { token, error: 'Failed to get agent name' })).name
}

/** Set the agent display name. */
export async function setAgentName(token: string, name: string): Promise<string> {
  return (await api<{ name: string }>(`/api/settings/agent-name`, { method: 'PUT', token, body: { name }, serverMessage: ['error'], unreadable: 'Failed to save agent name', error: 'Failed to set agent name' })).name
}

/** Browse directories at a given path (for folder picker). */
/** One folder listing from /api/browse-dirs. The git fields are absent on older servers. */
export interface DirListing {
  path: string
  dirs: string[]
  /** Subfolders that are git work trees. */
  gitDirs?: string[]
  /** `path` is in a git work tree: its own, or an enclosing repository's. */
  git?: boolean
  /** Root of the work tree containing `path` (equal to `path` at a repository root). */
  repoRoot?: string
  /** Roots every session folder must sit inside. */
  roots?: string[]
  home?: string
}

export function browseDirs(token: string, path?: string): Promise<DirListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return api<DirListing>(`/api/browse-dirs${q}`, { token, serverMessage: ['error'], unreadable: 'Failed to browse directory', error: 'Failed to browse' })
}

/** Create a new, empty scratch folder for a session; returns its absolute path. */
export async function createScratch(token: string): Promise<string> {
  const message = 'Could not create a scratch folder'
  return (await api<{ path: string }>(`/api/scratch`, { method: 'POST', token, jsonHeader: true, serverMessage: ['error'], unreadable: message, error: message })).path
}

/** The folder an org session runs in (`<repos root>/<owner>`), created on first use. */
export async function orgFolder(token: string, owner: string): Promise<string> {
  const message = `Could not prepare the folder for ${owner}`
  return (await api<{ path: string }>(`/api/orgs/${encodeURIComponent(owner)}/folder`, {
    method: 'POST', token, jsonHeader: true, serverMessage: ['error'], unreadable: message, error: message,
  })).path
}

/** The configured scratch root (`path`, empty = default) and the one in effect. */
export function getScratchRoot(token: string): Promise<{ path: string; effective: string }> {
  return api(`/api/settings/scratch-root`, { token, error: 'Failed to get scratch folder' })
}

/** Set the scratch root. Empty string resets it to the default. */
export function setScratchRoot(token: string, path: string): Promise<{ path: string; effective: string }> {
  const message = 'Failed to save scratch folder'
  return api(`/api/settings/scratch-root`, { method: 'PUT', token, body: { path }, serverMessage: ['error'], unreadable: message, error: message })
}

/** Attach a folder to a running session; returns the attached folders (realpaths). */
export async function attachFolder(token: string, sessionId: string, path: string): Promise<string[]> {
  const message = 'Could not attach the folder'
  return (await api<{ attached: string[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/attached`, {
    method: 'POST', token, body: { path }, serverMessage: ['error'], unreadable: message, error: message,
  })).attached
}

/** Detach a folder attached with attachFolder(). */
export async function detachFolder(token: string, sessionId: string, path: string): Promise<string[]> {
  const message = 'Could not detach the folder'
  return (await api<{ attached: string[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/attached?path=${encodeURIComponent(path)}`, {
    method: 'DELETE', token, jsonHeader: true, serverMessage: ['error'], unreadable: message, error: message,
  })).attached
}

/** Move a scratch session's folder into `parent`; returns the new path. */
export function moveSessionFolder(token: string, sessionId: string, parent: string): Promise<{ path: string; place: SessionPlace }> {
  const message = 'Could not move the folder'
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/move`, {
    method: 'POST', token, body: { parent }, serverMessage: ['error'], unreadable: message, error: message,
  })
}

/** Publish a session's folder to GitHub (commit everything, gh repo create --push). */
export function publishToGitHub(
  token: string, sessionId: string, choice: { owner: string; name: string; visibility: 'private' | 'public' },
): Promise<{ url: string; place: SessionPlace }> {
  const message = 'Publishing failed'
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/publish`, {
    method: 'POST', token, body: choice, serverMessage: ['error'], unreadable: message, error: message,
  })
}

/** Run `git init` in a session's folder; returns the session's new place. */
export async function gitInit(token: string, sessionId: string): Promise<SessionPlace> {
  const message = 'git init failed'
  return (await api<{ place: SessionPlace }>(`/api/sessions/${encodeURIComponent(sessionId)}/git-init`, {
    method: 'POST', token, jsonHeader: true, serverMessage: ['error'], unreadable: message, error: message,
  })).place
}

let nativeFolderPickerAvailable: Promise<boolean> | null = null

/**
 * Whether the server can open the native macOS folder dialog for this browser
 * (macOS server, same machine, no proxy). Cached for the page's lifetime; any
 * failure — the hosted relay, an older server — counts as unavailable.
 */
export function getNativeFolderPickerAvailable(token: string): Promise<boolean> {
  nativeFolderPickerAvailable ??= apiSend(`/api/native/folder-picker`, { token })
    .then(async res => {
      // A stale token is not an answer — ask again next time.
      if (res.status === 401) nativeFolderPickerAvailable = null
      return res.ok && (await readJson<{ available?: boolean }>(res)).available === true
    })
    .catch(() => {
      nativeFolderPickerAvailable = null
      return false
    })
  return nativeFolderPickerAvailable
}

/** Open the native macOS folder dialog; resolves with the chosen path, or null if cancelled. */
export async function pickFolderNative(token: string, defaultPath?: string): Promise<string | null> {
  const message = 'Failed to open folder dialog'
  const data = await api<{ path?: string; cancelled?: boolean }>(`/api/native/pick-folder`, {
    method: 'POST', token, body: defaultPath ? { defaultPath } : {}, serverMessage: ['error'], unreadable: message, error: message,
  })
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
  return (await api<{ config: WebhookConfigInfo }>(`/api/webhooks/config`, { token, error: 'Failed to get webhook config' })).config
}

/** Fetch recent webhook events. */
export async function getWebhookEvents(token: string): Promise<Array<{ id: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; receivedAt: string }>> {
  type Event = { id: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; receivedAt: string }
  const data = await api<{ events?: Event[] }>(`/api/webhooks/events`, { token, error: 'Failed to get webhook events' })
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
  const res = await send('/api/clone', { method: 'POST', token, body: { owner, name } })
  if (!res.ok) {
    const data = await readJson<{ error?: string }>(res)
    throw new Error(data.error || 'Clone failed')
  }
  const data = await readJson<{ path?: unknown }>(res).catch(() => ({ path: undefined }))
  return typeof data.path === 'string' && data.path ? data.path : null
}

/** Fetch orchestrator dashboard stats. Returns null on any failure — stats are optional. */
export async function getOrchestratorDashboard<T>(token: string): Promise<T | null> {
  try {
    const res = await send('/api/orchestrator/dashboard', { token })
    if (!res.ok) return null
    const data = await readJson<{ stats: T }>(res)
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
  const res = await send(`/api/opencode/models${params}`, { token })
  if (!res.ok) return { models: [], defaults: {} }
  return readJson(res)
}

/** Fetch available models from the Codex CLI (via short-lived app-server). */
export async function fetchCodexModels(
  token: string,
): Promise<{
  models: Array<{ id: string; name: string; description?: string; isDefault?: boolean; efforts?: { id: string; description?: string }[]; defaultEffort?: string }>
}> {
  const res = await send(`/api/codex/models`, { token })
  if (!res.ok) return { models: [] }
  return readJson(res)
}

/** A model from /api/grok/models (also carries per-model reasoning efforts). */
export interface GrokModelEntry {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  efforts?: { id: string; description?: string }[]
  defaultEffort?: string
}

/** Fetch available models from the Grok Build CLI (via a short-lived ACP handshake). */
export async function fetchGrokModels(
  token: string,
): Promise<{ models: GrokModelEntry[] }> {
  const res = await send(`/api/grok/models`, { token })
  if (!res.ok) return { models: [] }
  return readJson<{ models: GrokModelEntry[] }>(res)
}

/** Fetch the OpenCode command list (slash commands / skills / MCP prompts). */
export async function fetchOpenCodeCommands(
  token: string,
  workingDir?: string,
): Promise<Array<{ name: string; description?: string; source?: 'command' | 'mcp' | 'skill' }>> {
  const params = workingDir ? `?workingDir=${encodeURIComponent(workingDir)}` : ''
  const res = await send(`/api/opencode/commands${params}`, { token })
  if (!res.ok) return []
  const data = await readJson<{ commands?: Array<{ name: string; description?: string; source?: 'command' | 'mcp' | 'skill' }> }>(res)
  return data.commands ?? []
}

/** Fetch available Claude models from the Anthropic API (via server proxy). */
export async function fetchClaudeModels(
  token: string,
): Promise<Array<{ id: string; label: string }>> {
  const res = await send(`/api/claude/models`, { token })
  if (!res.ok) return []
  const data = await readJson<{ models?: Array<{ id: string; label: string }> }>(res)
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
export function getIntegrationHealth(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<HealthCheckResult> {
  const params = new URLSearchParams({ repo, webhookUrl })
  return api<HealthCheckResult>(`/api/integrations/github/pr-review/health?${params}`, { token, error: 'Health check failed' })
}

/** Preview for webhook setup (what would be created/changed). */
export interface SetupPreview {
  action: 'create' | 'update' | 'none'
  existing?: { id: number; active: boolean; events: string[]; config: { url: string } }
  proposed: { url: string; events: string[]; active: boolean }
  changes?: string[]
}

/** Preview what the webhook setup would do. */
export function previewWebhookSetup(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ preview: SetupPreview; secretGenerated: boolean }> {
  return api(`/api/integrations/github/pr-review/setup`, {
    method: 'POST', token, body: { repo, webhookUrl, dryRun: true }, error: 'Setup preview failed',
  })
}

/** Apply webhook setup (create or update webhook on GitHub). */
export function applyWebhookSetup(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ preview: SetupPreview; secretGenerated: boolean; webhook?: unknown }> {
  return api(`/api/integrations/github/pr-review/setup`, {
    method: 'POST', token, body: { repo, webhookUrl }, serverMessage: ['error'], unreadable: 'Setup failed', error: 'Setup failed',
  })
}

/** Send a test ping to the webhook and check delivery. */
export function testWebhookDelivery(
  token: string,
  repo: string,
  webhookUrl: string,
): Promise<{ success: boolean; message: string; delivery?: { id: number; statusCode: number; event: string } }> {
  return api(`/api/integrations/github/pr-review/test`, {
    method: 'POST', token, body: { repo, webhookUrl }, serverMessage: ['error'], unreadable: 'Test failed', error: 'Test failed',
  })
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

export function getRelayStatus(token: string): Promise<RelayStatus> {
  return api<RelayStatus>('/api/relay/status', { token, jsonHeader: true, error: 'Failed to get relay status' })
}

export function getRelayPairing(token: string): Promise<RelayPairingState> {
  return api<RelayPairingState>('/api/relay/pair', { token, jsonHeader: true, error: 'Failed to get pairing state' })
}

/** Start pairing; resolves with the code to approve. Rejects with the server's message. */
export function startRelayPairing(token: string, relayUrl?: string): Promise<RelayPairingState> {
  return api<RelayPairingState>('/api/relay/pair', {
    method: 'POST', token, body: relayUrl ? { relayUrl } : {}, serverMessage: ['message', 'error'], error: 'Pairing failed',
  })
}

export function cancelRelayPairing(token: string): Promise<RelayPairingState> {
  return api<RelayPairingState>('/api/relay/pair', { method: 'DELETE', token, jsonHeader: true, error: 'Failed to cancel pairing' })
}

/** Remove this machine's local relay credential. */
export function unpairRelay(token: string): Promise<{ removed: boolean }> {
  return api('/api/relay/unpair', { method: 'POST', token, jsonHeader: true, error: 'Failed to unpair' })
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

export function getRelayDevices(token: string): Promise<RelayDevices> {
  return api<RelayDevices>('/api/relay/devices', { token, jsonHeader: true, error: 'Failed to get devices' })
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
  const res = await apiSend('/api/relay/devices/approve', { method: 'POST', token, body: { code } })
  const body = await readJson<{
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
  await api('/api/relay/devices/policy', {
    method: 'PUT', token, body: { policy }, parse: 'none', serverMessage: ['message', 'error'], error: 'Failed to change the policy',
  })
}

/** Whether an enrolled passkey may add a browser without a code typed here. */
export async function setRelayLocalConfirmationOnly(token: string, value: boolean): Promise<void> {
  await api('/api/relay/devices/settings', {
    method: 'PUT', token, body: { localConfirmationOnly: value }, parse: 'none', error: 'Failed to change the setting',
  })
}

/** Turn down a browser waiting to be confirmed. */
export async function rejectRelayEnrolment(token: string, enrolId: string): Promise<void> {
  await api(`/api/relay/devices/pending/${encodeURIComponent(enrolId)}`, {
    method: 'DELETE', token, jsonHeader: true, parse: 'none', error: 'Failed to turn the request down',
  })
}

/** Remove a device from this machine's list. Rejects with the server's message. */
export async function revokeRelayDevice(token: string, keyId: string): Promise<void> {
  await api(`/api/relay/devices/${encodeURIComponent(keyId)}`, {
    method: 'DELETE', token, jsonHeader: true, parse: 'none', serverMessage: ['message'], error: 'Failed to remove device',
  })
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
  return (await api<{ entries: RelayIntentEntry[] }>(`/api/relay/intents?${params.toString()}`, {
    token, jsonHeader: true, error: 'Failed to read the activity log',
  })).entries
}

/** Check the intent log's hash chain. */
export function verifyRelayIntents(token: string): Promise<{ ok: boolean; entries: number; problem?: { line: number; reason: string } }> {
  return api('/api/relay/intents/verify', { token, jsonHeader: true, error: 'Failed to check the activity log' })
}
