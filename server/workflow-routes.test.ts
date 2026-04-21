/**
 * Tests for workflow-routes — covers pure helpers (parseGitHubSlug, isValidCron)
 * and the route handlers (runs, schedules, config repos, commit-event dispatch).
 *
 * Route handlers are tested by mounting the router on an Express app and issuing
 * fetch requests against an ephemeral port. All external dependencies (workflow
 * engine, config persistence, workflow loader, commit hooks, webhook setup) are
 * stubbed via vi.mock so the tests are pure in-memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

// ---------------------------------------------------------------------------
// Hoisted mock state (accessible inside vi.mock factories AND tests)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // Workflow engine
  engineAvailable: true,
  listRuns: vi.fn(() => [{ id: 'run-1', kind: 'code-review.daily', status: 'succeeded' }] as unknown[]),
  getRun: vi.fn(() => null as unknown),
  startRun: vi.fn(async (kind: string, input?: unknown) => ({ id: 'new-run', kind, input })),
  cancelRun: vi.fn(() => true),
  listSchedules: vi.fn(() => [{ id: 'sched-1', kind: 'code-review.daily', cronExpression: '0 6 * * *', input: {}, enabled: true }] as unknown[]),
  upsertSchedule: vi.fn((schedule: Record<string, unknown>) => ({ ...schedule, lastRunAt: null, nextRunAt: null })),
  deleteSchedule: vi.fn(() => true),
  getSchedule: vi.fn(() => null as unknown),
  triggerSchedule: vi.fn(async () => ({ id: 'triggered-run', kind: 'code-review.daily' })),
  hasWorkflow: vi.fn(() => true),

  // Workflow config
  workflowConfig: { reviewRepos: [] as Record<string, unknown>[] },
  addReviewRepo: vi.fn((repo: Record<string, unknown>) => {
    mocks.workflowConfig.reviewRepos.push(repo)
    return mocks.workflowConfig
  }),
  removeReviewRepo: vi.fn((id: string) => {
    mocks.workflowConfig.reviewRepos = mocks.workflowConfig.reviewRepos.filter(r => r.id !== id)
    return mocks.workflowConfig
  }),
  updateReviewRepo: vi.fn((id: string, patch: Record<string, unknown>) => {
    const idx = mocks.workflowConfig.reviewRepos.findIndex(r => r.id === id)
    if (idx < 0) throw new Error(`Repo not found: ${id}`)
    mocks.workflowConfig.reviewRepos[idx] = { ...mocks.workflowConfig.reviewRepos[idx], ...patch }
    return mocks.workflowConfig
  }),

  // Workflow loader
  listAvailableKinds: vi.fn(() => [{ kind: 'code-review.daily', name: 'Daily', source: 'builtin' as const }]),
  ensureRepoWorkflowsRegistered: vi.fn(),

  // Commit hooks + config helpers
  syncCommitHooks: vi.fn(),
  resolveRepoPathInRoot: vi.fn((p: string) => p),

  // Webhook setup
  previewWebhookSetup: vi.fn(async () => ({ action: 'none' as const })),
  createRepoWebhook: vi.fn(async () => {}),
  updateRepoWebhook: vi.fn(async () => {}),
  loadWebhookConfig: vi.fn(() => ({ enabled: true, secret: 'abc' })),
  generateWebhookSecret: vi.fn(() => 'generated-secret'),
  saveWebhookConfig: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./workflow-engine.js', () => ({
  getWorkflowEngine: () => {
    if (!mocks.engineAvailable) throw new Error('Workflow engine not initialized')
    return {
      listRuns: mocks.listRuns,
      getRun: mocks.getRun,
      startRun: mocks.startRun,
      cancelRun: mocks.cancelRun,
      listSchedules: mocks.listSchedules,
      upsertSchedule: mocks.upsertSchedule,
      deleteSchedule: mocks.deleteSchedule,
      getSchedule: mocks.getSchedule,
      triggerSchedule: mocks.triggerSchedule,
      hasWorkflow: mocks.hasWorkflow,
    }
  },
}))

vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: () => mocks.workflowConfig,
  addReviewRepo: mocks.addReviewRepo,
  removeReviewRepo: mocks.removeReviewRepo,
  updateReviewRepo: mocks.updateReviewRepo,
}))

vi.mock('./workflow-loader.js', () => ({
  listAvailableKinds: mocks.listAvailableKinds,
  ensureRepoWorkflowsRegistered: mocks.ensureRepoWorkflowsRegistered,
}))

vi.mock('./commit-event-hooks.js', () => ({
  syncCommitHooks: mocks.syncCommitHooks,
}))

vi.mock('./config.js', () => ({
  resolveRepoPathInRoot: mocks.resolveRepoPathInRoot,
}))

vi.mock('./webhook-github-setup.js', () => ({
  previewWebhookSetup: mocks.previewWebhookSetup,
  createRepoWebhook: mocks.createRepoWebhook,
  updateRepoWebhook: mocks.updateRepoWebhook,
}))

vi.mock('./webhook-config.js', () => ({
  loadWebhookConfig: mocks.loadWebhookConfig,
  generateWebhookSecret: mocks.generateWebhookSecret,
  saveWebhookConfig: mocks.saveWebhookConfig,
}))

// Must import after vi.mock calls so the router picks up the mocks
import { parseGitHubSlug, isValidCron, createWorkflowRouter, syncSchedules } from './workflow-routes.js'

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('parseGitHubSlug', () => {
  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGitHubSlug('https://github.com/Multiplier-Labs/codekin.git')).toBe('Multiplier-Labs/codekin')
  })

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGitHubSlug('https://github.com/owner/repo')).toBe('owner/repo')
  })

  it('parses SSH URL', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo.git')).toBe('owner/repo')
  })

  it('parses SSH URL without .git suffix', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo')).toBe('owner/repo')
  })

  it('handles trailing whitespace/newline', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo.git\n')).toBe('owner/repo')
  })

  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubSlug('https://gitlab.com/owner/repo.git')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseGitHubSlug('')).toBeNull()
  })

  it('handles repos with hyphens, underscores, and dots', () => {
    expect(parseGitHubSlug('git@github.com:my-org/my_repo.name.git')).toBe('my-org/my_repo.name')
  })
})

describe('isValidCron', () => {
  it('accepts a plain 5-field expression', () => {
    expect(isValidCron('0 9 * * 1')).toBe(true)
  })

  it('accepts wildcard in every field', () => {
    expect(isValidCron('* * * * *')).toBe(true)
  })

  it('accepts step and range syntax', () => {
    expect(isValidCron('*/15 9-17 * * 1-5')).toBe(true)
  })

  it('rejects fewer than 5 fields', () => {
    expect(isValidCron('0 9 * *')).toBe(false)
  })

  it('rejects more than 5 fields', () => {
    expect(isValidCron('0 9 * * 1 2')).toBe(false)
  })

  it('rejects out-of-range minute (60)', () => {
    expect(isValidCron('60 9 * * 1')).toBe(false)
  })

  it('rejects out-of-range day-of-month (32)', () => {
    expect(isValidCron('0 9 32 * 1')).toBe(false)
  })

  it('rejects non-numeric tokens', () => {
    expect(isValidCron('not a cron expr')).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isValidCron('')).toBe(false)
  })

  it('rejects inverted ranges', () => {
    expect(isValidCron('5-2 * * * *')).toBe(false)
  })

  it('rejects step value of 0 (e.g. */0)', () => {
    expect(isValidCron('*/0 * * * *')).toBe(false)
    expect(isValidCron('* */0 * * *')).toBe(false)
    expect(isValidCron('0-30/0 * * * *')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Route handler tests — mount the router on express + issue fetch requests
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-master-token'

function verifyToken(token: string | undefined): boolean {
  return token === AUTH_TOKEN
}

function extractToken(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7)
  return undefined
}

function authHeader(token: string = AUTH_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

interface TestHarness {
  baseUrl: string
  server: Server
  commitEventState: { handler: { handle: ReturnType<typeof vi.fn> } | undefined }
  close: () => Promise<void>
}

async function startServer(opts?: { withCommitHandler?: boolean }): Promise<TestHarness> {
  const handle = vi.fn(async (event: unknown) => ({ accepted: true, runId: 'r-42', event }))
  const commitEventState = {
    handler: opts?.withCommitHandler === false ? undefined : { handle },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workflows', createWorkflowRouter(
    verifyToken,
    extractToken as unknown as (req: express.Request) => string | undefined,
    undefined,
    commitEventState as { handler: { handle: ReturnType<typeof vi.fn> } | undefined },
  ))

  const server = app.listen(0)
  await new Promise<void>(res => server.once('listening', () => res()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/api/workflows`,
    server,
    commitEventState,
    close: () => new Promise<void>(res => server.close(() => res())),
  }
}

describe('workflow routes', () => {
  let harness: TestHarness

  beforeEach(async () => {
    mocks.workflowConfig.reviewRepos = []
    mocks.engineAvailable = true
    vi.clearAllMocks()
    // Re-install default return values after clearAllMocks
    mocks.listRuns.mockReturnValue([{ id: 'run-1', kind: 'code-review.daily', status: 'succeeded' }])
    mocks.listSchedules.mockReturnValue([{ id: 'sched-1', kind: 'code-review.daily', cronExpression: '0 6 * * *', input: {}, enabled: true }])
    mocks.startRun.mockImplementation(async (kind: string, input?: unknown) => ({ id: 'new-run', kind, input }))
    mocks.cancelRun.mockReturnValue(true)
    mocks.deleteSchedule.mockReturnValue(true)
    mocks.upsertSchedule.mockImplementation((schedule: Record<string, unknown>) => ({ ...schedule, lastRunAt: null, nextRunAt: null }))
    mocks.triggerSchedule.mockImplementation(async () => ({ id: 'triggered-run', kind: 'code-review.daily' }))
    mocks.resolveRepoPathInRoot.mockImplementation((p: string) => p)
    mocks.previewWebhookSetup.mockImplementation(async () => ({ action: 'none' as const }))
    mocks.loadWebhookConfig.mockReturnValue({ enabled: true, secret: 'abc' })

    harness = await startServer()
  })

  afterEach(async () => {
    await harness.close()
  })

  describe('auth middleware', () => {
    it('returns 401 without Bearer token', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`)
      expect(res.status).toBe(401)
    })

    it('returns 401 with wrong token', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: { Authorization: 'Bearer wrong' } })
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // GET /runs
  // -------------------------------------------------------------------------

  describe('GET /runs', () => {
    it('returns runs from the engine', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: authHeader() })
      expect(res.status).toBe(200)
      const body = await res.json() as { runs: unknown[] }
      expect(Array.isArray(body.runs)).toBe(true)
      expect(body.runs).toHaveLength(1)
      expect(mocks.listRuns).toHaveBeenCalledWith({ kind: undefined, status: undefined, limit: 50, offset: 0 })
    })

    it('passes filters to the engine and clamps limit/offset', async () => {
      await fetch(`${harness.baseUrl}/runs?kind=code-review.daily&status=running&limit=10000&offset=-1`, { headers: authHeader() })
      // limit clamped to 500, offset clamped to 0
      expect(mocks.listRuns).toHaveBeenCalledWith({ kind: 'code-review.daily', status: 'running', limit: 500, offset: 0 })
    })

    it('returns 503 when engine is not initialized', async () => {
      mocks.engineAvailable = false
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: authHeader() })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/not available/)
    })
  })

  // -------------------------------------------------------------------------
  // POST /runs
  // -------------------------------------------------------------------------

  describe('POST /runs', () => {
    it('starts a run on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'code-review.daily', input: { foo: 'bar' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { run: { kind: string } }
      expect(body.run.kind).toBe('code-review.daily')
      expect(mocks.startRun).toHaveBeenCalledWith('code-review.daily', { foo: 'bar' })
    })

    it('returns 400 when kind is missing', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ input: {} }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Missing kind')
    })

    it('returns 400 when engine throws', async () => {
      mocks.startRun.mockRejectedValueOnce(new Error('Unknown workflow kind: bogus'))
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'bogus' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Unknown workflow kind/)
    })
  })

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  describe('GET /schedules', () => {
    it('returns schedules from the engine', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, { headers: authHeader() })
      expect(res.status).toBe(200)
      const body = await res.json() as { schedules: unknown[] }
      expect(body.schedules).toHaveLength(1)
    })

    it('returns 503 when engine is not initialized', async () => {
      mocks.engineAvailable = false
      const res = await fetch(`${harness.baseUrl}/schedules`, { headers: authHeader() })
      expect(res.status).toBe(503)
    })
  })

  describe('POST /schedules', () => {
    it('upserts a schedule on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'sched-new',
          kind: 'code-review.daily',
          cronExpression: '0 9 * * 1-5',
          input: { repoPath: '/r' },
          enabled: true,
        }),
      })
      expect(res.status).toBe(200)
      expect(mocks.upsertSchedule).toHaveBeenCalledWith({
        id: 'sched-new',
        kind: 'code-review.daily',
        cronExpression: '0 9 * * 1-5',
        input: { repoPath: '/r' },
        enabled: true,
      })
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'code-review.daily' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing/)
    })

    it('returns 400 for invalid cron expression', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'sched-bad',
          kind: 'code-review.daily',
          cronExpression: 'not a cron',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Invalid cron expression')
    })
  })

  describe('PATCH /schedules/:id', () => {
    it('patches an existing schedule', async () => {
      mocks.getSchedule.mockReturnValueOnce({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
      })
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ cronExpression: '30 10 * * *', enabled: false }),
      })
      expect(res.status).toBe(200)
      expect(mocks.upsertSchedule).toHaveBeenCalledWith(expect.objectContaining({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '30 10 * * *',
        enabled: false,
      }))
    })

    it('returns 404 when schedule does not exist', async () => {
      mocks.getSchedule.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/schedules/missing`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid cron expression in patch', async () => {
      mocks.getSchedule.mockReturnValueOnce({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
      })
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ cronExpression: '99 99 99 99 99' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /schedules/:id', () => {
    it('deletes an existing schedule', async () => {
      mocks.deleteSchedule.mockReturnValueOnce(true)
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'DELETE',
        headers: authHeader(),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
      expect(mocks.deleteSchedule).toHaveBeenCalledWith('sched-1')
    })

    it('returns 404 when schedule does not exist', async () => {
      mocks.deleteSchedule.mockReturnValueOnce(false)
      const res = await fetch(`${harness.baseUrl}/schedules/missing`, {
        method: 'DELETE',
        headers: authHeader(),
      })
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Config /repos PATCH + POST  (task references PATCH /repos/:repo; the actual
  // route is /config/repos/:id)
  // -------------------------------------------------------------------------

  describe('POST /config/repos', () => {
    it('adds a repo on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/fake/path',
          cronExpression: '0 6 * * *',
          kind: 'code-review.daily',
        }),
      })
      expect(res.status).toBe(200)
      expect(mocks.addReviewRepo).toHaveBeenCalled()
      // syncCommitHooks is called as part of the save flow
      expect(mocks.syncCommitHooks).toHaveBeenCalled()
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ id: 'r1', name: 'My Repo' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing required fields/)
    })

    it('returns 400 for an invalid provider', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/fake/path',
          cronExpression: '0 6 * * *',
          provider: 'invalid',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid provider/)
    })

    it('returns 400 when repoPath escapes REPOS_ROOT', async () => {
      mocks.resolveRepoPathInRoot.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/outside',
          cronExpression: '0 6 * * *',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid repoPath/)
    })
  })

  describe('PATCH /config/repos/:id', () => {
    it('updates an existing repo', async () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'r1', name: 'Old', repoPath: '/p', cronExpression: '0 6 * * *', enabled: true,
      }]
      const res = await fetch(`${harness.baseUrl}/config/repos/r1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ name: 'New' }),
      })
      expect(res.status).toBe(200)
      expect(mocks.updateReviewRepo).toHaveBeenCalledWith('r1', { name: 'New' })
    })

    it('returns 400 when repoPath is provided and is invalid', async () => {
      mocks.resolveRepoPathInRoot.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/config/repos/r1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ repoPath: '/escape' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid repoPath/)
    })

    it('returns 404 when repo does not exist', async () => {
      mocks.updateReviewRepo.mockImplementationOnce(() => { throw new Error('Repo not found: ghost') })
      const res = await fetch(`${harness.baseUrl}/config/repos/ghost`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ name: 'nope' }),
      })
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // POST /commit-event (commit-event dispatch)
  // -------------------------------------------------------------------------

  describe('POST /commit-event', () => {
    it('returns 401 without a Bearer token', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ repoPath: '/p' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing required fields/)
    })

    it('dispatches to the handler on happy path (202 on accepted)', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p',
          branch: 'main',
          commitHash: 'abc1234',
          commitMessage: 'fix: something',
          author: 'alice',
        }),
      })
      expect(res.status).toBe(202)
      const body = await res.json() as { accepted: boolean; runId: string }
      expect(body.accepted).toBe(true)
      expect(body.runId).toBe('r-42')
      expect(harness.commitEventState.handler!.handle).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: '/p',
        branch: 'main',
        commitHash: 'abc1234',
        commitMessage: 'fix: something',
        author: 'alice',
      }))
    })

    it('returns 200 when the handler rejects (accepted=false)', async () => {
      harness.commitEventState.handler!.handle.mockResolvedValueOnce({ accepted: false, reason: 'duplicate' })
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { accepted: boolean; reason: string }
      expect(body.accepted).toBe(false)
      expect(body.reason).toBe('duplicate')
    })

    it('defaults author to "unknown" when omitted', async () => {
      await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(harness.commitEventState.handler!.handle).toHaveBeenCalledWith(expect.objectContaining({ author: 'unknown' }))
    })

    it('returns 503 when no commit event handler is configured', async () => {
      await harness.close()
      harness = await startServer({ withCommitHandler: false })
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(res.status).toBe(503)
    })
  })

  // -------------------------------------------------------------------------
  // syncSchedules — exercises the non-HTTP path that is still part of the
  // same module. Keeps it close to the other route tests since it uses the
  // same mocks.
  // -------------------------------------------------------------------------

  describe('syncSchedules', () => {
    it('upserts schedules for configured non-event repos and prunes stale ones', () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'r1', name: 'Repo 1', repoPath: '/p1',
        cronExpression: '0 6 * * *', enabled: true,
      }]
      mocks.listSchedules.mockReturnValueOnce([
        { id: 'stale', kind: 'code-review.daily', cronExpression: '0 6 * * *', input: {}, enabled: true },
      ])

      syncSchedules()

      expect(mocks.upsertSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
      expect(mocks.deleteSchedule).toHaveBeenCalledWith('stale')
    })

    it('skips event-driven repos (cronExpression === "event")', () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'event-repo', name: 'Evt', repoPath: '/p',
        cronExpression: 'event', enabled: true,
      }]
      mocks.listSchedules.mockReturnValueOnce([])

      syncSchedules()

      expect(mocks.upsertSchedule).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Route handler tests — mount the router on express + issue fetch requests
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-master-token'

