/**
 * Session lifecycle, child session management, reports, and dashboard routes
 * for the orchestrator.
 */

import { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { resolve } from 'path'
import { existsSync, statSync, realpathSync } from 'fs'
import { AGENT_PROVIDERS } from './types.js'
import type { CodingProvider } from './coding-process.js'
import type { SessionManager } from './session-manager.js'
import { ensureOrchestratorRunning, getOrchestratorSessionId, getOrCreateOrchestratorId, getOrchestratorProvider, setOrchestratorProvider } from './orchestrator-manager.js'
import { getAgentDisplayName, REPOS_ROOT, resolveRepoPathInRoot } from './config.js'
import { readReport, getReportsSince } from './orchestrator-reports.js'
import { loadWorkflowConfig } from './workflow-config.js'
import type { OrchestratorMemory } from './orchestrator-memory.js'
import { ChildControlError, isTerminalChildStatus, type OrchestratorChildManager } from './orchestrator-children.js'
import type { OrchestratorMonitor } from './orchestrator-monitor.js'
import { TaskActionError, type OrchestratorTaskService } from './orchestrator-tasks.js'

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
  /** Not supported — rejected when true rather than silently ignored. */
  deployAfter?: boolean
  useWorktree?: boolean
  provider?: CodingProvider
  model?: string
  allowedTools?: string[]
  timeoutMs?: number
  /** Joe task this child works on (see docs/JOE-TASKS-SPEC.md). */
  taskId?: string
}

interface SessionRespondBody {
  requestId?: string
  /** Answer text, "allow"/"deny", or one entry per question for multi-question prompts. */
  value: string | string[]
}

