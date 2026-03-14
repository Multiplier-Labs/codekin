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
} from 'fs'
import { resolve as pathResolve, join as pathJoin } from 'path'
import { homedir as osHomedir } from 'os'
import type { SessionManager } from './session-manager.js'
import type { WsServerMessage } from './types.js'

/** Expand leading ~ to the user's home directory. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return pathJoin(osHomedir(), p.slice(1))
  return p
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

  router.get('/api/sessions/list', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ sessions: sessions.list() })
  })

  router.post('/api/sessions/create', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { name, workingDir } = req.body
    if (!name || !workingDir) {
      return res.status(400).json({ error: 'Missing name or workingDir' })
    }

    const session = sessions.create(name, workingDir)
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

  router.patch('/api/sessions/:id/rename', (req, res) => {
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

  router.put('/api/settings/retention', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { days } = req.body
    if (typeof days !== 'number' || days < 1) {
      return res.status(400).json({ error: 'days must be a number >= 1' })
    }
    sessions.archive.setRetentionDays(days)
    res.json({ days: sessions.archive.getRetentionDays() })
  })

  // --- Repos path settings ---

  router.get('/api/settings/repos-path', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const path = sessions.archive.getSetting('repos_path', '')
    res.json({ path })
  })

  router.put('/api/settings/repos-path', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { path: rawPath } = req.body
    if (typeof rawPath !== 'string') {
      return res.status(400).json({ error: 'path must be a string' })
    }
    const trimmed = rawPath.trim()
    // Empty string means "use default REPOS_ROOT"
    if (trimmed) {
      const expanded = expandTilde(trimmed)
      if (!fsExistsSync(expanded) || !fsStatSync(expanded).isDirectory()) {
        return res.status(400).json({ error: 'Path does not exist or is not a directory' })
      }
    }
    sessions.archive.setSetting('repos_path', trimmed)
    res.json({ path: trimmed })
  })

  // --- Browse directories (for folder picker) ---

  router.get('/api/browse-dirs', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const raw = (typeof req.query.path === 'string' ? req.query.path : '') || osHomedir()
    const expanded = expandTilde(raw)
    const base = expanded.startsWith('/') ? expanded : pathResolve(expanded)

    if (!fsExistsSync(base) || !fsStatSync(base).isDirectory()) {
      return res.status(400).json({ error: 'Path does not exist or is not a directory' })
    }

    try {
      const entries = fsReaddirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
      res.json({ path: base, dirs: entries })
    } catch {
      res.status(400).json({ error: 'Cannot read directory' })
    }
  })

  // --- Support provider settings ---

  router.get('/api/settings/support-provider', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const available: string[] = []
    if (process.env.GROQ_API_KEY) available.push('groq')
    if (process.env.OPENAI_API_KEY) available.push('openai')
    if (process.env.GEMINI_API_KEY) available.push('gemini')
    if (process.env.ANTHROPIC_API_KEY) available.push('anthropic')

    const preferred = sessions.archive.getSetting('support_provider', 'auto')
    res.json({ preferred, available })
  })

  router.put('/api/settings/support-provider', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    const { provider } = req.body
    const valid = ['auto', 'groq', 'openai', 'gemini', 'anthropic']
    if (!valid.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${valid.join(', ')}` })
    }
    sessions.archive.setSetting('support_provider', provider)
    res.json({ preferred: provider })
  })

  // --- Repo-level approval rules ---

  router.get('/api/approvals', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const workingDir = typeof req.query.path === 'string' ? req.query.path : ''
    if (!workingDir) return res.status(400).json({ error: 'Missing path query parameter' })

    res.json(sessions.getApprovals(workingDir))
  })

  /** Approvals effective globally via cross-repo inference (approved in 2+ repos). */
  router.get('/api/approvals/global', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json(sessions.getGlobalApprovals())
  })

  router.delete('/api/approvals', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const workingDir = typeof req.query.path === 'string' ? req.query.path : ''
    if (!workingDir) return res.status(400).json({ error: 'Missing path query parameter' })

    const { tool, command, pattern, items } = req.body

    // Bulk delete
    if (Array.isArray(items) && items.length > 0) {
      let removedCount = 0
      for (const item of items) {
        const result = sessions.removeApproval(workingDir, item, true)
        if (result === true) removedCount++
      }
      if (removedCount > 0) sessions.persistRepoApprovals()
      return res.json({ success: true, removed: removedCount })
    }

    // Single delete
    const result = sessions.removeApproval(workingDir, { tool, command, pattern })
    if (result === 'invalid') return res.status(400).json({ error: 'Provide a non-empty tool, command, or pattern' })
    res.json({ success: true, removed: result })
  })

  // --- Hook endpoints (called by Claude CLI hooks) ---

  // Tool approval endpoint (legacy PreToolUse hook path)
  router.post('/api/tool-approval', async (req, res) => {
    const token = extractToken(req)
    const { sessionId, toolName, toolInput } = req.body
    if (!verifyHookToken(token, sessionId)) return res.status(401).json({ error: 'Unauthorized' })
    if (!sessionId || !toolName) {
      return res.status(400).json({ error: 'Missing sessionId or toolName' })
    }

    try {
      console.log(`[tool-approval-http] received: session=${sessionId} tool=${toolName}`)
      const result = await sessions.requestToolApproval(sessionId, toolName, toolInput || {})
      console.log(`[tool-approval-http] resolved: allow=${result.allow} always=${result.always}`)
      res.json({ allow: result.allow, always: result.always })
    } catch (err) {
      console.error(`[tool-approval-http] error:`, err)
      res.json({ allow: false, always: false })
    }
  })

  // Hook decision endpoint (PermissionRequest hook via HttpTransport)
  router.post('/api/hook-decision', async (req, res) => {
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

      const response: { allow: boolean; message?: string; updatedPermissions?: Array<{ type: string; tool: string }> } = {
        allow: result.allow,
      }
      if (result.always && result.allow) {
        response.updatedPermissions = [{ type: 'toolAlwaysAllow', tool: toolName }]
      }
      res.json(response)
    } catch (err) {
      console.error(`[hook-decision] error:`, err)
      res.json({ allow: false })
    }
  })

  // Hook notification endpoint (Notification hook via HttpTransport)
  router.post('/api/hook-notify', (req, res) => {
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
  router.post('/api/auth/validate', (req, res) => {
    const token = extractToken(req)
    const { sessionId } = req.body || {}
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
