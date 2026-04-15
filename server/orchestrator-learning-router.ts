/**
 * Learning, finding outcomes, skill levels, and decision history routes
 * for the orchestrator.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { OrchestratorMemory } from './orchestrator-memory.js'
import {
  extractMemoryCandidates, smartUpsert, runAgingCycle,
  recordFindingOutcome, getTriageRecommendation,
  loadSkillProfile, updateSkillLevel, getGuidanceStyle,
  recordDecision, assessDecisionOutcome, getPendingOutcomeAssessments,
  type FindingOutcome,
} from './orchestrator-learning.js'

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

interface MemoryExtractBody {
  userMessage: string
  assistantResponse: string
  repo?: string | null
  sourceRef?: string | null
}

interface FindingOutcomeBody {
  findingId: string
  repo: string
  category: string
  severity?: string
  action: 'implemented' | 'skipped' | 'deferred'
  reason?: string
  sessionId?: string | null
  outcome?: 'success' | 'failure' | 'pending' | null
}

interface SkillUpdateBody {
  domain: string
  signal: string
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert'
}

interface DecisionBody {
  decision: string
  rationale: string
  repo?: string | null
  relatedFinding?: string | null
  expectedOutcome?: string
}

interface DecisionAssessBody {
  actualOutcome: string
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createLearningRouter(
  verifyOrchestratorAuth: (req: Request) => boolean,
  memory: OrchestratorMemory,
): Router {
  const router = Router()

  // -------------------------------------------------------------------------
  // Memory extraction & learning
  // -------------------------------------------------------------------------

  /** Extract memory candidates from a session interaction. */
  router.post('/api/orchestrator/memory/extract', (req: Request<Record<string, string>, unknown, MemoryExtractBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { userMessage, assistantResponse, repo, sourceRef } = req.body
    if (!userMessage || !assistantResponse) {
      return res.status(400).json({ error: 'Missing required fields: userMessage, assistantResponse' })
    }

    const candidates = extractMemoryCandidates(userMessage, assistantResponse, repo ?? null)
    const results = candidates.map(c => smartUpsert(memory, c, sourceRef ?? null))

    res.json({ candidates: candidates.length, results })
  })

  /** Run the aging/decay cycle. */
  router.post('/api/orchestrator/memory/age', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const result = runAgingCycle(memory)
    res.json(result)
  })

  // -------------------------------------------------------------------------
  // Finding outcomes & triage recommendations
  // -------------------------------------------------------------------------

  /** Record a finding outcome. */
  router.post('/api/orchestrator/findings/outcome', (req: Request<Record<string, string>, unknown, FindingOutcomeBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { findingId, repo, category, severity, action, reason, sessionId, outcome } = req.body
    if (!findingId || !repo || !category || !action) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const findingRecord: FindingOutcome = {
      findingId, repo, category,
      severity: severity ?? 'medium',
      action, reason: reason ?? '',
      sessionId: sessionId ?? null,
      outcome: outcome ?? null,
      timestamp: new Date().toISOString(),
    }
    const id = recordFindingOutcome(memory, findingRecord)

    res.json({ id })
  })

  /** Get triage recommendation based on historical patterns. */
  router.get('/api/orchestrator/findings/recommend', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { category, severity, repo } = req.query as Record<string, string>
    if (!category) return res.status(400).json({ error: 'Provide ?category=X' })

    const recommendation = getTriageRecommendation(memory, category, severity ?? 'medium', repo ?? null)
    res.json(recommendation)
  })

  // -------------------------------------------------------------------------
  // User skill model
  // -------------------------------------------------------------------------

  /** Get the user's skill profile. */
  router.get('/api/orchestrator/skills', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({
      profile: loadSkillProfile(),
      guidanceStyle: getGuidanceStyle(),
    })
  })

  /** Update a skill level based on an observed signal. */
  router.post('/api/orchestrator/skills', (req: Request<Record<string, string>, unknown, SkillUpdateBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

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
  router.post('/api/orchestrator/decisions', (req: Request<Record<string, string>, unknown, DecisionBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

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
  router.post('/api/orchestrator/decisions/:id/assess', (req: Request<{ id: string }, unknown, DecisionAssessBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { actualOutcome } = req.body
    if (!actualOutcome) return res.status(400).json({ error: 'Missing required field: actualOutcome' })

    const updated = assessDecisionOutcome(memory, req.params.id, actualOutcome)
    res.json({ updated })
  })

  /** Get decisions pending outcome assessment. */
  router.get('/api/orchestrator/decisions/pending', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ decisions: getPendingOutcomeAssessments(memory) })
  })

  return router
}
