/**
 * Session lifecycle, child session management, reports, and dashboard routes
 * for the orchestrator.
 */

import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import { resolve } from 'path'
import { existsSync, statSync, realpathSync } from 'fs'
import type { SessionManager } from './session-manager.js'
import { ensureOrchestratorRunning, getOrchestratorSessionId, getOrCreateOrchestratorId } from './orchestrator-manager.js'
import { getAgentDisplayName, REPOS_ROOT, resolveRepoPathInRoot } from './config.js'
import { scanRepoReports, readReport, getReportsSince } from './orchestrator-reports.js'
import type { OrchestratorMemory } from './orchestrator-memory.js'
import type { OrchestratorChildManager } from './orchestrator-children.js'
import type { OrchestratorMonitor } from './orchestrator-monitor.js'

// ---------------------------------------------------------------------------
// Per-IP rate limiter for child-session spawn (mirrors auth-routes pattern).
// Each spawn allocates a real subprocess, so we cap aggressively per IP and
// hard-cap the tracking map to bound memory under DoS conditions.
// ---------------------------------------------------------------------------

/** Maximum tracked IPs in the spawn rate-limiter map (matches PR #418 cap). */
const SPAWN_RATE_MAP_MAX_SIZE = 10_000

function createSpawnRateLimiter(maxRequests: number, windowMs: number): RequestHandler {
  const ipTimestamps = new Map<string, number[]>()

  // Periodic cleanup of stale entries to bound memory growth.
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [ip, timestamps] of ipTimestamps) {
      const recent = timestamps.filter(t => now - t < windowMs)
      if (recent.length === 0) ipTimestamps.delete(ip)
      else ipTimestamps.set(ip, recent)
    }
  }, Math.max(60_000, windowMs))
  if (cleanup.unref) cleanup.unref()

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const timestamps = (ipTimestamps.get(ip) ?? []).filter(t => now - t < windowMs)

    if (timestamps.length >= maxRequests) {
      ipTimestamps.set(ip, timestamps)
      return res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil(windowMs / 1000) })
    }

    // Reject new IPs once the map is full (DoS protection, matches PR #418).
    if (timestamps.length === 0 && ipTimestamps.size >= SPAWN_RATE_MAP_MAX_SIZE) {
      return res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil(windowMs / 1000) })
    }

    timestamps.push(now)
    ipTimestamps.set(ip, timestamps)
    next()
  }
}

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

interface SpawnChildBody {
  repo: string
  task: string
  branchName: string
  completionPolicy?: 'pr' | 'merge' | 'commit-only'
  deployAfter?: boolean
  useWorktree?: boolean
  model?: string
  allowedTools?: string[]
  timeoutMs?: number
}

interface SessionRespondBody {
  requestId?: string
  value: string
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSessionRouter(
  verifyOrchestratorAuth: (req: Request) => boolean,
  sessions: SessionManager,
  memory: OrchestratorMemory,
  children: OrchestratorChildManager,
  monitorRef?: { current: OrchestratorMonitor | null },
): Router {
  const router = Router()
  // 20 spawns per 5 minutes per IP — child sessions allocate real subprocesses,
  // so this is intentionally tight. Tune via the constants if needed.
  const spawnRateLimiter = createSpawnRateLimiter(20, 5 * 60_000)

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Get orchestrator session status. */
  router.get('/api/orchestrator/status', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = getOrchestratorSessionId(sessions)
    if (!sessionId) {
      return res.json({ sessionId: null, status: 'stopped', agentName: getAgentDisplayName() })
    }

    const session = sessions.get(sessionId)
    const status = session?.claudeProcess?.isAlive() ? 'active' : 'idle'
    res.json({
      sessionId,
      status,
      childSessions: children.activeCount(),
      agentName: getAgentDisplayName(),
    })
  })