/** Map a child-control failure onto an HTTP response. */
function sendControlError(res: Response, err: unknown): void {
  if (err instanceof ChildControlError) {
    res.status(err.status).json({ error: err.message })
  } else {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Child control failed' })
  }
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
  tasks?: OrchestratorTaskService,
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
      return res.json({ sessionId: null, status: 'stopped', provider: getOrchestratorProvider(sessions), agentName: getAgentDisplayName() })
    }

    const session = sessions.get(sessionId)
    const status = session?.claudeProcess?.isAlive() ? 'active' : 'idle'
    res.json({
      sessionId,
      status,
      provider: getOrchestratorProvider(sessions),
      childSessions: children.activeCount(),
      agentName: getAgentDisplayName(),
    })
  })

  /** Ensure orchestrator is running and return its session ID. */
  router.post('/api/orchestrator/start', async (req: Request<Record<string, string>, unknown, { provider?: CodingProvider }>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const provider = req.body?.provider
    if (provider !== undefined && !AGENT_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: 'Invalid provider: choose claude, codex, or opencode' })
    }
    if (provider === undefined && !getOrchestratorProvider(sessions)) {
      return res.status(409).json({ error: 'Choose an agent harness for Joe before starting' })
    }
    try {
      if (provider !== undefined) {
        setOrchestratorProvider(sessions, provider)
        const existingId = getOrchestratorSessionId(sessions)
        if (existingId && sessions.get(existingId)?.provider !== provider) {
          // Join only after the old process has stopped and the new harness is applied.
          // Composer switches retain their separate optional context-handoff flow.
          await sessions.stopClaudeAndWait(existingId)
          sessions.setProvider(existingId, provider)
        }
      }
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

  /** Repos Joe knows about: its repo memory, configured workflow repos, and its children's repos. */
  function managedRepoPaths(): string[] {
    const paths = [
      ...memory.list({ memoryType: 'repo_context' }).map(r => r.scope),
      ...loadWorkflowConfig().reviewRepos.map(r => r.repoPath),
      ...children.list().map(c => c.request.repo),
    ]
    return [...new Set(paths.filter((p): p is string => !!p))]
      .filter(p => existsSync(p))
  }

  /**
   * List reports — for one repo (?repo=), or across every managed repo.
   * ?since=<YYYY-MM-DD> keeps only reports dated on or after that day.
   */
  router.get('/api/orchestrator/reports', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const repoPath = req.query.repo as string | undefined
    const since = req.query.since as string | undefined
    if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ error: 'Invalid since: use YYYY-MM-DD' })
    }

    let repoPaths: string[]
    if (repoPath) {
      const resolvedRepoPath = resolveRepoPathInRoot(repoPath)
      if (!resolvedRepoPath) {
        return res.status(400).json({ error: 'Invalid repo path: must be an existing directory under the configured repos root' })
      }
      repoPaths = [resolvedRepoPath]
    } else {
      repoPaths = managedRepoPaths()
    }
    res.json({ reports: getReportsSince(repoPaths, since ?? '') })
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

    const { repo, task, branchName, deployAfter, useWorktree, provider, model, allowedTools, timeoutMs, taskId } = req.body
    let { completionPolicy } = req.body
    if (!repo || !task || !branchName) {
      return res.status(400).json({ error: 'Missing required fields: repo, task, branchName' })
    }

    if (provider !== undefined && !AGENT_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: 'Invalid provider: choose claude, codex, or opencode' })
    }

    if (deployAfter === true) {
      return res.status(400).json({ error: 'deployAfter is not supported: children never deploy. Deploy separately once the change has landed.' })
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

    if (taskId !== undefined) {
      if (typeof taskId !== 'string' || !tasks) return res.status(400).json({ error: 'Invalid taskId' })
      try {
        completionPolicy ??= tasks.assertStartable(taskId, resolvedRepo).completionPolicy
      } catch (err) {
        const status = err instanceof TaskActionError ? err.status : 500
        return res.status(status).json({ error: err instanceof Error ? err.message : 'Invalid taskId' })
      }
    }

    try {
      const child = await children.spawn({
        repo,
        task,
        branchName,
        completionPolicy: completionPolicy ?? 'pr',
        useWorktree: useWorktree ?? true,
        provider,
        model,
        allowedTools,
        timeoutMs,
        taskId,
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
  // Child control — only children this orchestrator spawned
  // -------------------------------------------------------------------------

  /** Send a follow-up instruction to an active child. */
  router.post('/api/orchestrator/children/:id/input', (req: Request<{ id: string }, unknown, { text?: unknown }>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    const text = req.body?.text
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing required field: text' })
    try {
      res.json({ child: children.sendFollowUp(req.params.id, text) })
    } catch (err) { sendControlError(res, err) }
  })

  /** Stop an active child (it becomes canceled; worktree and branch are kept). */
  router.post('/api/orchestrator/children/:id/stop', (req: Request<{ id: string }>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    try {
      res.json({ child: children.stop(req.params.id) })
    } catch (err) { sendControlError(res, err) }
  })

  /** Start another supervised attempt on a finished child's session. */
  router.post('/api/orchestrator/children/:id/resume', (req: Request<{ id: string }, unknown, { instructions?: unknown }>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    const instructions = req.body?.instructions
    if (instructions !== undefined && typeof instructions !== 'string') {
      return res.status(400).json({ error: 'Invalid instructions: must be a string' })
    }
    try {
      res.json({ child: children.resume(req.params.id, instructions) })
    } catch (err) { sendControlError(res, err) }
  })

  /** Close a child: archive (default, resumable) or delete. Active children need cancel: true. */
  router.post('/api/orchestrator/children/:id/close', async (req: Request<{ id: string }, unknown, { mode?: unknown; cancel?: unknown }>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    const { mode, cancel } = req.body ?? {}
    if (mode !== undefined && mode !== 'archive' && mode !== 'delete') {
      return res.status(400).json({ error: 'Invalid mode: archive or delete' })
    }
    if (cancel !== undefined && typeof cancel !== 'boolean') {
      return res.status(400).json({ error: 'Invalid cancel: must be a boolean' })
    }
    try {
      res.json(await children.close(req.params.id, { mode, cancel }))
    } catch (err) { sendControlError(res, err) }
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
    const validValue = typeof value === 'string'
      ? value.length > 0
      : Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string')
    if (!validValue) {
      return res.status(400).json({ error: 'Missing required field: value (e.g. "allow", "deny", answer text, or one answer per question)' })
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
        : `responded "${Array.isArray(value) ? value.join(', ') : value}" to ${promptToolName}`
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

  /**
   * List all sessions (unfiltered, includes source field). `?view=summary`
   * returns one compact row per session — what it is doing, whether it waits
   * on a prompt, and whether it is one of the orchestrator's children —
   * optionally filtered by `?source=` and `?active=true` (not archived).
   */
  router.get('/api/orchestrator/sessions', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    if (req.query.view !== 'summary') return res.json({ sessions: sessions.listAll() })

    const source = typeof req.query.source === 'string' ? req.query.source : undefined
    const activeOnly = req.query.active === 'true'
    const rows = sessions.listAll()
      .filter(info => (!source || info.source === source) && (!activeOnly || !info.archivedAt))
      .map(info => {
        const session = sessions.get(info.id)
        const pendingPrompts = session ? session.pendingToolApprovals.size + session.pendingControlRequests.size : 0
        const child = info.source === 'agent' ? children.get(info.id) : null
        return {
          id: info.id,
          name: info.name,
          source: info.source,
          state: info.archivedAt ? 'archived'
            : pendingPrompts > 0 ? 'waiting_on_prompt'
            : info.isProcessing ? 'working'
            : info.active ? 'idle'
            : 'stopped',
          pendingPrompts,
          provider: info.provider ?? null,
          repo: info.groupDir ?? info.workingDir,
          branch: info.worktreeBranch ?? null,
          worktreePath: info.worktreePath ?? null,
          lastActivity: info.lastActivity,
          child: child ? { status: child.status, attempt: child.attempt, verification: child.verification?.state ?? null } : null,
        }
      })
    res.json({ sessions: rows })
  })

  /**
   * Delete finished automated sessions (source: workflow, webhook, stepflow,
   * agent). Sessions still working — mid-turn, waiting on a prompt, or a
   * child Joe is supervising — are skipped and reported, never stopped.
   * `?dryRun=true` previews the selection without deleting anything.
   * Worktrees with uncommitted work, and all branches, are kept on deletion.
   */
  router.delete('/api/orchestrator/sessions/cleanup', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const dryRun = req.query.dryRun === 'true'
    const automatedSources = new Set(['workflow', 'webhook', 'stepflow', 'agent'])
    const deleted: Array<{ id: string; name: string }> = []
    const skipped: Array<{ id: string; name: string; reason: string }> = []

    for (const info of sessions.listAll()) {
      if (!automatedSources.has(info.source ?? '')) continue
      const session = sessions.get(info.id)
      if (!session) continue
      const child = children.get(info.id)
      const reason = child && !isTerminalChildStatus(child.status)
        ? `supervised child is ${child.status}`
        : session.pendingToolApprovals.size + session.pendingControlRequests.size > 0
          ? 'waiting on a prompt'
          : session.isProcessing && session.claudeProcess?.isAlive()
            ? 'still working'
            : null
      if (reason) {
        skipped.push({ id: info.id, name: info.name, reason })
        continue
      }
      if (dryRun || sessions.delete(info.id)) deleted.push({ id: info.id, name: info.name })
    }

    res.json({ dryRun, deleted, skipped })
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