function verifyToken(token: string | undefined): boolean {
  return token === AUTH_TOKEN
}

function extractToken(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7)
  return undefined
}

function authHeader(token: string = AUTH_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

interface TestHarness {
  baseUrl: string
  server: Server
  commitEventState: { handler: { handle: ReturnType<typeof vi.fn> } | undefined }
  close: () => Promise<void>
}

async function startServer(opts?: { withCommitHandler?: boolean }): Promise<TestHarness> {
  const handle = vi.fn(async (event: unknown) => ({ accepted: true, runId: 'r-42', event }))
  const commitEventState = {
    handler: opts?.withCommitHandler === false ? undefined : { handle },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workflows', createWorkflowRouter(
    verifyToken,
    extractToken as unknown as (req: express.Request) => string | undefined,
    undefined,
    commitEventState as { handler: { handle: ReturnType<typeof vi.fn> } | undefined },
  ))

  const server = app.listen(0)
  await new Promise<void>(res => server.once('listening', () => res()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/api/workflows`,
    server,
    commitEventState,
    close: () => new Promise<void>(res => server.close(() => res())),
  }
}

describe('workflow routes', () => {
  let harness: TestHarness

  beforeEach(async () => {
    mocks.workflowConfig.reviewRepos = []
    mocks.engineAvailable = true
    vi.clearAllMocks()
    // Re-install default return values after clearAllMocks
    mocks.listRuns.mockReturnValue([{ id: 'run-1', kind: 'code-review.daily', status: 'succeeded' }])
    mocks.listSchedules.mockReturnValue([{ id: 'sched-1', kind: 'code-review.daily', cronExpression: '0 6 * * *', input: {}, enabled: true }])
    mocks.startRun.mockImplementation(async (kind: string, input?: unknown) => ({ id: 'new-run', kind, input }))
    mocks.cancelRun.mockReturnValue(true)
    mocks.deleteSchedule.mockReturnValue(true)
    mocks.upsertSchedule.mockImplementation((schedule: Record<string, unknown>) => ({ ...schedule, lastRunAt: null, nextRunAt: null }))
    mocks.triggerSchedule.mockImplementation(async () => ({ id: 'triggered-run', kind: 'code-review.daily' }))
    mocks.resolveRepoPathInRoot.mockImplementation((p: string) => p)
    mocks.previewWebhookSetup.mockImplementation(async () => ({ action: 'none' as const }))
    mocks.loadWebhookConfig.mockReturnValue({ enabled: true, secret: 'abc' })

    harness = await startServer()
  })

  afterEach(async () => {
    await harness.close()
  })

  describe('auth middleware', () => {
    it('returns 401 without Bearer token', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`)
      expect(res.status).toBe(401)
    })

    it('returns 401 with wrong token', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: { Authorization: 'Bearer wrong' } })
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // GET /runs
  // -------------------------------------------------------------------------

  describe('GET /runs', () => {
    it('returns runs from the engine', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: authHeader() })
      expect(res.status).toBe(200)
      const body = await res.json() as { runs: unknown[] }
      expect(Array.isArray(body.runs)).toBe(true)
      expect(body.runs).toHaveLength(1)
      expect(mocks.listRuns).toHaveBeenCalledWith({ kind: undefined, status: undefined, limit: 50, offset: 0 })
    })

    it('passes filters to the engine and clamps limit/offset', async () => {
      await fetch(`${harness.baseUrl}/runs?kind=code-review.daily&status=running&limit=10000&offset=-1`, { headers: authHeader() })
      // limit clamped to 500, offset clamped to 0
      expect(mocks.listRuns).toHaveBeenCalledWith({ kind: 'code-review.daily', status: 'running', limit: 500, offset: 0 })
    })

    it('returns 503 when engine is not initialized', async () => {
      mocks.engineAvailable = false
      const res = await fetch(`${harness.baseUrl}/runs`, { headers: authHeader() })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/not available/)
    })
  })

  // -------------------------------------------------------------------------
  // POST /runs
  // -------------------------------------------------------------------------

  describe('POST /runs', () => {
    it('starts a run on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'code-review.daily', input: { foo: 'bar' } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { run: { kind: string } }
      expect(body.run.kind).toBe('code-review.daily')
      expect(mocks.startRun).toHaveBeenCalledWith('code-review.daily', { foo: 'bar' })
    })

    it('returns 400 when kind is missing', async () => {
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ input: {} }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Missing kind')
    })

    it('returns 400 when engine throws', async () => {
      mocks.startRun.mockRejectedValueOnce(new Error('Unknown workflow kind: bogus'))
      const res = await fetch(`${harness.baseUrl}/runs`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'bogus' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Unknown workflow kind/)
    })
  })

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  describe('GET /schedules', () => {
    it('returns schedules from the engine', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, { headers: authHeader() })
      expect(res.status).toBe(200)
      const body = await res.json() as { schedules: unknown[] }
      expect(body.schedules).toHaveLength(1)
    })

    it('returns 503 when engine is not initialized', async () => {
      mocks.engineAvailable = false
      const res = await fetch(`${harness.baseUrl}/schedules`, { headers: authHeader() })
      expect(res.status).toBe(503)
    })
  })

  describe('POST /schedules', () => {
    it('upserts a schedule on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'sched-new',
          kind: 'code-review.daily',
          cronExpression: '0 9 * * 1-5',
          input: { repoPath: '/r' },
          enabled: true,
        }),
      })
      expect(res.status).toBe(200)
      expect(mocks.upsertSchedule).toHaveBeenCalledWith({
        id: 'sched-new',
        kind: 'code-review.daily',
        cronExpression: '0 9 * * 1-5',
        input: { repoPath: '/r' },
        enabled: true,
      })
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ kind: 'code-review.daily' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing/)
    })

    it('returns 400 for invalid cron expression', async () => {
      const res = await fetch(`${harness.baseUrl}/schedules`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'sched-bad',
          kind: 'code-review.daily',
          cronExpression: 'not a cron',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Invalid cron expression')
    })
  })

  describe('PATCH /schedules/:id', () => {
    it('patches an existing schedule', async () => {
      mocks.getSchedule.mockReturnValueOnce({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
      })
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ cronExpression: '30 10 * * *', enabled: false }),
      })
      expect(res.status).toBe(200)
      expect(mocks.upsertSchedule).toHaveBeenCalledWith(expect.objectContaining({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '30 10 * * *',
        enabled: false,
      }))
    })

    it('returns 404 when schedule does not exist', async () => {
      mocks.getSchedule.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/schedules/missing`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid cron expression in patch', async () => {
      mocks.getSchedule.mockReturnValueOnce({
        id: 'sched-1',
        kind: 'code-review.daily',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
      })
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ cronExpression: '99 99 99 99 99' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /schedules/:id', () => {
    it('deletes an existing schedule', async () => {
      mocks.deleteSchedule.mockReturnValueOnce(true)
      const res = await fetch(`${harness.baseUrl}/schedules/sched-1`, {
        method: 'DELETE',
        headers: authHeader(),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)
      expect(mocks.deleteSchedule).toHaveBeenCalledWith('sched-1')
    })

    it('returns 404 when schedule does not exist', async () => {
      mocks.deleteSchedule.mockReturnValueOnce(false)
      const res = await fetch(`${harness.baseUrl}/schedules/missing`, {
        method: 'DELETE',
        headers: authHeader(),
      })
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Config /repos PATCH + POST  (task references PATCH /repos/:repo; the actual
  // route is /config/repos/:id)
  // -------------------------------------------------------------------------

  describe('POST /config/repos', () => {
    it('adds a repo on happy path', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/fake/path',
          cronExpression: '0 6 * * *',
          kind: 'code-review.daily',
        }),
      })
      expect(res.status).toBe(200)
      expect(mocks.addReviewRepo).toHaveBeenCalled()
      // syncCommitHooks is called as part of the save flow
      expect(mocks.syncCommitHooks).toHaveBeenCalled()
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ id: 'r1', name: 'My Repo' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing required fields/)
    })

    it('returns 400 for an invalid provider', async () => {
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/fake/path',
          cronExpression: '0 6 * * *',
          provider: 'invalid',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid provider/)
    })

    it('returns 400 when repoPath escapes REPOS_ROOT', async () => {
      mocks.resolveRepoPathInRoot.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/config/repos`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          id: 'r1',
          name: 'My Repo',
          repoPath: '/outside',
          cronExpression: '0 6 * * *',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid repoPath/)
    })
  })

  describe('PATCH /config/repos/:id', () => {
    it('updates an existing repo', async () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'r1', name: 'Old', repoPath: '/p', cronExpression: '0 6 * * *', enabled: true,
      }]
      const res = await fetch(`${harness.baseUrl}/config/repos/r1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ name: 'New' }),
      })
      expect(res.status).toBe(200)
      expect(mocks.updateReviewRepo).toHaveBeenCalledWith('r1', { name: 'New' })
    })

    it('returns 400 when repoPath is provided and is invalid', async () => {
      mocks.resolveRepoPathInRoot.mockReturnValueOnce(null)
      const res = await fetch(`${harness.baseUrl}/config/repos/r1`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ repoPath: '/escape' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Invalid repoPath/)
    })

    it('returns 404 when repo does not exist', async () => {
      mocks.updateReviewRepo.mockImplementationOnce(() => { throw new Error('Repo not found: ghost') })
      const res = await fetch(`${harness.baseUrl}/config/repos/ghost`, {
        method: 'PATCH',
        headers: authHeader(),
        body: JSON.stringify({ name: 'nope' }),
      })
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // POST /commit-event (commit-event dispatch)
  // -------------------------------------------------------------------------

  describe('POST /commit-event', () => {
    it('returns 401 without a Bearer token', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({ repoPath: '/p' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/Missing required fields/)
    })

    it('dispatches to the handler on happy path (202 on accepted)', async () => {
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p',
          branch: 'main',
          commitHash: 'abc1234',
          commitMessage: 'fix: something',
          author: 'alice',
        }),
      })
      expect(res.status).toBe(202)
      const body = await res.json() as { accepted: boolean; runId: string }
      expect(body.accepted).toBe(true)
      expect(body.runId).toBe('r-42')
      expect(harness.commitEventState.handler!.handle).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: '/p',
        branch: 'main',
        commitHash: 'abc1234',
        commitMessage: 'fix: something',
        author: 'alice',
      }))
    })

    it('returns 200 when the handler rejects (accepted=false)', async () => {
      harness.commitEventState.handler!.handle.mockResolvedValueOnce({ accepted: false, reason: 'duplicate' })
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { accepted: boolean; reason: string }
      expect(body.accepted).toBe(false)
      expect(body.reason).toBe('duplicate')
    })

    it('defaults author to "unknown" when omitted', async () => {
      await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(harness.commitEventState.handler!.handle).toHaveBeenCalledWith(expect.objectContaining({ author: 'unknown' }))
    })

    it('returns 503 when no commit event handler is configured', async () => {
      await harness.close()
      harness = await startServer({ withCommitHandler: false })
      const res = await fetch(`${harness.baseUrl}/commit-event`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify({
          repoPath: '/p', branch: 'main', commitHash: 'h', commitMessage: 'x',
        }),
      })
      expect(res.status).toBe(503)
    })
  })

  // -------------------------------------------------------------------------
  // syncSchedules — exercises the non-HTTP path that is still part of the
  // same module. Keeps it close to the other route tests since it uses the
  // same mocks.
  // -------------------------------------------------------------------------

  describe('syncSchedules', () => {
    it('upserts schedules for configured non-event repos and prunes stale ones', () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'r1', name: 'Repo 1', repoPath: '/p1',
        cronExpression: '0 6 * * *', enabled: true,
      }]
      mocks.listSchedules.mockReturnValueOnce([
        { id: 'stale', kind: 'code-review.daily', cronExpression: '0 6 * * *', input: {}, enabled: true },
      ])

      syncSchedules()

      expect(mocks.upsertSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
      expect(mocks.deleteSchedule).toHaveBeenCalledWith('stale')
    })

    it('skips event-driven repos (cronExpression === "event")', () => {
      mocks.workflowConfig.reviewRepos = [{
        id: 'event-repo', name: 'Evt', repoPath: '/p',
        cronExpression: 'event', enabled: true,
      }]
      mocks.listSchedules.mockReturnValueOnce([])

      syncSchedules()

      expect(mocks.upsertSchedule).not.toHaveBeenCalled()
    })
  })
})