  /** Ensure orchestrator is running and return its session ID. */
  router.post('/api/orchestrator/start', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const sessionId = ensureOrchestratorRunning(sessions)
      res.json({ sessionId, status: 'active', agentName: getAgentDisplayName() })
    } catch (err) {
      console.error('[orchestrator] Failed to start:', err)
      res.status(500).json({ error: `Failed to start Agent ${getAgentDisplayName()}` })
    }
  })

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** Scan reports for a single repo. */
  router.get('/api/orchestrator/reports', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const repoPath = req.query.repo as string | undefined
    const since = req.query.since as string | undefined

    if (repoPath) {
      const resolvedRepoPath = resolveRepoPathInRoot(repoPath)
      if (!resolvedRepoPath) {
        return res.status(400).json({ error: 'Invalid repo path: must be an existing directory under the configured repos root' })
      }
      const reports = scanRepoReports(resolvedRepoPath)
      res.json({ reports })
    } else if (since) {
      const repoItems = memory.list({ memoryType: 'repo_context' })
      const repoPaths = repoItems.map(r => r.scope).filter((s): s is string => !!s)
      const reports = getReportsSince(repoPaths, since)
      res.json({ reports })
    } else {
      res.status(400).json({ error: 'Provide ?repo=<path> or ?since=<YYYY-MM-DD>' })
    }
  })

  /** Read a specific report's content. */
  router.get('/api/orchestrator/reports/read', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const filePath = req.query.path as string | undefined
    if (!filePath) return res.status(400).json({ error: 'Provide ?path=<filePath>' })

    const report = readReport(filePath)
    if (!report) return res.status(404).json({ error: 'Report not found' })

    res.json({ report })
  })

  // -------------------------------------------------------------------------
  // Child sessions
  // -------------------------------------------------------------------------

  /** List child sessions. */
  router.get('/api/orchestrator/children', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ children: children.list() })
  })

  /** Spawn a child session. */
  router.post('/api/orchestrator/children', spawnRateLimiter, async (req: Request<Record<string, string>, unknown, SpawnChildBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { repo, task, branchName, completionPolicy, deployAfter, useWorktree, model, allowedTools, timeoutMs } = req.body
    if (!repo || !task || !branchName) {
      return res.status(400).json({ error: 'Missing required fields: repo, task, branchName' })
    }

    // Validate timeoutMs if provided: 1 minute to 4 hours
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 14_400_000) {
        return res.status(400).json({ error: 'Invalid timeoutMs: must be a number between 60000 (1m) and 14400000 (4h)' })
      }
    }

    // Validate branchName to prevent prompt injection
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branchName)) {
      return res.status(400).json({ error: 'Invalid branchName: only alphanumeric, /, _, ., and - are allowed' })
    }

    // Validate allowedTools if provided: must be an array of strings
    if (allowedTools !== undefined) {
      if (!Array.isArray(allowedTools) || !allowedTools.every((t: unknown) => typeof t === 'string')) {
        return res.status(400).json({ error: 'Invalid allowedTools: must be an array of strings' })
      }
    }

    // Validate repo path: must exist and be a directory
    const absRepo = resolve(repo)
    if (!existsSync(absRepo) || !statSync(absRepo).isDirectory()) {
      return res.status(400).json({ error: 'Invalid repo path: directory does not exist' })
    }
    // Use realpathSync to resolve symlinks before boundary check (prevents symlink bypass)
    const resolvedRepo = realpathSync(absRepo)
    if (!resolvedRepo.startsWith(REPOS_ROOT + '/') && resolvedRepo !== REPOS_ROOT) {
      return res.status(400).json({ error: 'Invalid repo path: must be under configured repos root' })
    }

    try {
      const child = await children.spawn({
        repo,
        task,
        branchName,
        completionPolicy: completionPolicy ?? 'pr',
        deployAfter: deployAfter ?? false,
        useWorktree: useWorktree ?? true,
        model,
        allowedTools,
        timeoutMs,
        // Stamp the orchestrator (parent) session ID so the child can push
        // a terminal-state notification back to it without a 30-min poll.
        parentSessionId: getOrCreateOrchestratorId(),
      })
      res.json({ child })
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Failed to spawn child session' })
    }
  })

  /** Get a specific child session. */
  router.get('/api/orchestrator/children/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const child = children.get(req.params.id)
    if (!child) return res.status(404).json({ error: 'Child session not found' })

    res.json({ child })
  })

  /**
   * Get the tail of a child session's transcript (Claude output only).
   * Lets the orchestrator inspect what a child actually did — e.g. when a
   * child stops with "Completion not verified" or gets stuck — without
   * attaching to the session. `?limit` caps the returned characters
   * (default 5000, max 50000).
   */
  router.get('/api/orchestrator/children/:id/transcript', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const child = children.get(req.params.id)
    if (!child) return res.status(404).json({ error: 'Child session not found' })

    const session = sessions.get(child.id)
    if (!session) {
      return res.status(404).json({ error: 'Session no longer exists (it may have been deleted)' })
    }

    const rawLimit = Number(req.query.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50_000) : 5_000

    const full = session.outputHistory
      .filter((m): m is { type: 'output'; data: string } => m.type === 'output')
      .map(m => m.data)
      .join('')
    const truncated = full.length > limit
    res.json({
      childId: child.id,
      status: child.status,
      transcript: truncated ? full.slice(-limit) : full,
      truncated,
      totalLength: full.length,
    })
  })

  // -------------------------------------------------------------------------
  // Session prompts & approvals
  // -------------------------------------------------------------------------

  /** Get all sessions with pending prompts (waiting for approval or answer). */
  router.get('/api/orchestrator/sessions/pending-prompts', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ sessions: sessions.getPendingPrompts() })
  })

  /** Approve or deny a pending prompt in any session. */
  router.post('/api/orchestrator/sessions/:id/respond', (req: Request<{ id: string }, unknown, SessionRespondBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = req.params.id
    const { requestId, value } = req.body
    if (!value) {
      return res.status(400).json({ error: 'Missing required field: value (e.g. "allow", "deny", or answer text)' })
    }

    const session = sessions.get(sessionId)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Verify there's actually a pending prompt (optionally for the specific requestId)
    const hasPending = requestId
      ? (session.pendingToolApprovals.has(requestId) || session.pendingControlRequests.has(requestId))
      : (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0)

    if (!hasPending) {
      return res.status(409).json({ error: 'No pending prompt to respond to' })
    }

    // Capture prompt details before responding (response clears them)
    let promptToolName = 'unknown'
    let promptType: 'permission' | 'question' = 'permission'
    if (requestId) {
      const toolApproval = session.pendingToolApprovals.get(requestId)
      const controlReq = session.pendingControlRequests.get(requestId)
      if (toolApproval) {
        promptToolName = toolApproval.toolName
        promptType = toolApproval.toolName === 'AskUserQuestion' ? 'question' : 'permission'
      } else if (controlReq) {
        promptToolName = controlReq.toolName
        promptType = controlReq.toolName === 'AskUserQuestion' ? 'question' : 'permission'
      }
    }

    sessions.sendPromptResponse(sessionId, value, requestId)

    // Broadcast a notification to the orchestrator channel
    const orchestratorId = getOrCreateOrchestratorId()
    const orchestratorSession = sessions.get(orchestratorId)
    if (orchestratorSession && orchestratorSession.clients.size > 0) {
      const actionLabel = promptType === 'question'
        ? `answered question from ${promptToolName}`
        : `responded "${value}" to ${promptToolName}`
      const notifMsg = {
        type: 'system_message' as const,
        subtype: 'info' as const,
        text: `[${getAgentDisplayName()}] ${actionLabel} in session "${session.name}"`,
      }
      for (const ws of orchestratorSession.clients) {
        ws.send(JSON.stringify(notifMsg))
      }
    }

    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Session cleanup & listing
  // -------------------------------------------------------------------------

  /** List all sessions (unfiltered, includes source field). */
  router.get('/api/orchestrator/sessions', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ sessions: sessions.listAll() })
  })

  /** Delete all automated sessions (source: workflow, webhook, stepflow, agent). */
  router.delete('/api/orchestrator/sessions/cleanup', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const automatedSources = new Set(['workflow', 'webhook', 'stepflow', 'agent'])
    const toDelete = sessions.listAll().filter((s) => automatedSources.has(s.source ?? ''))

    let deleted = 0
    for (const s of toDelete) {
      if (sessions.delete(s.id)) deleted++
    }

    res.json({ deleted })
  })

  /** Delete a specific session by ID. */
  router.delete('/api/orchestrator/sessions/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const success = sessions.delete(req.params.id)
    if (!success) return res.status(404).json({ error: 'Session not found' })

    res.json({ deleted: true })
  })

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  /** Get summary stats for the dashboard header. */
  router.get('/api/orchestrator/dashboard', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const repoItems = memory.list({ memoryType: 'repo_context' })
    const pendingNotifications = monitorRef?.current?.getPending() ?? []
    const activeChildren = children.activeCount()
    const trustRecords = memory.listTrustRecords()
    const autoApproved = trustRecords.filter(t => t.effectiveLevel !== 'ask').length

    res.json({
      stats: {
        managedRepos: repoItems.length,
        pendingNotifications: pendingNotifications.length,
        activeChildSessions: activeChildren,
        totalChildSessions: children.list().length,
        trustRecords: trustRecords.length,
        autoApprovedActions: autoApproved,
        memoryItems: memory.list().length,
      },
    })
  })

  return router
}
