/**
 * REST routes for session management, approvals, settings, and hook endpoints.
 *
 * Mounted at the Express app root (routes carry their own /api/ prefixes).
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { SessionManager } from './session-manager.js'
import type { WsServerMessage } from './types.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createSessionRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
): Router {
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
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { sessionId, toolName, toolInput } = req.body
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
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { sessionId, toolName, toolInput } = req.body
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
    const { sessionId, notificationType, title, message } = req.body
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' })
    }

    console.log(`[hook-notify] session=${sessionId} type=${notificationType} title=${title}`)
    const session = sessions.get(sessionId)
    if (session) {
      const text = title ? `${title}: ${message}` : (message || 'Notification')
      const msg: WsServerMessage = { type: 'system_message', subtype: 'notification', text }
      sessions.addToHistory(session, msg)
      sessions.broadcast(session, msg)
    }
    res.json({ ok: true })
  })

  // Auth validation endpoint (PermissionRequest hook for webhook sessions)
  router.post('/api/auth/validate', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      return res.status(401).json({ valid: false, error: 'Invalid token' })
    }
    res.json({ valid: true })
  })

  return router
}
