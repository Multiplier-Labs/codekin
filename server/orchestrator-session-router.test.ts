/**
 * Tests for createSessionRouter — orchestrator session/children routes.
 *
 * Focus areas (previously near-zero coverage):
 *   - the per-IP spawn rate limiter (security control: each spawn allocates a
 *     real subprocess, so the 20-per-window cap must hold)
 *   - auth guards on protected routes
 *   - spawn-request validation branches (these all return before any real
 *     children.spawn call, so no subprocess is ever started in these tests)
 *
 * Mocks mirror orchestrator-routes.test.ts so the suite never touches ~/.codekin
 * or the real repos root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { CodekinApi } from './codekin-mcp-api.js'
import { getOrchestratorProvider, setOrchestratorProvider, ensureOrchestratorRunning } from './orchestrator-manager.js'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

vi.mock('./orchestrator-manager.js', () => ({
  ORCHESTRATOR_DIR: '/tmp/orch-session-test',
  getOrCreateOrchestratorId: vi.fn(() => 'orch-session-id'),
  getOrchestratorSessionId: vi.fn(() => null),
  ensureOrchestratorRunning: vi.fn(() => 'orch-session-id'),
  getOrchestratorProvider: vi.fn(() => 'codex'),
  setOrchestratorProvider: vi.fn(),
}))

vi.mock('./config.js', () => ({
  REPOS_ROOT: '/tmp/repos',
  resolveRepoPathInRoot: vi.fn(() => null),
  getAgentDisplayName: vi.fn(() => 'Joe'),
  DATA_DIR: '/tmp/orch-session-test',
}))

vi.mock('./orchestrator-outbox.js', () => ({
  getOrchestratorOutbox: () => ({ enqueue: () => {} }),
}))

vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: vi.fn(() => ({ reviewRepos: [] })),
}))

vi.mock('./orchestrator-reports.js', () => ({
  scanRepoReports: vi.fn(() => []),
  readReport: vi.fn(() => null),
  getReportsSince: vi.fn(() => []),
}))

import { getReportsSince } from './orchestrator-reports.js'
import { loadWorkflowConfig } from './workflow-config.js'
import { createSessionRouter } from './orchestrator-session-router.js'
import type { SessionManager } from './session-manager.js'
import type { OrchestratorMemory } from './orchestrator-memory.js'
import type { OrchestratorChildManager } from './orchestrator-children.js'

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
  return { list: vi.fn(() => []) } as unknown as OrchestratorMemory
}

function makeChildren(): OrchestratorChildManager {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    activeCount: vi.fn(() => 0),
    spawn: vi.fn(),
  } as unknown as OrchestratorChildManager
}

function makeSessions(): SessionManager {
  return { get: vi.fn(() => undefined) } as unknown as SessionManager
}

const VALID_SPAWN = { repo: '/tmp/repos/x', task: 'do a thing', branchName: 'fix/thing' }

describe('createSessionRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }
  let children: OrchestratorChildManager

  function mount(verifyAuth: (req: Request) => boolean, sessions?: SessionManager): Promise<void> {
    children = makeChildren()
    const router = createSessionRouter(verifyAuth, sessions ?? makeSessions(), makeMemory(), children)
    return startApp(router).then((s) => { server = s })
  }

  afterEach(async () => {
    await server?.close()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Spawn rate limiter
  // -------------------------------------------------------------------------

  describe('spawn rate limiter', () => {
    it('rejects with 429 once the per-IP window budget (20) is exhausted', async () => {
      await mount(() => true)
      const post = () =>
        fetch(`${server.baseUrl}/api/orchestrator/children`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}', // missing fields -> handler returns 400 (no spawn), but limiter still counts it
        })

      // First 20 reach the handler and 400 on validation.
      const statuses: number[] = []
      for (let i = 0; i < 20; i++) statuses.push((await post()).status)
      expect(statuses.every((s) => s === 400)).toBe(true)

      // 21st is blocked by the rate limiter before the handler runs.
      const blocked = await post()
      expect(blocked.status).toBe(429)
      const body = await blocked.json()
      expect(body).toMatchObject({ error: 'Too Many Requests' })
      expect(body.retryAfter).toBeGreaterThan(0)

      // The over-limit request never reached the spawn path.
      expect(children.spawn).not.toHaveBeenCalled()
    })
  })

  describe('harness selection contract', () => {
    beforeEach(async () => { await mount(() => true) })

    it('reports no selection without starting an agent', async () => {
      vi.mocked(getOrchestratorProvider).mockReturnValueOnce(null)
      const response = await fetch(`${server.baseUrl}/api/orchestrator/status`)
      expect(await response.json()).toMatchObject({ provider: null })
      expect(ensureOrchestratorRunning).not.toHaveBeenCalled()
    })

    it('requires an explicit choice on first start', async () => {
      vi.mocked(getOrchestratorProvider).mockReturnValueOnce(null)
      const response = await fetch(`${server.baseUrl}/api/orchestrator/start`, { method: 'POST' })
      expect(response.status).toBe(409)
      expect(ensureOrchestratorRunning).not.toHaveBeenCalled()
    })

    it.each(['claude', 'codex', 'opencode'])('saves %s before starting Joe', async (provider) => {
      const response = await fetch(`${server.baseUrl}/api/orchestrator/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }),
      })
      expect(response.status).toBe(200)
      expect(setOrchestratorProvider).toHaveBeenCalledWith(expect.anything(), provider)
      expect(vi.mocked(setOrchestratorProvider).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ensureOrchestratorRunning).mock.invocationCallOrder[0])
    })

    it('rejects invalid start and spawn providers before doing any work', async () => {
      for (const path of ['start', 'children']) {
        const response = await fetch(`${server.baseUrl}/api/orchestrator/${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...VALID_SPAWN, provider: 'unknown' }),
        })
        expect(response.status).toBe(400)
      }
      expect(children.spawn).not.toHaveBeenCalled()
      expect(ensureOrchestratorRunning).not.toHaveBeenCalled()
    })

    it.each(['codex', 'opencode'] as const)('passes %s through the MCP API client and real HTTP router', async (provider) => {
      mkdirSync('/tmp/repos', { recursive: true })
      const repo = mkdtempSync('/tmp/repos/joe-harness-')
      try {
        vi.mocked(children.spawn).mockResolvedValue({ id: 'child' } as never)
        const api = new CodekinApi({ baseUrl: server.baseUrl, token: 'test' })
        await api.spawnChild({ repo, task: 'implement task', branchName: 'fix/task', provider, model: 'selected-model' })
        expect(children.spawn).toHaveBeenCalledWith(expect.objectContaining({ provider, model: 'selected-model', parentSessionId: 'orch-session-id' }))
      } finally { rmSync(repo, { recursive: true }) }
    })
  })

  // -------------------------------------------------------------------------
  // Auth guards
  // -------------------------------------------------------------------------

  describe('auth guards', () => {
    it('returns 401 for the children list when auth fails', async () => {
      await mount(() => false)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children`)
      expect(res.status).toBe(401)
    })

    it('returns 401 for status when auth fails', async () => {
      await mount(() => false)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/status`)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Spawn validation (no real subprocess is ever spawned)
  // -------------------------------------------------------------------------

  describe('spawn validation', () => {
    beforeEach(async () => { await mount(() => true) })

    async function spawn(body: unknown) {
      return fetch(`${server.baseUrl}/api/orchestrator/children`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('400s when required fields are missing', async () => {
      const res = await spawn({ repo: '/tmp/repos/x' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Missing required fields/)
      expect(children.spawn).not.toHaveBeenCalled()
    })

    it('400s on a branchName that fails the safe-charset check', async () => {
      const res = await spawn({ ...VALID_SPAWN, branchName: 'bad branch; rm -rf' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Invalid branchName/)
      expect(children.spawn).not.toHaveBeenCalled()
    })

    it('400s on deployAfter: true instead of silently ignoring it', async () => {
      const res = await spawn({ ...VALID_SPAWN, deployAfter: true })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/deployAfter is not supported/)
      expect(children.spawn).not.toHaveBeenCalled()
    })

    it('400s when allowedTools is not an array of strings', async () => {
      const res = await spawn({ ...VALID_SPAWN, allowedTools: 'Bash' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Invalid allowedTools/)
      expect(children.spawn).not.toHaveBeenCalled()
    })

    it('400s when the repo path does not exist on disk', async () => {
      const res = await spawn({ ...VALID_SPAWN, repo: '/tmp/definitely-not-a-real-repo-xyz' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/directory does not exist/)
      expect(children.spawn).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Read routes
  // -------------------------------------------------------------------------

  describe('read routes', () => {
    beforeEach(async () => { await mount(() => true) })

    it('reports a stopped orchestrator when no session exists', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/status`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ sessionId: null, status: 'stopped' })
    })

    it('lists children (empty by default)', async () => {
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ children: [] })
    })

    it('lists reports across managed repos when called with no parameters (the list_reports MCP call)', async () => {
      mkdirSync('/tmp/repos', { recursive: true })
      const repo = mkdtempSync('/tmp/repos/joe-reports-')
      try {
        vi.mocked(loadWorkflowConfig).mockReturnValueOnce({ reviewRepos: [{ repoPath: repo }, { repoPath: '/tmp/repos/does-not-exist' }] } as never)
        vi.mocked(getReportsSince).mockReturnValueOnce([{ filePath: `${repo}/.codekin/reports/incidents/2026-09-30_x.md` }] as never)
        const api = new CodekinApi({ baseUrl: server.baseUrl, token: 'test' })
        const body = await api.listReports() as { reports: unknown[] }
        expect(body.reports).toHaveLength(1)
        expect(getReportsSince).toHaveBeenCalledWith([repo], '')
      } finally { rmSync(repo, { recursive: true }) }
    })

    it('passes ?since through and rejects a malformed date', async () => {
      const api = new CodekinApi({ baseUrl: server.baseUrl, token: 'test' })
      await api.listReports({ since: '2026-09-01' })
      expect(getReportsSince).toHaveBeenCalledWith([], '2026-09-01')
      const bad = await fetch(`${server.baseUrl}/api/orchestrator/reports?since=yesterday`)
      expect(bad.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // Child transcript
  // -------------------------------------------------------------------------

  describe('child transcript', () => {
    const child = { id: 'child-1', status: 'running' }

    function sessionsWith(outputHistory: Array<{ type: string; data?: string }> | null): SessionManager {
      return {
        get: vi.fn(() => (outputHistory ? { outputHistory } : undefined)),
      } as unknown as SessionManager
    }

    it('401s when auth fails', async () => {
      await mount(() => false)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript`)
      expect(res.status).toBe(401)
    })

    it('404s when the child does not exist', async () => {
      await mount(() => true)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children/nope/transcript`)
      expect(res.status).toBe(404)
      expect((await res.json()).error).toMatch(/Child session not found/)
    })

    it('404s when the underlying session was deleted', async () => {
      await mount(() => true, sessionsWith(null))
      ;(children.get as ReturnType<typeof vi.fn>).mockReturnValue(child)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript`)
      expect(res.status).toBe(404)
      expect((await res.json()).error).toMatch(/Session no longer exists/)
    })

    it('returns the joined output messages, skipping non-output entries', async () => {
      await mount(() => true, sessionsWith([
        { type: 'output', data: 'hello ' },
        { type: 'system', data: 'ignored' },
        { type: 'output', data: 'world' },
      ]))
      ;(children.get as ReturnType<typeof vi.fn>).mockReturnValue(child)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        childId: 'child-1',
        status: 'running',
        transcript: 'hello world',
        truncated: false,
        totalLength: 11,
      })
    })

    it('returns the tail and sets truncated when output exceeds ?limit (min-clamped behavior)', async () => {
      await mount(() => true, sessionsWith([{ type: 'output', data: 'abcdefghij' }]))
      ;(children.get as ReturnType<typeof vi.fn>).mockReturnValue(child)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript?limit=4`)
      const body = await res.json()
      expect(body.transcript).toBe('ghij')
      expect(body.truncated).toBe(true)
      expect(body.totalLength).toBe(10)
    })

    it('falls back to the default limit on a bogus ?limit and caps at 50000', async () => {
      const big = 'x'.repeat(6000)
      await mount(() => true, sessionsWith([{ type: 'output', data: big }]))
      ;(children.get as ReturnType<typeof vi.fn>).mockReturnValue(child)

      const bogus = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript?limit=banana`)
      const bogusBody = await bogus.json()
      expect(bogusBody.transcript.length).toBe(5000)
      expect(bogusBody.truncated).toBe(true)

      const huge = await fetch(`${server.baseUrl}/api/orchestrator/children/child-1/transcript?limit=999999`)
      const hugeBody = await huge.json()
      // limit capped at 50000 — full 6000-char output fits
      expect(hugeBody.transcript.length).toBe(6000)
      expect(hugeBody.truncated).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe('session cleanup', () => {
    function fakeSession(opts: { pending?: number; processing?: boolean } = {}) {
      return {
        pendingToolApprovals: new Map(Array.from({ length: opts.pending ?? 0 }, (_, i) => [`r${i}`, {}])),
        pendingControlRequests: new Map(),
        isProcessing: opts.processing ?? false,
        claudeProcess: { isAlive: () => true },
      }
    }

    const all: Record<string, ReturnType<typeof fakeSession>> = {
      done: fakeSession(),
      busy: fakeSession({ processing: true }),
      asking: fakeSession({ pending: 1 }),
      child: fakeSession(),
      manual: fakeSession(),
    }
    const infos = [
      { id: 'done', name: 'done', source: 'workflow' },
      { id: 'busy', name: 'busy', source: 'agent' },
      { id: 'asking', name: 'asking', source: 'webhook' },
      { id: 'child', name: 'child', source: 'agent' },
      { id: 'manual', name: 'manual', source: 'manual' },
    ]

    function cleanupSessions(): SessionManager {
      return {
        listAll: vi.fn(() => infos),
        get: vi.fn((id: string) => all[id]),
        delete: vi.fn(() => true),
      } as unknown as SessionManager
    }

    it('deletes only finished automated sessions and reports what it skipped', async () => {
      const sessions = cleanupSessions()
      await mount(() => true, sessions)
      ;(children.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (id === 'child' ? { id, status: 'running' } : null))

      const res = await fetch(`${server.baseUrl}/api/orchestrator/sessions/cleanup`, { method: 'DELETE' })
      const body = await res.json()

      expect(body.deleted).toEqual([{ id: 'done', name: 'done' }])
      expect(body.skipped).toEqual([
        { id: 'busy', name: 'busy', reason: 'still working' },
        { id: 'asking', name: 'asking', reason: 'waiting on a prompt' },
        { id: 'child', name: 'child', reason: 'supervised child is running' },
      ])
      expect(sessions.delete).toHaveBeenCalledTimes(1)
      expect(sessions.delete).toHaveBeenCalledWith('done')
    })

    it('previews without deleting on ?dryRun=true', async () => {
      const sessions = cleanupSessions()
      await mount(() => true, sessions)
      const res = await fetch(`${server.baseUrl}/api/orchestrator/sessions/cleanup?dryRun=true`, { method: 'DELETE' })
      const body = await res.json()
      expect(body.dryRun).toBe(true)
      expect(body.deleted.map((d: { id: string }) => d.id)).toEqual(['done', 'child'])
      expect(sessions.delete).not.toHaveBeenCalled()
    })
  })
})
