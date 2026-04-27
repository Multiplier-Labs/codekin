/**
 * Tests for createLearningRouter — memory extraction, finding outcomes, skill
 * model, and decision history endpoints.
 *
 * The orchestrator-learning helpers are mocked so tests focus on the routing
 * layer: auth enforcement, body validation, and that the right helper is
 * invoked with the right arguments.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

const learningMocks = vi.hoisted(() => ({
  extractMemoryCandidates: vi.fn(() => [{ memoryType: 'decision', title: 't', content: 'c', scope: null, tags: [], confidence: 0.9 }]),
  smartUpsert: vi.fn(() => ({ id: 'mem-1', action: 'inserted' })),
  runAgingCycle: vi.fn(() => ({ aged: 2, expired: 1 })),
  recordFindingOutcome: vi.fn(() => 'finding-1'),
  getTriageRecommendation: vi.fn(() => ({ recommendation: 'review', confidence: 0.7 })),
  loadSkillProfile: vi.fn(() => ({ typescript: { level: 'expert' } })),
  updateSkillLevel: vi.fn(() => ({ domain: 'typescript', level: 'expert' })),
  getGuidanceStyle: vi.fn(() => ({ verbosity: 'low' })),
  recordDecision: vi.fn(() => 'dec-1'),
  assessDecisionOutcome: vi.fn(() => true),
  getPendingOutcomeAssessments: vi.fn(() => [{ id: 'dec-pending' }]),
}))

vi.mock('./orchestrator-learning.js', () => learningMocks)

import { createLearningRouter } from './orchestrator-learning-router.js'
import type { OrchestratorMemory } from './orchestrator-memory.js'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const verifyAuth = vi.fn((_req: Request) => true)

async function startApp(router: express.Router): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use(router)
  return await new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

const fakeMemory = {} as unknown as OrchestratorMemory

describe('createLearningRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }

  beforeEach(async () => {
    Object.values(learningMocks).forEach((m) => m.mockClear())
    verifyAuth.mockClear()
    verifyAuth.mockReturnValue(true)
    const router = createLearningRouter(verifyAuth, fakeMemory)
    server = await startApp(router)
  })

  afterEach(async () => {
    await server.close()
  })

  // -------------------------------------------------------------------------
  // POST /api/orchestrator/memory/extract
  // -------------------------------------------------------------------------

  describe('POST /api/orchestrator/memory/extract', () => {
    it('returns 401 when auth fails', async () => {
      verifyAuth.mockReturnValueOnce(false)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'u', assistantResponse: 'a' }),
      })
      expect(res.status).toBe(401)
    })

    it('returns 400 when userMessage or assistantResponse is missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'u' }),
      })
      expect(res.status).toBe(400)
    })

    it('extracts candidates and upserts them', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: 'I prefer TypeScript',
          assistantResponse: 'OK noted',
          repo: '/repo',
          sourceRef: 'session-x',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.candidates).toBe(1)
      expect(body.results).toHaveLength(1)
      expect(learningMocks.extractMemoryCandidates).toHaveBeenCalledWith('I prefer TypeScript', 'OK noted', '/repo')
      expect(learningMocks.smartUpsert).toHaveBeenCalledWith(fakeMemory, expect.any(Object), 'session-x')
    })

    it('passes null repo and sourceRef when they are omitted', async () => {
      await fetch(`${server.baseUrl}/api/orchestrator/memory/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: 'u', assistantResponse: 'a' }),
      })
      expect(learningMocks.extractMemoryCandidates).toHaveBeenCalledWith('u', 'a', null)
      expect(learningMocks.smartUpsert).toHaveBeenCalledWith(fakeMemory, expect.any(Object), null)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/orchestrator/memory/age
  // -------------------------------------------------------------------------

  describe('POST /api/orchestrator/memory/age', () => {
    it('returns 401 when auth fails', async () => {
      verifyAuth.mockReturnValueOnce(false)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory/age`, { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('runs the aging cycle and returns its result', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory/age`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ aged: 2, expired: 1 })
      expect(learningMocks.runAgingCycle).toHaveBeenCalledWith(fakeMemory)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/orchestrator/findings/outcome
  // -------------------------------------------------------------------------

  describe('POST /api/orchestrator/findings/outcome', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/findings/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId: 'f', repo: 'r' }), // missing category + action
      })
      expect(res.status).toBe(400)
    })

    it('records the outcome with sensible defaults for severity, reason, sessionId, outcome', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/findings/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          findingId: 'f-1',
          repo: '/repo/foo',
          category: 'security',
          action: 'implemented',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('finding-1')
      expect(learningMocks.recordFindingOutcome).toHaveBeenCalledWith(
        fakeMemory,
        expect.objectContaining({
          findingId: 'f-1',
          repo: '/repo/foo',
          category: 'security',
          severity: 'medium',
          action: 'implemented',
          reason: '',
          sessionId: null,
          outcome: null,
        }),
      )
    })

    it('passes through provided severity, reason, sessionId, outcome', async () => {
      await fetch(`${server.baseUrl}/api/orchestrator/findings/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          findingId: 'f-2',
          repo: '/repo/foo',
          category: 'security',
          severity: 'high',
          action: 'skipped',
          reason: 'low priority',
          sessionId: 'sess-99',
          outcome: 'success',
        }),
      })
      expect(learningMocks.recordFindingOutcome).toHaveBeenCalledWith(
        fakeMemory,
        expect.objectContaining({
          severity: 'high',
          reason: 'low priority',
          sessionId: 'sess-99',
          outcome: 'success',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/orchestrator/findings/recommend
  // -------------------------------------------------------------------------

  describe('GET /api/orchestrator/findings/recommend', () => {
    it('returns 400 when category is missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/findings/recommend`)
      expect(res.status).toBe(400)
    })

    it('returns the triage recommendation with default severity=medium', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/findings/recommend?category=security`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ recommendation: 'review', confidence: 0.7 })
      expect(learningMocks.getTriageRecommendation).toHaveBeenCalledWith(fakeMemory, 'security', 'medium', null)
    })

    it('uses provided severity and repo', async () => {
      await fetch(`${server.baseUrl}/api/orchestrator/findings/recommend?category=security&severity=critical&repo=/r/foo`)
      expect(learningMocks.getTriageRecommendation).toHaveBeenCalledWith(fakeMemory, 'security', 'critical', '/r/foo')
    })
  })

  // -------------------------------------------------------------------------
  // GET / POST /api/orchestrator/skills
  // -------------------------------------------------------------------------

  describe('skill model', () => {
    it('GET returns the profile and guidance style', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.profile).toEqual({ typescript: { level: 'expert' } })
      expect(body.guidanceStyle).toEqual({ verbosity: 'low' })
    })

    it('POST returns 400 when fields are missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'typescript' }),
      })
      expect(res.status).toBe(400)
    })

    it('POST updates the skill level and returns guidance style', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'typescript', signal: 'used Generics correctly', level: 'expert' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.skill).toEqual({ domain: 'typescript', level: 'expert' })
      expect(body.guidanceStyle).toEqual({ verbosity: 'low' })
      expect(learningMocks.updateSkillLevel).toHaveBeenCalledWith('typescript', 'used Generics correctly', 'expert')
    })
  })

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  describe('decision history', () => {
    it('POST /decisions returns 400 when fields are missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'pick X' }),
      })
      expect(res.status).toBe(400)
    })

    it('POST /decisions records and returns the new id', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'pick X',
          rationale: 'because',
          repo: '/r/foo',
          relatedFinding: 'f-1',
          expectedOutcome: 'all green',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('dec-1')
      expect(learningMocks.recordDecision).toHaveBeenCalledWith(fakeMemory, expect.objectContaining({
        decision: 'pick X',
        rationale: 'because',
        repo: '/r/foo',
        relatedFinding: 'f-1',
        expectedOutcome: 'all green',
      }))
    })

    it('POST /decisions/:id/assess returns 400 when actualOutcome missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/decisions/dec-1/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('POST /decisions/:id/assess delegates to assessDecisionOutcome', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/decisions/dec-1/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualOutcome: 'all green' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.updated).toBe(true)
      expect(learningMocks.assessDecisionOutcome).toHaveBeenCalledWith(fakeMemory, 'dec-1', 'all green')
    })

    it('GET /decisions/pending returns the pending list', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/decisions/pending`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.decisions).toEqual([{ id: 'dec-pending' }])
    })
  })

  // -------------------------------------------------------------------------
  // Auth blanket
  // -------------------------------------------------------------------------

  it('every endpoint enforces verifyOrchestratorAuth', async () => {
    verifyAuth.mockReturnValue(false)
    const endpoints: Array<[string, string, unknown?]> = [
      ['POST', '/api/orchestrator/memory/extract', { userMessage: 'u', assistantResponse: 'a' }],
      ['POST', '/api/orchestrator/memory/age'],
      ['POST', '/api/orchestrator/findings/outcome', { findingId: 'f', repo: 'r', category: 'c', action: 'implemented' }],
      ['GET', '/api/orchestrator/findings/recommend?category=security'],
      ['GET', '/api/orchestrator/skills'],
      ['POST', '/api/orchestrator/skills', { domain: 'a', signal: 'b', level: 'expert' }],
      ['POST', '/api/orchestrator/decisions', { decision: 'd', rationale: 'r' }],
      ['POST', '/api/orchestrator/decisions/x/assess', { actualOutcome: 'y' }],
      ['GET', '/api/orchestrator/decisions/pending'],
    ]
    for (const [method, path, body] of endpoints) {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})
