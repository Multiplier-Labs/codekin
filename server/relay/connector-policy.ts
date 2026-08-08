/**
 * Connector-side permission enforcement (spec §5.2, §10).
 *
 * The hub already decides who may reach a machine, but the connector checks
 * again here against grants pushed to it, because the machine — not the
 * hosted service — is the last word on what runs locally. A relay that is
 * compromised or buggy can misroute a request; it cannot make this file
 * approve a shell command for a viewer.
 *
 * Owners bypass these checks: they already have unrestricted local access.
 */

import type { GrantMap, SessionPermission } from './shares.js'

export type ChannelRole = 'owner' | 'grantee'

export interface ChannelPolicy {
  role: ChannelRole
  /** Session id → permissions. Empty for owners, who are not restricted. */
  grants: GrantMap
}

export interface PolicyDecision {
  allowed: boolean
  /** Why it was refused — surfaced to the browser and the audit log. */
  reason?: string
  /** Permission that was missing, for audit metadata. */
  permission?: SessionPermission
}

const ALLOW: PolicyDecision = { allowed: true }

/**
 * Tool classification for approval prompts. Anything unrecognized counts as
 * mutating: a new tool should require the stricter grant until someone
 * decides otherwise, not the weaker one.
 */
const READONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead', 'TodoWrite', 'Task',
])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell'])

export function permissionForTool(toolName: string | undefined): SessionPermission {
  if (toolName && SHELL_TOOLS.has(toolName)) return 'approve_shell'
  if (toolName && READONLY_TOOLS.has(toolName)) return 'approve_readonly_tool'
  return 'approve_mutating_tool'
}

/**
 * REST paths a grantee may reach at all — deliberately tiny, because a
 * grantee's real surface is the session stream, not the machine's API.
 *
 * `/api/sessions/list` is allowed but its response is filtered to granted
 * sessions (see filterSessionList), so names and working directories of
 * unshared sessions never leave the machine. `/api/approvals` is absent: it
 * manages repo-wide approval rules, which is machine policy, not session
 * participation. `/api/upload` writes into the screenshots directory only,
 * which is why it can be granted without a path check.
 */
const GRANTEE_READ_PREFIXES = ['/auth-verify', '/api/health', '/api/sessions/list']
const GRANTEE_WRITE_PREFIXES = ['/auth-verify', '/api/upload']

/** Response bodies that must be narrowed before a grantee may see them. */
export function needsSessionListFilter(policy: ChannelPolicy, path: string): boolean {
  return policy.role === 'grantee' && path.split('?')[0] === '/api/sessions/list'
}

/**
 * Reduce a `/api/sessions/list` body to the sessions a grantee holds a share
 * for. Returns null when the body is not the expected shape, so the caller
 * can refuse rather than pass through something it could not filter.
 */
export function filterSessionList(policy: ChannelPolicy, body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { sessions?: unknown }
    if (!Array.isArray(parsed.sessions)) return null
    const granted = parsed.sessions.filter(
      (s): s is { id: string } =>
        typeof s === 'object' && s !== null && typeof (s as { id?: unknown }).id === 'string' &&
        (s as { id: string }).id in policy.grants,
    )
    return JSON.stringify({ ...parsed, sessions: granted })
  } catch {
    return null
  }
}

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** Whether a grantee may issue this proxied REST call. */
export function checkRestPolicy(policy: ChannelPolicy, method: string, path: string): PolicyDecision {
  if (policy.role === 'owner') return ALLOW

  const upper = method.toUpperCase()
  const pathname = path.split('?')[0]
  const isRead = upper === 'GET' || upper === 'HEAD'

  if (isRead) {
    if (!matchesPrefix(pathname, GRANTEE_READ_PREFIXES)) {
      return { allowed: false, reason: `${upper} ${pathname} is owner-only` }
    }
    return ALLOW
  }

  if (!matchesPrefix(pathname, GRANTEE_WRITE_PREFIXES)) {
    return { allowed: false, reason: `${upper} ${pathname} is owner-only` }
  }
  if (pathname.startsWith('/api/upload') && !hasAnyPermission(policy, 'upload_file')) {
    return { allowed: false, reason: 'Uploading files is not granted', permission: 'upload_file' }
  }
  return ALLOW
}

