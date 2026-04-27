/**
 * Tests for createOrchestratorRouter — the thin wrapper that mounts the
 * session, memory, and learning sub-routers and provides shared auth.
 *
 * These tests verify the wrapper's three responsibilities:
 *   1. Sub-routers are reachable through the mounted prefix.
 *   2. verifyOrchestratorAuth accepts the master token.
 *   3. verifyOrchestratorAuth accepts a session-scoped token via the
 *      verifyTokenOrSessionToken callback (PR #428 behaviour).
 *
 * All deeper route logic is exercised in the dedicated sub-router tests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

// Mock the orchestrator-manager so tests don't touch ~/.codekin
vi.mock('./orchestrator-manager.js', () => ({
  ORCHESTRATOR_DIR: '/tmp/orch-test',
  getOrCreateOrchestratorId: vi.fn(() => 'orch-session-id'),
  getOrchestratorSessionId: vi.fn(() => null),
  ensureOrchestratorRunning: vi.fn(() => 'orch-session-id'),
}))

// Mock the orchestrator-learning module — these helpers are exercised via
// the dedicated learning router test.  Here we just need them to exist.
vi.mock('./orchestrator-learning.js', () => ({
  extractMemoryCandidates: vi.fn(() => []),
  smartUpsert: vi.fn(),
  runAgingCycle: vi.fn(() => ({ aged: 0, expired: 0 })),
  recordFindingOutcome: vi.fn(() => 'finding-1'),
  getTriageRecommendation: vi.fn(() => ({ recommendation: 'review' })),
  loadSkillProfile: vi.fn(() => ({})),
  updateSkillLevel: vi.fn(() => ({})),
  getGuidanceStyle: vi.fn(() => ({})),
  recordDecision: vi.fn(() => 'dec-1'),
  assessDecisionOutcome: vi.fn(() => false),
  getPendingOutcomeAssessments: vi.fn(() => []),
}))

// Avoid pulling in real config / repos-root resolution
vi.mock('./config.js', () => ({
  REPOS_ROOT: '/tmp/repos',
  resolveRepoPathInRoot: vi.fn(() => '/tmp/repos/something'),
  getAgentDisplayName: vi.fn(() => 'Joe'),
}))

vi.mock('./orchestrator-reports.js', () => ({
  scanRepoReports: vi.fn(() => []),
  readReport: vi.fn(() => null),
  getReportsSince: vi.fn(() => []),
}))

import { createOrchestratorRouter } from './orchestrator-routes.js'
import type { SessionManager } from './session-manager.js'
import type { OrchestratorMemory } from './orchestrator-memory.js'
import type { OrchestratorChildManager } from './orchestrator-children.js'

const TOKEN = 'master-token'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: Request) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
}

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

function makeMemory(): OrchestratorMemory {
  return {
    list: vi.fn(() => []),
    search: vi.fn(() => []),
    upsert: vi.fn(() => 'mem-1'),
    delete: vi.fn(() => true),
    listTrustRecords: vi.fn(() => []),
    computeTrustLevel: vi.fn(() => 'ask'),
    recordApproval: vi.fn(() => ({})),
    recordRejection: vi.fn(() => ({})),
    pinTrust: vi.fn(),
    listNotifications: vi.fn(() => []),
  } as unknown as OrchestratorMemory
}

function makeChildren(): OrchestratorChildManager {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    activeCount: vi.fn(() => 0),
  } as unknown as OrchestratorChildManager
}

function makeSessions(): SessionManager {
  return {
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
  } as unknown as SessionManager
}

describe('createOrchestratorRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }

  afterEach(async () => {
    await server?.close()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Sub-router mounting smoke tests
  // -------------------------------------------------------------------------

  describe('sub-router mounting', () => {
    beforeEach(async () => {
      const router = createOrchestratorRouter(
        verifyToken,
        extractToken,
        makeSessions(),
        undefined,
        undefined,
        makeMemory(),
        makeChildren(),
      )
      server = await startApp(router)
    })

    it('mounts the session router (GET /api/orchestrator/status)', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.agentName).toBe('Joe')
    })

    it('mounts the memory router (GET /api/orchestrator/memory)', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/memory`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toEqual([])
    })

    it('mounts the learning router (GET /api/orchestrator/skills)', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.profile).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Auth: master token only
  // -------------------------------------------------------------------------

  describe('verifyOrchestratorAuth — master token only', () => {
    beforeEach(async () => {
      const router = createOrchestratorRouter(
        verifyToken,
        extractToken,
        makeSessions(),
        undefined,
        undefined, // no session-token verifier
        makeMemory(),
        makeChildren(),
      )
      server = await startApp(router)
    })

    it('accepts the master token', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
    })

    it('rejects an unknown token with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: 'Bearer wrong' },
      })
      expect(res.status).toBe(401)
    })

    it('rejects requests with no Authorization header', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Auth: session-scoped fallback
  // -------------------------------------------------------------------------

  describe('verifyOrchestratorAuth — session-scoped fallback', () => {
    const SESSION_TOKEN = 'session-bound-token'
    const verifyTokenOrSessionToken = vi.fn(
      (token: string | undefined, sessionId: string | undefined) =>
        token === SESSION_TOKEN && sessionId === 'orch-session-id',
    )

    beforeEach(async () => {
      verifyTokenOrSessionToken.mockClear()
      const router = createOrchestratorRouter(
        verifyToken,
        extractToken,
        makeSessions(),
        undefined,
        verifyTokenOrSessionToken,
        makeMemory(),
        makeChildren(),
      )
      server = await startApp(router)
    })

    it('accepts the master token without consulting the session verifier', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      expect(verifyTokenOrSessionToken).not.toHaveBeenCalled()
    })

    it('accepts a session-scoped token bound to the orchestrator session', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
      })
      expect(res.status).toBe(200)
      expect(verifyTokenOrSessionToken).toHaveBeenCalledWith(SESSION_TOKEN, 'orch-session-id')
    })

    it('rejects when neither the master nor session-scoped token matches', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/skills`, {
        headers: { Authorization: 'Bearer rogue-token' },
      })
      expect(res.status).toBe(401)
      expect(verifyTokenOrSessionToken).toHaveBeenCalled()
    })
  })
})
