/** Tests for parseGitHubSlug, isValidCron, and createWorkflowRouter route handlers. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockEngine = vi.hoisted(() => ({
  listRuns: vi.fn(() => []),
  getRun: vi.fn(),
  startRun: vi.fn(async () => ({ id: 'run-1', kind: 'test' })),
  cancelRun: vi.fn(() => true),
  listSchedules: vi.fn(() => []),
  upsertSchedule: vi.fn((s: unknown) => s),
  getSchedule: vi.fn(),
  deleteSchedule: vi.fn(() => true),
  triggerSchedule: vi.fn(async () => ({ id: 'run-1' })),
}))

const mockGetWorkflowEngine = vi.hoisted(() => vi.fn(() => mockEngine))
const mockLoadWorkflowConfig = vi.hoisted(() => vi.fn(() => ({ reviewRepos: [] })))
const mockAddReviewRepo = vi.hoisted(() => vi.fn((r: unknown) => ({ reviewRepos: [r] })))
const mockRemoveReviewRepo = vi.hoisted(() => vi.fn(() => ({ reviewRepos: [] })))
const mockUpdateReviewRepo = vi.hoisted(() => vi.fn((id: string, patch: Record<string, unknown>) => ({ reviewRepos: [{ id, ...patch }] })))
const mockResolveRepoPathInRoot = vi.hoisted(() => vi.fn((p: string) => (p.startsWith('/repos/') ? p : null)))
const mockSyncCommitHooks = vi.hoisted(() => vi.fn())
const mockListAvailableKinds = vi.hoisted(() => vi.fn(() => [{ kind: 'code-review.daily', name: 'Daily', source: 'builtin' }]))
const mockEnsureRepoWorkflowsRegistered = vi.hoisted(() => vi.fn())
const mockPreviewWebhookSetup = vi.hoisted(() => vi.fn())
const mockCreateRepoWebhook = vi.hoisted(() => vi.fn())
const mockUpdateRepoWebhook = vi.hoisted(() => vi.fn())
const mockLoadWebhookConfig = vi.hoisted(() => vi.fn(() => ({ secret: 'abc', enabled: true })))
const mockSaveWebhookConfig = vi.hoisted(() => vi.fn())
const mockGenerateWebhookSecret = vi.hoisted(() => vi.fn(() => 'new-secret'))

vi.mock('./workflow-engine.js', () => ({
  getWorkflowEngine: mockGetWorkflowEngine,
}))
vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: mockLoadWorkflowConfig,
  addReviewRepo: mockAddReviewRepo,
  removeReviewRepo: mockRemoveReviewRepo,
  updateReviewRepo: mockUpdateReviewRepo,
}))
vi.mock('./workflow-loader.js', () => ({
  listAvailableKinds: mockListAvailableKinds,
  ensureRepoWorkflowsRegistered: mockEnsureRepoWorkflowsRegistered,
}))
vi.mock('./commit-event-hooks.js', () => ({
  syncCommitHooks: mockSyncCommitHooks,
}))
vi.mock('./config.js', () => ({
  resolveRepoPathInRoot: mockResolveRepoPathInRoot,
}))
vi.mock('./types.js', () => ({
  VALID_PROVIDERS: new Set(['claude', 'opencode']),
}))
vi.mock('./webhook-github-setup.js', () => ({
  previewWebhookSetup: mockPreviewWebhookSetup,
  createRepoWebhook: mockCreateRepoWebhook,
  updateRepoWebhook: mockUpdateRepoWebhook,
}))
vi.mock('./webhook-config.js', () => ({
  loadWebhookConfig: mockLoadWebhookConfig,
  generateWebhookSecret: mockGenerateWebhookSecret,
  saveWebhookConfig: mockSaveWebhookConfig,
}))

import { parseGitHubSlug, isValidCron, createWorkflowRouter } from './workflow-routes.js'

// ---------------------------------------------------------------------------
// Pure-helper tests
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
})

// ---------------------------------------------------------------------------
// Route tests — mount the router on a real Express app and hit it via fetch
// ---------------------------------------------------------------------------

const TOKEN = 'valid-token'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: { headers: Record<string, string | undefined> }) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
}

async function startApp(router: express.Router): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use('/api/workflows', router)
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

describe('createWorkflowRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }
  let commitHandler: { handle: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadWorkflowConfig.mockReturnValue({ reviewRepos: [] })
    mockLoadWebhookConfig.mockReturnValue({ secret: 'abc', enabled: true })
    mockResolveRepoPathInRoot.mockImplementation((p: string) => (p.startsWith('/repos/') ? p : null))
    commitHandler = { handle: vi.fn(async () => ({ accepted: true, runId: 'run-1' })) }
    const router = createWorkflowRouter(
      verifyToken,
      extractToken as unknown as (req: express.Request) => string | undefined,
      undefined,
      { handler: commitHandler as unknown as Parameters<typeof createWorkflowRouter>[3] extends { handler: infer H } | undefined ? H : never },
    )
    server = await startApp(router)
  })

  afterEach(async () => {
    await server.close()
  })

  function auth(): Record<string, string> {
    return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  }

  describe('auth enforcement', () => {
    it('rejects unauthenticated /kinds request with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/kinds`)
      expect(res.status).toBe(401)
    })

    it('rejects unauthenticated /runs request with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/runs`)
      expect(res.status).toBe(401)
    })

    it('rejects wrong token with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/kinds`, {
        headers: { Authorization: 'Bearer wrong' },
      })
      expect(res.status).toBe(401)
    })

    it('accepts valid token on /kinds', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/kinds`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.kinds).toHaveLength(1)
    })
  })

  describe('POST /commit-event', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/commit-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('returns 400 when required fields missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/commit-event`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ repoPath: '/repos/x' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Missing required fields/)
    })

    it('dispatches to handler on happy path', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/commit-event`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          repoPath: '/repos/x',
          branch: 'main',
          commitHash: 'abc',
          commitMessage: 'fix: stuff',
          author: 'alice',
        }),
      })
      expect(res.status).toBe(202)
      expect(commitHandler.handle).toHaveBeenCalledWith({
        repoPath: '/repos/x',
        branch: 'main',
        commitHash: 'abc',
        commitMessage: 'fix: stuff',
        author: 'alice',
      })
    })

    it('returns 503 when commit handler not available', async () => {
      // Rebuild router without handler
      await server.close()
      const router = createWorkflowRouter(
        verifyToken,
        extractToken as unknown as (req: express.Request) => string | undefined,
        undefined,
        { handler: undefined },
      )
      server = await startApp(router)
      const res = await fetch(`${server.baseUrl}/api/workflows/commit-event`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          repoPath: '/repos/x',
          branch: 'main',
          commitHash: 'abc',
          commitMessage: 'fix',
        }),
      })
      expect(res.status).toBe(503)
    })
  })

  describe('runs', () => {
    it('POST /runs returns 400 when kind missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/runs`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('POST /runs calls engine.startRun', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/runs`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ kind: 'code-review.daily', input: { foo: 1 } }),
      })
      expect(res.status).toBe(200)
      expect(mockEngine.startRun).toHaveBeenCalledWith('code-review.daily', { foo: 1 })
    })

    it('POST /runs bubbles engine error as 400', async () => {
      mockEngine.startRun.mockRejectedValueOnce(new Error('bad kind'))
      const res = await fetch(`${server.baseUrl}/api/workflows/runs`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ kind: 'x' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('bad kind')
    })

    it('GET /runs/:id returns 404 when run not found', async () => {
      mockEngine.getRun.mockReturnValueOnce(undefined)
      const res = await fetch(`${server.baseUrl}/api/workflows/runs/missing`, { headers: auth() })
      expect(res.status).toBe(404)
    })

    it('GET /runs/:id returns the run when found', async () => {
      mockEngine.getRun.mockReturnValueOnce({ id: 'run-1', kind: 'x' })
      const res = await fetch(`${server.baseUrl}/api/workflows/runs/run-1`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.run.id).toBe('run-1')
    })

    it('POST /runs/:id/cancel returns 404 when not active', async () => {
      mockEngine.cancelRun.mockReturnValueOnce(false)
      const res = await fetch(`${server.baseUrl}/api/workflows/runs/x/cancel`, {
        method: 'POST',
        headers: auth(),
      })
      expect(res.status).toBe(404)
    })

    it('clamps GET /runs limit to a maximum of 500', async () => {
      await fetch(`${server.baseUrl}/api/workflows/runs?limit=999999`, { headers: auth() })
      expect(mockEngine.listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }))
    })

    it('uses default limit=50 when not provided', async () => {
      await fetch(`${server.baseUrl}/api/workflows/runs`, { headers: auth() })
      expect(mockEngine.listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
    })
  })

  describe('schedules', () => {
    it('POST /schedules returns 400 when fields missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ id: 'x' }),
      })
      expect(res.status).toBe(400)
    })

    it('POST /schedules rejects invalid cron with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          id: 'x',
          kind: 'code-review.daily',
          cronExpression: 'not a cron',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid cron expression')
    })

    it('POST /schedules upserts valid schedule', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          id: 's1',
          kind: 'code-review.daily',
          cronExpression: '0 9 * * *',
        }),
      })
      expect(res.status).toBe(200)
      expect(mockEngine.upsertSchedule).toHaveBeenCalledWith(expect.objectContaining({
        id: 's1',
        kind: 'code-review.daily',
        cronExpression: '0 9 * * *',
        enabled: true,
      }))
    })

    it('PATCH /schedules/:id returns 404 when missing', async () => {
      mockEngine.getSchedule.mockReturnValueOnce(undefined)
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules/x`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(404)
    })

    it('PATCH /schedules/:id rejects invalid cron', async () => {
      mockEngine.getSchedule.mockReturnValueOnce({
        id: 'x', kind: 'y', cronExpression: '0 9 * * *', input: {}, enabled: true,
      })
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules/x`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ cronExpression: 'bad' }),
      })
      expect(res.status).toBe(400)
    })

    it('DELETE /schedules/:id returns 404 when missing', async () => {
      mockEngine.deleteSchedule.mockReturnValueOnce(false)
      const res = await fetch(`${server.baseUrl}/api/workflows/schedules/x`, {
        method: 'DELETE',
        headers: auth(),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('config/repos', () => {
    it('POST returns 400 when required fields missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ id: 'x' }),
      })
      expect(res.status).toBe(400)
    })

    it('POST returns 400 when provider is invalid', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          id: 'x', name: 'n', repoPath: '/repos/x', cronExpression: '0 9 * * *',
          provider: 'unknown',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Invalid provider/)
    })

    it('POST returns 400 when repoPath escapes root', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          id: 'x', name: 'n', repoPath: '/etc/passwd', cronExpression: '0 9 * * *',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Invalid repoPath/)
    })

    it('POST happy path calls addReviewRepo', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          id: 'x', name: 'n', repoPath: '/repos/x', cronExpression: '0 9 * * *',
        }),
      })
      expect(res.status).toBe(200)
      expect(mockAddReviewRepo).toHaveBeenCalledWith(expect.objectContaining({ id: 'x' }))
    })

    it('PATCH rejects invalid repoPath with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos/x`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ repoPath: '/etc/passwd' }),
      })
      expect(res.status).toBe(400)
    })

    it('PATCH returns 404 when repo not found', async () => {
      mockUpdateReviewRepo.mockImplementationOnce(() => {
        throw new Error('Repo not found: x')
      })
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos/x`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(404)
    })

    it('DELETE removes repo and re-syncs hooks', async () => {
      const res = await fetch(`${server.baseUrl}/api/workflows/config/repos/x`, {
        method: 'DELETE',
        headers: auth(),
      })
      expect(res.status).toBe(200)
      expect(mockRemoveReviewRepo).toHaveBeenCalledWith('x')
      expect(mockSyncCommitHooks).toHaveBeenCalled()
    })
  })

  describe('engine unavailable', () => {
    it('GET /runs returns 503 when engine throws', async () => {
      mockGetWorkflowEngine.mockImplementationOnce(() => {
        throw new Error('not initialized')
      })
      const res = await fetch(`${server.baseUrl}/api/workflows/runs`, { headers: auth() })
      expect(res.status).toBe(503)
    })
  })
})