/** True when the user holds a permission on at least one granted session. */
function hasAnyPermission(policy: ChannelPolicy, permission: SessionPermission): boolean {
  return Object.values(policy.grants).some(perms => perms.includes(permission))
}

function hasPermission(policy: ChannelPolicy, sessionId: string | null, permission: SessionPermission): boolean {
  if (!sessionId) return false
  return (policy.grants[sessionId] ?? []).includes(permission)
}

export interface ChannelState {
  /** Session this channel has joined, if any. */
  sessionId: string | null
  /** requestId → toolName, from prompts the local server sent on this channel. */
  pendingPrompts: Map<string, string | undefined>
}

export function newChannelState(): ChannelState {
  return { sessionId: null, pendingPrompts: new Map() }
}

/** Cap on remembered prompts, so a long session cannot grow this unbounded. */
const MAX_TRACKED_PROMPTS = 64

/**
 * Record what the local server sent so later client frames can be judged
 * against it — specifically which tool an approval prompt was for.
 */
export function observeServerFrame(state: ChannelState, frame: string): void {
  const msg = parseFrame(frame)
  if (!msg) return

  if (msg.type === 'prompt' && typeof msg.requestId === 'string') {
    if (state.pendingPrompts.size >= MAX_TRACKED_PROMPTS) {
      const oldest = state.pendingPrompts.keys().next().value
      if (oldest !== undefined) state.pendingPrompts.delete(oldest)
    }
    state.pendingPrompts.set(msg.requestId, typeof msg.toolName === 'string' ? msg.toolName : undefined)
    return
  }
  if (msg.type === 'prompt_dismiss' && typeof msg.requestId === 'string') {
    state.pendingPrompts.delete(msg.requestId)
  }
}

/**
 * Whether a frame from the browser may be forwarded to the local server, and
 * what it does to the channel's state.
 *
 * Grantees are confined to the sessions shared with them: they may only join
 * a granted session, and every action is checked against that session's
 * permissions.
 */
export function checkClientFrame(policy: ChannelPolicy, state: ChannelState, frame: string): PolicyDecision {
  const msg = parseFrame(frame)
  if (!msg || typeof msg.type !== 'string') {
    return { allowed: false, reason: 'Unparsable frame' }
  }

  // Track the joined session for both roles; the owner path needs it for audit.
  if (msg.type === 'join_session') {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
    if (policy.role === 'grantee' && (!sessionId || !(sessionId in policy.grants))) {
      return { allowed: false, reason: 'That session has not been shared with you' }
    }
    state.sessionId = sessionId
    return ALLOW
  }
  if (msg.type === 'leave_session') {
    state.sessionId = null
    return ALLOW
  }

  if (policy.role === 'owner') return ALLOW

  switch (msg.type) {
    case 'ping':
    case 'resize':
      return ALLOW

    case 'get_diff':
      return requirePermission(policy, state, 'view_diff', 'Viewing diffs is not granted')

    case 'input':
      return requirePermission(policy, state, 'send_prompt', 'Sending prompts is not granted')

    case 'stop':
      return requirePermission(policy, state, 'stop_session', 'Stopping the session is not granted')

    case 'prompt_response': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
      // An answer to a prompt we never relayed cannot be classified, so it
      // is judged as the strictest kind rather than waved through.
      const toolName = requestId ? state.pendingPrompts.get(requestId) : undefined
      const needed = permissionForTool(toolName)
      return requirePermission(policy, state, needed, `Approving this action is not granted (${needed})`)
    }

    // Everything else changes the session's shape or the machine's state:
    // creating sessions, switching models or providers, changing permission
    // mode, discarding changes, moving to a worktree. Owner-only.
    default:
      return { allowed: false, reason: `"${msg.type}" is owner-only` }
  }
}

function requirePermission(
  policy: ChannelPolicy,
  state: ChannelState,
  permission: SessionPermission,
  reason: string,
): PolicyDecision {
  if (!state.sessionId) {
    return { allowed: false, reason: 'Join a shared session first', permission }
  }
  if (!hasPermission(policy, state.sessionId, permission)) {
    return { allowed: false, reason, permission }
  }
  return ALLOW
}

interface LocalFrame {
  type?: string
  sessionId?: unknown
  requestId?: unknown
  toolName?: unknown
}

function parseFrame(text: string): LocalFrame | null {
  try {
    const parsed = JSON.parse(text) as LocalFrame
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}
