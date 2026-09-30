/**
 * REST routes for session management, approvals, settings, and hook endpoints.
 *
 * Mounted at the Express app root (routes carry their own /api/ prefixes).
 */

import { Router } from 'express'
import type { Request } from 'express'
import {
  existsSync as fsExistsSync,
  statSync as fsStatSync,
  readdirSync as fsReaddirSync,
  realpathSync as fsRealpathSync,
} from 'fs'
import { resolve as pathResolve, join as pathJoin } from 'path'
import { toNativePermission } from './native-permissions.js'
import { homedir as osHomedir } from 'os'
import type { SessionManager } from './session-manager.js'
import type { WsServerMessage } from './types.js'
import { REPOS_ROOT, getAgentDisplayName } from './config.js'
import { fetchAnthropicModels, refreshAnthropicModels, refreshCooldownRemainingMs } from './anthropic-models.js'
import { VALID_PROVIDERS, VALID_PERMISSION_MODES } from './types.js'
import type { CodingProvider } from './coding-process.js'
import type { PermissionMode } from './types.js'
import { fetchOpenCodeModels, fetchOpenCodeCommands } from './opencode-process.js'
import { fetchCodexModels } from './codex-process.js'
import { fetchGrokModels } from './grok-process.js'

// ---------------------------------------------------------------------------
// Request body interfaces for route handlers
// ---------------------------------------------------------------------------

interface CreateSessionBody {
  name: string
  workingDir: string
  provider?: CodingProvider
  model?: string
  permissionMode?: PermissionMode
}

interface RenameBody {
  name: string
}

interface RetentionBody {
  days: number
}

interface WorktreePrefixBody {
  prefix: string
}

interface QueueMessagesBody {
  enabled: boolean
}

interface ReposPathBody {
  path: string
}

interface AgentNameBody {
  name: string
}

interface PrefsBody {
  patch: Record<string, unknown>
}

/** Settings-table key holding the UI preferences blob (see /api/settings/prefs). */
const UI_PREFS_KEY = 'ui_prefs'
/** Pref names are camelCase identifiers; anything else is rejected. */
const PREF_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/
/** Upper bound on the stored blob, so a runaway client cannot bloat the DB. */
const MAX_PREFS_BYTES = 256 * 1024

interface ApprovalDeleteBody {
  tool?: string
  command?: string
  pattern?: string
  items?: Array<{ tool?: string; command?: string; pattern?: string }>
}

interface HookDecisionBody {
  sessionId: string
  toolName: string
  toolInput?: Record<string, unknown>
}

interface HookNotifyBody {
  sessionId: string
  notificationType?: string
  title?: string
  message?: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

interface AuthValidateBody {
  sessionId?: string
}

/** Expand leading ~ to the user's home directory. */
export function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return pathJoin(osHomedir(), p.slice(1))
  return p
}

/**
 * Canonicalize a user-supplied repos path for persistence.
 *
 * Expands ~, resolves to an absolute canonical path via realpathSync (so the
 * stored value never contains ~ or symlinks), then enforces that the resolved
 * path is the user's home dir, REPOS_ROOT, or a descendant of either.
 * Mirrors the boundary check used by /api/browse-dirs and /api/sessions/create
 * to prevent the setting from pointing at arbitrary host paths (e.g. /etc).
 */
export function canonicalizeReposPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const expanded = expandTilde(raw)
  if (!fsExistsSync(expanded) || !fsStatSync(expanded).isDirectory()) {
    return { ok: false, error: 'Path does not exist or is not a directory' }
  }
  let resolved: string
  try {
    resolved = fsRealpathSync(expanded)
  } catch {
    return { ok: false, error: 'Path could not be resolved' }
  }
  const home = osHomedir()
  const allowedRoots = [home, REPOS_ROOT]
  const inAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + '/'))
  if (!inAllowed) {
    return { ok: false, error: 'Path is outside allowed directories (must be under home or repos root)' }
  }
  return { ok: true, path: resolved }
}

