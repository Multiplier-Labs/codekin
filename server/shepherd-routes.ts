/**
 * REST routes for the Shepherd orchestrator session.
 *
 * Provides status, start, report scanning, child session management,
 * memory querying, and trust record endpoints.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { SessionManager } from './session-manager.js'
import { ensureShepherdRunning, getShepherdSessionId } from './shepherd-manager.js'
import { scanRepoReports, readReport, getReportsSince } from './shepherd-reports.js'
import { ShepherdMemory } from './shepherd-memory.js'
import { ShepherdChildManager } from './shepherd-children.js'
import type { ShepherdMonitor } from './shepherd-monitor.js'
import {
  extractMemoryCandidates, smartUpsert, runAgingCycle,
  recordFindingOutcome, getTriageRecommendation,
  loadSkillProfile, updateSkillLevel, getGuidanceStyle,
  recordDecision, assessDecisionOutcome, getPendingOutcomeAssessments,
  type FindingOutcome,
} from './shepherd-learning.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createShepherdRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
  monitorRef?: { current: ShepherdMonitor | null },
): Router {
  const router = Router()
  const memory = new ShepherdMemory()
  const children = new ShepherdChildManager(sessions)

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Get Shepherd session status. */
  router.get('/api/shepherd/status', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = getShepherdSessionId(sessions)
    if (!sessionId) {
      return res.json({ sessionId: null, status: 'stopped' })
    }

    const session = sessions.get(sessionId)
    const status = session?.claudeProcess?.isAlive() ? 'active' : 'idle'
    res.json({
      sessionId,
      status,
      childSessions: children.activeCount(),
    })
  })

  /** Ensure Shepherd is running and return its session ID. */
  router.post('/api/shepherd/start', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const sessionId = ensureShepherdRunning(sessions)
      res.json({ sessionId, status: 'active' })
    } catch (err) {
      console.error('[shepherd] Failed to start:', err)
      res.status(500).json({ error: 'Failed to start Agent Joe' })
    }
  })

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** Scan reports for a single repo. */
  router.get('/api/shepherd/reports', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const repoPath = req.query.repo as string | undefined
    const since = req.query.since as string | undefined

    if (repoPath) {
      const reports = scanRepoReports(repoPath)
      res.json({ reports })
    } else if (since) {
      // Scan all managed repos — get paths from memory
      const repoItems = memory.list({ memoryType: 'repo_context' })
      const repoPaths = repoItems.map(r => r.scope).filter((s): s is string => !!s)
      const reports = getReportsSince(repoPaths, since)
      res.json({ reports })
    } else {
      res.status(400).json({ error: 'Provide ?repo=<path> or ?since=<YYYY-MM-DD>' })
    }
  })

  /** Read a specific report's content. */
  router.get('/api/shepherd/reports/read', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

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
  router.get('/api/shepherd/children', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ children: children.list() })
  })

  /** Spawn a child session. */
  router.post('/api/shepherd/children', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { repo, task, branchName, completionPolicy, deployAfter, useWorktree, model } = req.body
    if (!repo || !task || !branchName) {
      return res.status(400).json({ error: 'Missing required fields: repo, task, branchName' })
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
      })
      res.json({ child })
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Failed to spawn child session' })
    }
  })

  /** Get a specific child session. */
  router.get('/api/shepherd/children/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const child = children.get(req.params.id)
    if (!child) return res.status(404).json({ error: 'Child session not found' })

    res.json({ child })
  })

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  /** Search memory. */
  router.get('/api/shepherd/memory', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const query = req.query.q as string | undefined
    const type = req.query.type as string | undefined
    const limit = parseInt(req.query.limit as string || '20', 10)

    if (query) {
      const items = memory.search(query, limit)
      res.json({ items })
    } else {
      const items = memory.list({
        memoryType: type as import('./shepherd-memory.js').MemoryType | undefined,
        limit,
      })
      res.json({ items })
    }
  })

  /** Add or update a memory item. */
  router.post('/api/shepherd/memory', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { id, memoryType, scope, title, content, sourceRef, confidence, expiresAt, isPinned, tags } = req.body
    if (!memoryType || !content) {
      return res.status(400).json({ error: 'Missing required fields: memoryType, content' })
    }

    const itemId = memory.upsert({
      id,
      memoryType,
      scope: scope ?? null,
      title: title ?? null,
      content,
      sourceRef: sourceRef ?? null,
      confidence: confidence ?? 0.8,
      expiresAt: expiresAt ?? null,
      isPinned: isPinned ?? false,
      tags: tags ?? [],
    })

    res.json({ id: itemId })
  })

  /** Delete a memory item. */
  router.delete('/api/shepherd/memory/:id', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const deleted = memory.delete(req.params.id)
    res.json({ deleted })
  })

  // -------------------------------------------------------------------------
  // Trust
  // -------------------------------------------------------------------------

  /** List all trust records. */
  router.get('/api/shepherd/trust', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ records: memory.listTrustRecords() })
  })

  /** Compute trust level for an action. */
  router.get('/api/shepherd/trust/level', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, severity, repo } = req.query as Record<string, string>
    if (!action || !category) {
      return res.status(400).json({ error: 'Provide ?action=X&category=Y' })
    }

    const level = memory.computeTrustLevel(action, category, severity ?? 'medium', repo ?? null)
    res.json({ level })
  })

  /** Record an approval. */
  router.post('/api/shepherd/trust/approve', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordApproval(action, category, repo ?? null)
    res.json({ record })
  })

  /** Record a rejection (resets trust to ASK). */
  router.post('/api/shepherd/trust/reject', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordRejection(action, category, repo ?? null)
    res.json({ record })
  })

  /** Pin trust to a specific level (user override). */
  router.post('/api/shepherd/trust/pin', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo, level } = req.body
    if (!action || !category || !level) {
      return res.status(400).json({ error: 'Missing required fields: action, category, level' })
    }

    memory.pinTrust(action, category, repo ?? null, level)
    res.json({ ok: true })
  })

  /** Reset all trust records. */
  router.post('/api/shepherd/trust/reset', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    memory.resetAllTrust()
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Get pending notifications from the monitor. */
  router.get('/api/shepherd/notifications', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ notifications: [] })

    const all = req.query.all === 'true'
    res.json({ notifications: all ? monitor.getAll() : monitor.getPending() })
  })

  /** Mark notifications as delivered. */
  router.post('/api/shepherd/notifications/mark-delivered', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ ok: true })

    const { ids } = req.body
    if (Array.isArray(ids)) monitor.markDelivered(ids)
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  /** Get summary stats for the dashboard header. */
  router.get('/api/shepherd/dashboard', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

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

  // -------------------------------------------------------------------------
  // Memory extraction & learning (Phase 4)
  // -------------------------------------------------------------------------

  /** Extract memory candidates from a session interaction. */
  router.post('/api/shepherd/memory/extract', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { userMessage, assistantResponse, repo, sourceRef } = req.body
    if (!userMessage || !assistantResponse) {
      return res.status(400).json({ error: 'Missing required fields: userMessage, assistantResponse' })
    }

    const candidates = extractMemoryCandidates(userMessage, assistantResponse, repo ?? null)
    const results = candidates.map(c => smartUpsert(memory, c, sourceRef ?? null))

    res.json({ candidates: candidates.length, results })
  })

  /** Run the aging/decay cycle. */
  router.post('/api/shepherd/memory/age', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const result = runAgingCycle(memory)
    res.json(result)
  })

  // -------------------------------------------------------------------------
  // Finding outcomes & triage recommendations
  // -------------------------------------------------------------------------

  /** Record a finding outcome. */
  router.post('/api/shepherd/findings/outcome', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { findingId, repo, category, severity, action, reason, sessionId, outcome } = req.body
    if (!findingId || !repo || !category || !action) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const id = recordFindingOutcome(memory, {
      findingId, repo, category,
      severity: severity ?? 'medium',
      action, reason: reason ?? '',
      sessionId: sessionId ?? null,
      outcome: outcome ?? null,
      timestamp: new Date().toISOString(),
    } as FindingOutcome)

    res.json({ id })
  })

  /** Get triage recommendation based on historical patterns. */
  router.get('/api/shepherd/findings/recommend', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { category, severity, repo } = req.query as Record<string, string>
    if (!category) return res.status(400).json({ error: 'Provide ?category=X' })

    const recommendation = getTriageRecommendation(memory, category, severity ?? 'medium', repo ?? null)
    res.json(recommendation)
  })

  // -------------------------------------------------------------------------
  // User skill model
  // -------------------------------------------------------------------------

  /** Get the user's skill profile. */
  router.get('/api/shepherd/skills', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({
      profile: loadSkillProfile(),
      guidanceStyle: getGuidanceStyle(),
    })
  })

  /** Update a skill level based on an observed signal. */
  router.post('/api/shepherd/skills', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { domain, signal, level } = req.body
    if (!domain || !signal || !level) {
      return res.status(400).json({ error: 'Missing required fields: domain, signal, level' })
    }

    const updated = updateSkillLevel(domain, signal, level)
    res.json({ skill: updated, guidanceStyle: getGuidanceStyle() })
  })

  // -------------------------------------------------------------------------
  // Decision history
  // -------------------------------------------------------------------------

  /** Record a decision. */
  router.post('/api/shepherd/decisions', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { decision, rationale, repo, relatedFinding, expectedOutcome } = req.body
    if (!decision || !rationale) {
      return res.status(400).json({ error: 'Missing required fields: decision, rationale' })
    }

    const id = recordDecision(memory, {
      decision, rationale,
      repo: repo ?? null,
      relatedFinding: relatedFinding ?? null,
      expectedOutcome: expectedOutcome ?? '',
    })
    res.json({ id })
  })

  /** Assess a decision's outcome. */
  router.post('/api/shepherd/decisions/:id/assess', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { actualOutcome } = req.body
    if (!actualOutcome) return res.status(400).json({ error: 'Missing required field: actualOutcome' })

    const updated = assessDecisionOutcome(memory, req.params.id, actualOutcome)
    res.json({ updated })
  })

  /** Get decisions pending outcome assessment. */
  router.get('/api/shepherd/decisions/pending', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ decisions: getPendingOutcomeAssessments(memory) })
  })

  return router
}
