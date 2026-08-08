/**
 * HTTP + WebSocket client for the Codekin server API.
 *
 * All calls go through the active transport (src/lib/transport), which in
 * local mode maps them onto the /cc proxy (nginx → server on port 32352).
 * This module stays the single facade components and hooks import from.
 */

import type { Session, WsServerMessage } from '../types'
import { transport } from './transport'

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

/** Ensure the orchestrator session is running and return its session ID. */
export async function startOrchestrator(token: string): Promise<{ sessionId: string; status: string; agentName?: string }> {
  const res = await transport.authFetch(`/api/orchestrator/start`, {
    method: 'POST',
    headers: headers(token),
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

/** Browser-facing URL of the GitHub webhook receiver (shown in setup UIs). */
export function webhookEndpointUrl(): string {
  return transport.externalUrl('/api/webhooks/github')
}

/** Clone a GitHub repo on the server. Throws with the server's error message on failure. */
export async function cloneRepo(token: string | undefined, owner: string, name: string): Promise<void> {
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
  models: Array<{ id: string; name: string; description?: string; isDefault?: boolean }>
}> {
  const res = await transport.fetch(`/api/codex/models`, {
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