type VerifyFn = (token: string | undefined) => boolean
type VerifySessionFn = (token: string | undefined, sessionId: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createSessionRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
  verifySessionTokenFn?: VerifySessionFn,
): Router {
  /** Verify master token OR session-scoped token (for hook endpoints called by child processes). */
  const verifyHookToken = (token: string | undefined, sessionId: string | undefined) =>
    verifySessionTokenFn ? verifySessionTokenFn(token, sessionId) : verifyToken(token)
  const router = Router()

  // --- Session CRUD ---

  // `?archived=1` lists archived (resumable) sessions instead of active ones.
  router.get('/api/sessions/list', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ sessions: req.query.archived === '1' ? sessions.listArchived() : sessions.list() })
  })

  router.get('/api/claude/models', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const models = await fetchAnthropicModels()
    res.json({ models })
  })

  // Force model rediscovery, bypassing the cache TTL. With CLI probing this
  // spawns one claude process per candidate ID (~$0.04 per live model), so it
  // is deliberately POST-only, never called automatically, and rate-limited —
  // the cost is global, so the cooldown is global rather than per-token.
  router.post('/api/claude/models/refresh', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const cooldownMs = refreshCooldownRemainingMs()
    if (cooldownMs > 0) {
      const retryAfter = Math.ceil(cooldownMs / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: `Model refresh is rate-limited; retry in ${retryAfter}s`,
        retryAfterSeconds: retryAfter,
      })
    }
    const models = await refreshAnthropicModels()
    res.json({ models })
  })

  router.get('/api/codex/models', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const result = await fetchCodexModels()
    res.json(result)
  })

  router.get('/api/grok/models', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const result = await fetchGrokModels()
    res.json(result)
  })

  router.get('/api/opencode/models', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const rawDir = (req.query.workingDir as string) || osHomedir()

    // Bounds-check: workingDir must be under home or REPOS_ROOT (same as /api/sessions/create)
    const home = osHomedir()
    const allowedRoots = [home, REPOS_ROOT]
    let resolvedDir: string
    try {
      resolvedDir = fsRealpathSync(pathResolve(rawDir))
    } catch {
      return res.status(400).json({ error: 'workingDir could not be resolved (path does not exist or is inaccessible)' })
    }
    if (!allowedRoots.some(root => resolvedDir === root || resolvedDir.startsWith(root + '/'))) {
      return res.status(403).json({ error: 'workingDir is outside allowed directories' })
    }

    const result = await fetchOpenCodeModels(resolvedDir)
    res.json(result)
  })

  router.get('/api/opencode/commands', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const rawDir = (req.query.workingDir as string) || osHomedir()

    // Bounds-check: workingDir must be under home or REPOS_ROOT (same as /api/opencode/models)
    const home = osHomedir()
    const allowedRoots = [home, REPOS_ROOT]
    let resolvedDir: string
    try {
      resolvedDir = fsRealpathSync(pathResolve(rawDir))
    } catch {
      return res.status(400).json({ error: 'workingDir could not be resolved (path does not exist or is inaccessible)' })
    }
    if (!allowedRoots.some(root => resolvedDir === root || resolvedDir.startsWith(root + '/'))) {
      return res.status(403).json({ error: 'workingDir is outside allowed directories' })
    }

    const commands = await fetchOpenCodeCommands(resolvedDir)
    res.json({ commands })
  })

  router.post('/api/sessions/create', (req: Request<Record<string, string>, unknown, CreateSessionBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { name, workingDir } = req.body
    if (!name || !workingDir) {
      return res.status(400).json({ error: 'Missing name or workingDir' })
    }

    // Bounds-check: workingDir must be under home or REPOS_ROOT (same as browse-dirs)
    const home = osHomedir()
    const allowedRoots = [home, REPOS_ROOT]
    let resolvedDir: string
    try {
      resolvedDir = fsRealpathSync(pathResolve(workingDir))
    } catch {
      return res.status(400).json({ error: 'workingDir could not be resolved (path does not exist or is inaccessible)' })
    }
    if (!allowedRoots.some(root => resolvedDir === root || resolvedDir.startsWith(root + '/'))) {
      return res.status(403).json({ error: 'workingDir is outside allowed directories' })
    }

    const { provider, model, permissionMode } = req.body
    if (provider && !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `Invalid provider: ${provider}. Must be one of: ${[...VALID_PROVIDERS].join(', ')}` })
    }
    if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
      return res.status(400).json({ error: `Invalid permissionMode: ${permissionMode}` })
    }
    const session = sessions.create(name, resolvedDir, { provider, model, permissionMode })
    res.json({
      sessionId: session.id,
      session: {
        id: session.id,
        name: session.name,
        created: session.created,
        active: false,
        workingDir: session.workingDir,
        connectedClients: 0,
        lastActivity: session.created,
        source: session.source,
      },
    })
  })

  // Session archive endpoints (must be before /api/sessions/:id to avoid route conflict)
  router.get('/api/sessions/archived', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const workingDir = typeof req.query.workingDir === 'string' ? req.query.workingDir : undefined
    res.json({ sessions: sessions.archive.list(workingDir) })
  })

  router.get('/api/sessions/archived/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const archived = sessions.archive.get(req.params.id)
    if (!archived) return res.status(404).json({ error: 'Archived session not found' })
    res.json(archived)
  })

  router.delete('/api/sessions/archived/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const deleted = sessions.archive.delete(req.params.id)
    if (deleted) {
      res.json({ success: true })
    } else {
      res.status(404).json({ error: 'Archived session not found' })
    }
  })

  router.patch('/api/sessions/:id/rename', (req: Request<{ id: string }, unknown, RenameBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { name } = req.body
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Missing or empty name' })
    }

    const trimmed = name.trim().slice(0, 60)
    const renamed = sessions.rename(req.params.id, trimmed)
    if (renamed) {
      res.json({ success: true, name: trimmed })
    } else {
      res.status(404).json({ error: 'Session not found' })
    }
  })

  // --- Archive lifecycle: archive/resume keep the worktree; removing working
  // files is a separate, preflighted step that never forces. ---

  router.post('/api/sessions/:id/archive', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: 'Session not found' })
    if (!sessions.archiveSession(req.params.id)) return res.status(409).json({ error: 'This session cannot be archived' })
    res.json({ success: true })
  })

  router.post('/api/sessions/:id/resume', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: 'Session not found' })
    if (!sessions.resumeSession(req.params.id)) return res.status(409).json({ error: 'Session is not archived' })
    res.json({ success: true })
  })

  router.get('/api/sessions/:id/removal-preflight', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const preflight = await sessions.getRemovalPreflight(req.params.id)
    if (!preflight) return res.status(404).json({ error: 'Session not found' })
    res.json(preflight)
  })

  router.post('/api/sessions/:id/remove-worktree', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: 'Session not found' })
    const result = await sessions.removeSessionWorktree(req.params.id)
    if (!result.removed) return res.status(409).json({ error: result.reason ?? 'Working files were not removed', preflight: result.preflight })
    res.json({ success: true, preflight: result.preflight })
  })

  router.delete('/api/sessions/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const deleted = sessions.delete(req.params.id)
    if (deleted) {
      res.json({ success: true })
    } else {
      res.status(404).json({ error: 'Session not found' })
    }
  })

  // --- Retention settings ---

  router.get('/api/settings/retention', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ days: sessions.archive.getRetentionDays() })
  })

  router.put('/api/settings/retention', (req: Request<Record<string, string>, unknown, RetentionBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { days } = req.body
    if (typeof days !== 'number' || days < 1) {
      return res.status(400).json({ error: 'days must be a number >= 1' })
    }
    sessions.archive.setRetentionDays(days)
    res.json({ days: sessions.archive.getRetentionDays() })
  })

  // --- Worktree settings ---

  router.get('/api/settings/worktree-prefix', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ prefix: sessions.getWorktreeBranchPrefix() })
  })

  router.put('/api/settings/worktree-prefix', (req: Request<Record<string, string>, unknown, WorktreePrefixBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { prefix } = req.body
    if (typeof prefix !== 'string') {
      return res.status(400).json({ error: 'prefix must be a string' })
    }
    // Sanitize: strip invalid git ref characters, ensure trailing /
    const cleaned = prefix.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/\/+$/, '')
    const final = cleaned ? cleaned + '/' : 'wt/'
    sessions.setWorktreeBranchPrefix(final)
    res.json({ prefix: final })
  })

  // --- Queue messages setting ---

  router.get('/api/settings/queue-messages', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const enabled = sessions.archive.getSetting('queue_messages', 'false')
    res.json({ enabled: enabled === 'true' })
  })

  router.put('/api/settings/queue-messages', (req: Request<Record<string, string>, unknown, QueueMessagesBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { enabled } = req.body
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' })
    }
    sessions.archive.setSetting('queue_messages', String(enabled))
    res.json({ enabled })
  })

  // --- Repos path settings ---

  router.get('/api/settings/repos-path', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const path = sessions.archive.getSetting('repos_path', '')
    res.json({ path })
  })

  router.put('/api/settings/repos-path', (req: Request<Record<string, string>, unknown, ReposPathBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { path: rawPath } = req.body
    if (typeof rawPath !== 'string') {
      return res.status(400).json({ error: 'path must be a string' })
    }
    const trimmed = rawPath.trim()
    // Empty string means "use default REPOS_ROOT"
    let toPersist = ''
    if (trimmed) {
      const result = canonicalizeReposPath(trimmed)
      if (!result.ok) {
        return res.status(400).json({ error: result.error })
      }
      toPersist = result.path
    }
    sessions.archive.setSetting('repos_path', toPersist)
    res.json({ path: toPersist })
  })

  // --- UI preferences ---
  // One JSON blob of client preferences (theme, new-session defaults, layout,
  // drafts). The server does not interpret the values; it stores whatever the
  // UI sends so preferences follow the user across browsers and devices
  // instead of living in one browser's localStorage.

  const readPrefs = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(sessions.archive.getSetting(UI_PREFS_KEY, '{}'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }

  router.get('/api/settings/prefs', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ prefs: readPrefs() })
  })

  // Merge a partial update: each key in `patch` replaces the stored value,
  // and a null value removes the key.
  router.put('/api/settings/prefs', (req: Request<Record<string, string>, unknown, PrefsBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { patch } = req.body ?? {}
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'patch must be an object' })
    }
    const badKey = Object.keys(patch).find(key => !PREF_KEY_RE.test(key))
    if (badKey !== undefined) return res.status(400).json({ error: `invalid pref key: ${badKey}` })
    const prefs = Object.fromEntries(
      Object.entries({ ...readPrefs(), ...patch }).filter(([, value]) => value !== null),
    )
    const serialized = JSON.stringify(prefs)
    if (Buffer.byteLength(serialized) > MAX_PREFS_BYTES) {
      return res.status(413).json({ error: 'preferences too large' })
    }
    sessions.archive.setSetting(UI_PREFS_KEY, serialized)
    res.json({ prefs })
  })

  // --- Agent name setting ---

  router.get('/api/settings/agent-name', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ name: getAgentDisplayName() })
  })

  router.put('/api/settings/agent-name', (req: Request<Record<string, string>, unknown, AgentNameBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { name } = req.body
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name must be a non-empty string' })
    }
    const trimmed = name.trim().slice(0, 30)
    sessions.archive.setSetting('agent_name', trimmed)
    res.json({ name: trimmed })
  })

  // --- Browse directories (for folder picker) ---

  router.get('/api/browse-dirs', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const raw = (typeof req.query.path === 'string' ? req.query.path : '') || osHomedir()
    const expanded = expandTilde(raw)
    const base = expanded.startsWith('/') ? expanded : pathResolve(expanded)

    // Restrict browsing to home directory and repos root to prevent arbitrary filesystem traversal.
    // Use realpathSync to dereference symlinks, preventing symlink traversal attacks where a
    // symlink within an allowed root points to a directory outside it (e.g. ~/link → /etc).
    const home = osHomedir()
    const allowedRoots = [home, REPOS_ROOT]
    let resolved: string
    try {
      resolved = fsRealpathSync(base)
    } catch {
      return res.status(400).json({ error: 'Path could not be resolved (does not exist or is inaccessible)' })
    }
    if (!allowedRoots.some(root => resolved === root || resolved.startsWith(root + '/'))) {
      return res.status(403).json({ error: 'Path is outside allowed directories' })
    }

    if (!fsExistsSync(base) || !fsStatSync(base).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' })
    }

    try {
      const entries = fsReaddirSync(base, { withFileTypes: true })
        .filter(d => {
          if (d.name.startsWith('.')) return false
          if (d.isDirectory()) return true
          // Follow symlinks to check if they point to a directory
          if (d.isSymbolicLink()) {
            try { return fsStatSync(pathJoin(base, d.name)).isDirectory() } catch { return false }
          }
          return false
        })
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
      res.json({ path: base, dirs: entries })
    } catch {
      res.status(400).json({ error: 'Cannot read directory' })
    }
  })

  // --- Repo-level approval rules ---

  router.get('/api/approvals', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const workingDir = typeof req.query.path === 'string' ? req.query.path : ''
    if (!workingDir) return res.status(400).json({ error: 'Missing path query parameter' })

    res.json(sessions.approvalManager.getApprovals(workingDir))
  })

  /** Every repo's rules in one response (the Settings → Permissions overview). */
  router.get('/api/approvals/all', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ repos: sessions.approvalManager.getAllApprovals() })
  })

  /** Approvals effective globally via cross-repo inference (approved in 2+ repos). */
  router.get('/api/approvals/global', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json(sessions.approvalManager.getGlobalApprovals())
  })

  router.delete('/api/approvals', (req: Request<Record<string, string>, unknown, ApprovalDeleteBody>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const workingDir = typeof req.query.path === 'string' ? req.query.path : ''
    if (!workingDir) return res.status(400).json({ error: 'Missing path query parameter' })

    const { tool, command, pattern, items } = req.body

    // Bulk delete
    if (Array.isArray(items) && items.length > 0) {
      let removedCount = 0
      for (const item of items) {
        const result = sessions.approvalManager.removeApproval(workingDir, item, true)
        if (result === true) removedCount++
      }
      if (removedCount > 0) sessions.approvalManager.persistRepoApprovals()
      return res.json({ success: true, removed: removedCount })
    }

    // Single delete
    const result = sessions.approvalManager.removeApproval(workingDir, { tool, command, pattern })
    if (result === 'invalid') return res.status(400).json({ error: 'Provide a non-empty tool, command, or pattern' })
    res.json({ success: true, removed: result })
  })

  // --- Hook endpoints (called by Claude CLI hooks) ---

  // Hook decision endpoint (PreToolUse hook via HttpTransport)
  router.post('/api/hook-decision', async (req: Request<Record<string, string>, unknown, HookDecisionBody>, res) => {
    const token = extractToken(req)
    const { sessionId, toolName, toolInput } = req.body
    if (!verifyHookToken(token, sessionId)) return res.status(401).json({ error: 'Unauthorized' })
    if (!sessionId || !toolName) {
      return res.status(400).json({ error: 'Missing sessionId or toolName' })
    }

    try {
      console.log(`[hook-decision] received: session=${sessionId} tool=${toolName}`)
      const result = await sessions.requestToolApproval(sessionId, toolName, toolInput || {})
      console.log(`[hook-decision] resolved: allow=${result.allow} always=${result.always}`)

      const response: { allow: boolean; message?: string; updatedPermissions?: Array<{ type: string; tool: string }>; updatedInput?: Record<string, unknown> } = {
        allow: result.allow,
      }
      // AskUserQuestion: return the user's answers as updatedInput so the
      // PreToolUse hook can inject them into the tool input.
      // The tool expects `answers: Record<string, string>` keyed by question text.
      // The UI sends either a JSON answers map (multi-question) or a plain string.
      if (toolName === 'AskUserQuestion' && result.allow && result.answer !== undefined) {
        const inputObj = toolInput ?? {}
        const questions = inputObj.questions as Array<{ question: string }> | undefined
        let answers: Record<string, string> = {}
        try {
          const parsed: unknown = JSON.parse(result.answer)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            answers = parsed as Record<string, string>
          } else if (Array.isArray(questions) && questions.length > 0) {
            answers[questions[0].question] = result.answer
          }
        } catch {
          // Plain string — map to first question
          if (Array.isArray(questions) && questions.length > 0) {
            answers[questions[0].question] = result.answer
          }
        }
        response.updatedInput = { ...(toolInput || {}), answers }
      }
      // For denied tools (e.g. ExitPlanMode rejection), pass the reason back
      // so the hook can include it as permissionDecisionReason for Claude.
      if (!result.allow && result.answer && toolName !== 'AskUserQuestion') {
        response.message = result.answer
      }
      if (result.always && result.allow) {
        const nativePerm = toNativePermission(toolName, toolInput || {})
        if (nativePerm) {
          response.updatedPermissions = [{ type: 'toolAlwaysAllow', tool: nativePerm }]
        }
      }
      res.json(response)
    } catch (err) {
      console.error(`[hook-decision] error:`, err)
      res.json({ allow: false })
    }
  })

  // Hook notification endpoint (Notification hook via HttpTransport)
  router.post('/api/hook-notify', (req: Request<Record<string, string>, unknown, HookNotifyBody>, res) => {
    const token = extractToken(req)
    const { sessionId, notificationType, title, message } = req.body
    if (!verifyHookToken(token, sessionId)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' })
    }

    console.log(`[hook-notify] session=${sessionId} type=${notificationType} title=${title}`)
    const session = sessions.get(sessionId)
    if (session) {
      if (notificationType === 'hook_denial') {
        const toolName = req.body.toolName || ''
        const toolInput = req.body.toolInput || {}
        const suggestion = buildAccessSuggestion(toolName, toolInput)
        const text = `\u26A0 ${title}: ${message}${suggestion ? `\n${suggestion}` : ''}`
        const msg: WsServerMessage = { type: 'system_message', subtype: 'error', text }
        sessions.addToHistory(session, msg)
        sessions.broadcast(session, msg)
      } else {
        const text = title ? `${title}: ${message}` : (message || 'Notification')
        const msg: WsServerMessage = { type: 'system_message', subtype: 'notification', text }
        sessions.addToHistory(session, msg)
        sessions.broadcast(session, msg)
      }
    }
    res.json({ ok: true })
  })

  // Auth validation endpoint (PermissionRequest hook for webhook sessions)
  router.post('/api/auth/validate', (req: Request<Record<string, string>, unknown, AuthValidateBody>, res) => {
    const token = extractToken(req)
    const { sessionId } = req.body
    if (!verifyHookToken(token, sessionId)) {
      return res.status(401).json({ valid: false, error: 'Invalid token' })
    }
    res.json({ valid: true })
  })

  return router
}

/** CLIs where the subcommand matters for pattern scoping (e.g. "git push *" not "git *"). */
const KNOWN_TWO_TOKEN_CLIS = new Set(['git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker'])

/** Generate an actionable suggestion for how to grant access after a hook denial. */
function buildAccessSuggestion(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '')
    const tokens = cmd.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return ''
    const twoToken = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : ''
    const prefix = KNOWN_TWO_TOKEN_CLIS.has(tokens[0]) && twoToken ? twoToken : tokens[0]
    return [
      `Use the Approvals panel to add "${prefix} *" as a pattern for this repo.`,
      `If approvals aren't appearing, check that the Codekin server is reachable.`,
    ].join('\n')
  }

  if (['Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent'].includes(toolName)) {
    return `To allow ${toolName} in future, run on your machine:\n\`claude config add allowedTools "${toolName}"\``
  }

  return ''
}
