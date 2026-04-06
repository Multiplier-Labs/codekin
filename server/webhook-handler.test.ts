/** Tests for WebhookHandler — verifies event routing, signature validation, and session dispatch; mocks webhook-dedup, webhook-github, webhook-prompt, and webhook-workspace. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'

// Hoisted mock fns accessible in both mock factory and tests
const mockIsDuplicate = vi.hoisted(() => vi.fn(() => false))
const mockDedupShutdown = vi.hoisted(() => vi.fn())

// Hoisted PR mock fns so vi.mock factories can reference them
const mockFetchPrDiff = vi.hoisted(() => vi.fn(async () => ({ diff: 'mock diff', truncated: false })))
const mockFetchPrFiles = vi.hoisted(() => vi.fn(async () => 'file1.ts (modified, +10/-2)'))
const mockFetchPrCommits = vi.hoisted(() => vi.fn(async () => '- abc1234: fix bug'))
const mockFetchPrReviewComments = vi.hoisted(() => vi.fn(async () => ''))
const mockFetchPrReviews = vi.hoisted(() => vi.fn(async () => ''))
const mockFetchExistingReviewComment = vi.hoisted(() => vi.fn(async () => undefined as number | undefined))
const mockBuildPrReviewPrompt = vi.hoisted(() => vi.fn(() => 'mock pr review prompt'))
const mockLoadPrCache = vi.hoisted(() => vi.fn(() => undefined))
const mockEnsureCacheDir = vi.hoisted(() => vi.fn(() => '/home/user/.codekin/pr-cache/owner/repo/pr-42.json'))
const mockArchivePrCache = vi.hoisted(() => vi.fn())
const mockDeletePrCache = vi.hoisted(() => vi.fn())

// Mock all webhook sub-modules before importing the handler
vi.mock('./webhook-dedup.js', () => {
  class MockWebhookDedup {
    isDuplicate = mockIsDuplicate
    recordProcessed = vi.fn()
    shutdown = mockDedupShutdown
    flushToDisk = vi.fn()
  }
  return {
    WebhookDedup: MockWebhookDedup,
    computeIdempotencyKey: vi.fn(() => 'mock-idempotency-key'),
    computePrIdempotencyKey: vi.fn(() => 'mock-pr-idempotency-key'),
  }
})

vi.mock('./webhook-github.js', () => ({
  checkGhHealth: vi.fn(async () => ({ available: true })),
  fetchFailedLogs: vi.fn(async () => 'some logs'),
  fetchJobs: vi.fn(async () => []),
  fetchAnnotations: vi.fn(async () => []),
  fetchCommitMessage: vi.fn(async () => 'fix something'),
  fetchPRTitle: vi.fn(async () => 'PR Title'),
}))

vi.mock('./webhook-prompt.js', () => ({
  buildPrompt: vi.fn(() => 'test prompt'),
}))

vi.mock('./webhook-workspace.js', () => ({
  createWorkspace: vi.fn(async () => '/tmp/workspace'),
  cleanupWorkspace: vi.fn(),
}))

vi.mock('./webhook-pr-github.js', () => ({
  fetchPrDiff: mockFetchPrDiff,
  fetchPrFiles: mockFetchPrFiles,
  fetchPrCommits: mockFetchPrCommits,
  fetchPrReviewComments: mockFetchPrReviewComments,
  fetchPrReviews: mockFetchPrReviews,
  fetchExistingReviewComment: mockFetchExistingReviewComment,
  REVIEW_COMMENT_MARKER: '<!-- codekin-review -->',
}))

vi.mock('./webhook-pr-cache.js', () => ({
  loadPrCache: mockLoadPrCache,
  ensureCacheDir: mockEnsureCacheDir,
  archivePrCache: mockArchivePrCache,
  deletePrCache: mockDeletePrCache,
}))

vi.mock('./webhook-pr-prompt.js', () => ({
  buildPrReviewPrompt: mockBuildPrReviewPrompt,
}))

import { WebhookHandler } from './webhook-handler.js'
import { createWorkspace } from './webhook-workspace.js'
import type { FullWebhookConfig } from './webhook-config.js'

const SECRET = 'test-secret-123'

function makeConfig(overrides: Partial<FullWebhookConfig> = {}): FullWebhookConfig {
  return {
    enabled: true,
    secret: SECRET,
    maxConcurrentSessions: 3,
    logLinesToInclude: 200,
    actorAllowlist: [],
    ...overrides,
  }
}

type ExitCallback = (sessionId: string, code: number, signal: string | null, willRestart: boolean) => void
type ResultCallback = (sessionId: string, isError: boolean) => void

function fakeSessionManager(): any {
  const exitCallbacks: ExitCallback[] = []
  const resultCallbacks: ResultCallback[] = []
  return {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 'session-1' })),
    get: vi.fn(() => null),
    delete: vi.fn(),
    stopClaude: vi.fn(),
    broadcast: vi.fn(),
    sendInput: vi.fn(),
    onSessionExit: vi.fn((cb: ExitCallback) => { exitCallbacks.push(cb) }),
    onSessionResult: vi.fn((cb: ResultCallback) => { resultCallbacks.push(cb); return () => {} }),
    _exitCallbacks: exitCallbacks,
    _resultCallbacks: resultCallbacks,
  } as unknown as ReturnType<typeof fakeSessionManager>
}

function makePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'completed',
    workflow_run: {
      id: 100,
      name: 'CI',
      run_number: 1,
      run_attempt: 1,
      head_branch: 'main',
      head_sha: 'abc123',
      conclusion: 'failure',
      event: 'push',
      actor: { login: 'user1' },
      html_url: 'https://github.com/owner/repo/actions/runs/100',
      check_suite_id: 200,
      pull_requests: [],
      ...overrides.workflow_run,
    },
    repository: {
      full_name: 'owner/repo',
      name: 'repo',
      clone_url: 'https://github.com/owner/repo.git',
      ...overrides.repository,
    },
    ...overrides,
  }
}

function signPayload(body: Buffer): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex')
}

function makeHeaders(body: Buffer, overrides: Record<string, string> = {}) {
  return {
    event: 'workflow_run',
    delivery: 'delivery-123',
    signature: signPayload(body),
    ...overrides,
  }
}

describe('WebhookHandler', () => {
  let handler: WebhookHandler
  let sessions: ReturnType<typeof fakeSessionManager>

  beforeEach(() => {
    vi.useFakeTimers()
    sessions = fakeSessionManager()
    handler = new WebhookHandler(makeConfig(), sessions)
  })

  afterEach(() => {
    handler.shutdown()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('verifySignature', () => {
    it('returns true for a valid signature', () => {
      const body = Buffer.from('{"test":true}')
      const sig = signPayload(body)
      expect(handler.verifySignature(body, sig)).toBe(true)
    })

    it('returns false for an invalid signature', () => {
      const body = Buffer.from('{"test":true}')
      expect(handler.verifySignature(body, 'sha256=deadbeef0000000000000000000000000000000000000000000000000000000000')).toBe(false)
    })

    it('returns false for wrong-length signature', () => {
      const body = Buffer.from('{"test":true}')
      expect(handler.verifySignature(body, 'sha256=tooshort')).toBe(false)
    })

    it('returns false when no secret is configured', () => {
      handler.shutdown()
      handler = new WebhookHandler(makeConfig({ secret: '' }), sessions)
      const body = Buffer.from('{"test":true}')
      expect(handler.verifySignature(body, signPayload(body))).toBe(false)
    })
  })

  describe('handleWebhook', () => {
    it('returns disabled when webhooks are off', async () => {
      handler.shutdown()
      handler = new WebhookHandler(makeConfig({ enabled: false }), sessions)
      const body = Buffer.from('{}')
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('disabled')
    })

    it('returns disabled when gh is not healthy', async () => {
      // ghHealthy defaults to false since checkHealth hasn't been called
      const body = Buffer.from('{}')
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.filterReason).toContain('gh CLI not available')
    })

    it('returns 401 when signature is missing', async () => {
      await handler.checkHealth()
      const body = Buffer.from('{}')
      const result = await handler.handleWebhook(body, { event: 'workflow_run', delivery: 'd1', signature: '' })
      expect(result.statusCode).toBe(401)
    })

    it('returns 401 when signature is invalid', async () => {
      await handler.checkHealth()
      const body = Buffer.from('{}')
      const result = await handler.handleWebhook(body, {
        event: 'workflow_run',
        delivery: 'd1',
        signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      })
      expect(result.statusCode).toBe(401)
    })

    it('returns 400 for malformed JSON', async () => {
      await handler.checkHealth()
      const body = Buffer.from('not json{{{')
      const sig = signPayload(body)
      const result = await handler.handleWebhook(body, { event: 'workflow_run', delivery: 'd1', signature: sig })
      expect(result.statusCode).toBe(400)
    })

    it('returns filtered for non-workflow_run event', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body, { event: 'push' }))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
    })

    it('returns 400 when workflow_run is missing', async () => {
      await handler.checkHealth()
      const body = Buffer.from(JSON.stringify({ action: 'completed', repository: { full_name: 'o/r', name: 'r', clone_url: 'x' } }))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(400)
    })

    it('returns filtered when action is not completed', async () => {
      await handler.checkHealth()
      const payload = makePayload({ action: 'requested' })
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
    })

    it('returns filtered when conclusion is not failure', async () => {
      await handler.checkHealth()
      const payload = makePayload({ workflow_run: { conclusion: 'success' } })
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
    })

    it('returns filtered when actor is not in allowlist', async () => {
      handler.shutdown()
      handler = new WebhookHandler(makeConfig({ actorAllowlist: ['allowed-user'] }), sessions)
      await handler.checkHealth()
      // makePayload default actor is 'user1', which is not in the allowlist
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
      expect(result.body.filterReason).toContain('not in allowlist')
    })

    it('accepts webhook when actor is in allowlist', async () => {
      handler.shutdown()
      handler = new WebhookHandler(makeConfig({ actorAllowlist: ['user1'] }), sessions)
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(202)
      expect(result.body.accepted).toBe(true)
    })

    it('accepts all actors when allowlist is empty', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(202)
    })

    it('returns duplicate when dedup detects it', async () => {
      await handler.checkHealth()
      mockIsDuplicate.mockReturnValueOnce(true)

      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('duplicate')
    })

    it('returns 429 when max sessions reached', async () => {
      await handler.checkHealth()
      sessions.list.mockReturnValue([
        { id: '1', source: 'webhook', active: true },
        { id: '2', source: 'webhook', active: true },
        { id: '3', source: 'webhook', active: true },
      ])

      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(429)
    })

    it('returns 202 for valid webhook and begins processing', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      expect(result.statusCode).toBe(202)
      expect(result.body.accepted).toBe(true)
      expect(result.body.status).toBe('processing')
      expect(result.body.sessionId).toBeDefined()
    })

    it('async processing creates session and sends prompt', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      await handler.handleWebhook(body, makeHeaders(body))

      // Let async processing complete
      await vi.advanceTimersByTimeAsync(100)

      expect(sessions.create).toHaveBeenCalled()
      expect(sessions.sendInput).toHaveBeenCalled()
    })

    it('async processing marks error when workspace creation fails', async () => {
      await handler.checkHealth()
      vi.mocked(createWorkspace).mockRejectedValueOnce(new Error('clone failed'))

      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))

      // Let async processing complete
      await vi.advanceTimersByTimeAsync(100)

      const event = handler.getEvent(result.body.eventId as string)
      expect(event?.status).toBe('error')
      expect(event?.error).toContain('Workspace creation failed')
    })
  })

  describe('event history', () => {
    it('getEvents returns a copy of events', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      await handler.handleWebhook(body, makeHeaders(body))

      const events = handler.getEvents()
      expect(events.length).toBeGreaterThan(0)
      // Mutating the copy should not affect internal state
      events.length = 0
      expect(handler.getEvents().length).toBeGreaterThan(0)
    })

    it('getEvent returns the correct event by ID', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))

      const event = handler.getEvent(result.body.eventId as string)
      expect(event).toBeDefined()
      expect(event!.repo).toBe('owner/repo')
    })

    it('getEvent returns undefined for unknown ID', () => {
      expect(handler.getEvent('nonexistent')).toBeUndefined()
    })

    it('trims event history to 100 entries', async () => {
      await handler.checkHealth()

      // Repeatedly trigger filtered events (quick, doesn't spawn async)
      for (let i = 0; i < 110; i++) {
        const payload = makePayload({ action: 'requested' })
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makeHeaders(body, { delivery: `d-${i}` }))
      }

      expect(handler.getEvents().length).toBeLessThanOrEqual(100)
    })
  })

  describe('session exit handler', () => {
    it('marks event as completed on code 0', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      const sessionId = result.body.sessionId as string

      // Let async processing complete so status becomes session_created
      await vi.advanceTimersByTimeAsync(100)

      // Trigger exit callback
      sessions._exitCallbacks[0](sessionId, 0, null, false)

      const event = handler.getEvent(result.body.eventId as string)
      expect(event?.status).toBe('completed')
    })

    it('marks event as error on non-zero exit', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      const sessionId = result.body.sessionId as string

      await vi.advanceTimersByTimeAsync(100)

      sessions._exitCallbacks[0](sessionId, 1, null, false)

      const event = handler.getEvent(result.body.eventId as string)
      expect(event?.status).toBe('error')
    })

    it('does not update status when willRestart is true', async () => {
      await handler.checkHealth()
      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))
      const sessionId = result.body.sessionId as string

      await vi.advanceTimersByTimeAsync(100)

      const eventBefore = handler.getEvent(result.body.eventId as string)
      const statusBefore = eventBefore?.status

      sessions._exitCallbacks[0](sessionId, 1, null, true)

      const eventAfter = handler.getEvent(result.body.eventId as string)
      expect(eventAfter?.status).toBe(statusBefore)
    })
  })

  describe('processing watchdog', () => {
    it('marks processing events as error after 5 minutes', async () => {
      await handler.checkHealth()
      // Make workspace creation hang forever by never resolving
      vi.mocked(createWorkspace).mockReturnValue(new Promise(() => {}))

      const payload = makePayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makeHeaders(body))

      // Advance past 5 minutes + watchdog interval
      vi.advanceTimersByTime(6 * 60 * 1000)

      const event = handler.getEvent(result.body.eventId as string)
      expect(event?.status).toBe('error')
      expect(event?.error).toContain('watchdog')
    })
  })

  describe('getConfig', () => {
    it('returns public config without secret', () => {
      const config = handler.getConfig()
      expect(config).toEqual({
        enabled: true,
        maxConcurrentSessions: 3,
        logLinesToInclude: 200,
        actorAllowlist: [],
      })
      expect('secret' in config).toBe(false)
    })
  })

  describe('checkHealth', () => {
    it('sets ghHealthy flag on success', async () => {
      const result = await handler.checkHealth()
      expect(result).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // pull_request event handling
  // -----------------------------------------------------------------------

  describe('pull_request events', () => {
    beforeEach(() => {
      // Re-apply mock implementations that vi.restoreAllMocks() may have cleared
      mockFetchPrDiff.mockImplementation(async () => ({ diff: 'mock diff', truncated: false }))
      mockFetchPrFiles.mockImplementation(async () => 'file1.ts (modified, +10/-2)')
      mockFetchPrCommits.mockImplementation(async () => '- abc1234: fix bug')
      mockFetchPrReviewComments.mockImplementation(async () => '')
      mockFetchPrReviews.mockImplementation(async () => '')
      mockFetchExistingReviewComment.mockImplementation(async () => undefined)
      mockBuildPrReviewPrompt.mockImplementation(() => 'mock pr review prompt')
      mockLoadPrCache.mockImplementation(() => undefined)
      mockEnsureCacheDir.mockImplementation(() => '/home/user/.codekin/pr-cache/owner/repo/pr-42.json')
      mockArchivePrCache.mockClear()
      mockDeletePrCache.mockClear()
      vi.mocked(createWorkspace).mockImplementation(async () => '/tmp/workspace')
    })

    function makePrPayload(overrides: Record<string, unknown> = {}) {
      return {
        action: 'opened',
        number: 42,
        pull_request: {
          number: 42,
          title: 'Fix auth bug',
          body: 'Fixes the login issue',
          state: 'open',
          draft: false,
          merged: false,
          user: { login: 'user1' },
          head: {
            ref: 'fix/auth',
            sha: 'deadbeef1234567890abcdef1234567890abcdef',
            repo: { clone_url: 'https://github.com/owner/repo.git' },
          },
          base: {
            ref: 'main',
            sha: 'baseshabaseshabaseshabaseshabaseshabases00',
          },
          html_url: 'https://github.com/owner/repo/pull/42',
          changed_files: 3,
          additions: 50,
          deletions: 10,
          ...overrides.pull_request as Record<string, unknown> | undefined,
        },
        repository: {
          full_name: 'owner/repo',
          name: 'repo',
          clone_url: 'https://github.com/owner/repo.git',
          ...overrides.repository as Record<string, unknown> | undefined,
        },
        sender: { login: 'user1', ...overrides.sender as Record<string, unknown> | undefined },
        ...overrides,
      }
    }

    function makePrHeaders(body: Buffer, overrides: Record<string, string> = {}) {
      return {
        event: 'pull_request',
        delivery: 'pr-delivery-1',
        signature: signPayload(body),
        ...overrides,
      }
    }

    it('returns 400 when pull_request is missing from payload', async () => {
      await handler.checkHealth()
      const body = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'o/r', name: 'r', clone_url: 'x' }, sender: { login: 'u' } }))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(400)
      expect(result.body.error).toContain('pull_request')
    })

    it('returns filtered for unsupported PR action', async () => {
      await handler.checkHealth()
      const payload = makePrPayload({ action: 'edited' })
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
      expect(result.body.filterReason).toContain('edited')
    })

    it('returns filtered for draft PRs', async () => {
      await handler.checkHealth()
      const payload = makePrPayload({ pull_request: { draft: true } })
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
      expect(result.body.filterReason).toContain('Draft')
    })

    it('returns filtered when PR actor is not in allowlist', async () => {
      handler.shutdown()
      handler = new WebhookHandler(makeConfig({ actorAllowlist: ['allowed-user'] }), sessions)
      await handler.checkHealth()
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
      expect(result.body.filterReason).toContain('not in allowlist')
    })

    it('returns duplicate when dedup detects it', async () => {
      await handler.checkHealth()
      mockIsDuplicate.mockReturnValueOnce(true)
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('duplicate')
    })

    it('returns 429 when max sessions reached', async () => {
      await handler.checkHealth()
      sessions.list.mockReturnValue([
        { id: '1', source: 'webhook', active: true },
        { id: '2', source: 'webhook', active: true },
        { id: '3', source: 'webhook', active: true },
      ])
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(429)
    })

    it('returns 202 for valid PR event', async () => {
      await handler.checkHealth()
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      expect(result.statusCode).toBe(202)
      expect(result.body.accepted).toBe(true)
      expect(result.body.status).toBe('processing')
      expect(result.body.sessionId).toBeDefined()
    })

    it('records PR-specific fields in event', async () => {
      await handler.checkHealth()
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body))
      const event = handler.getEvent(result.body.eventId as string)
      expect(event?.prNumber).toBe(42)
      expect(event?.prTitle).toBe('Fix auth bug')
      expect(event?.headSha).toBe('deadbeef1234567890abcdef1234567890abcdef')
      expect(event?.baseBranch).toBe('main')
      expect(event?.event).toBe('pull_request')
    })

    it('accepts opened, synchronize, and reopened actions', async () => {
      await handler.checkHealth()
      for (const action of ['opened', 'synchronize', 'reopened']) {
        const payload = makePrPayload({ action })
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body, { delivery: `d-${action}` }))
        expect(result.statusCode).toBe(202)
      }
    })

    it('returns filtered for unknown event types', async () => {
      await handler.checkHealth()
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      const result = await handler.handleWebhook(body, makePrHeaders(body, { event: 'issues' }))
      expect(result.statusCode).toBe(200)
      expect(result.body.status).toBe('filtered')
    })

    it('async processing creates session and sends PR review prompt', async () => {
      await handler.checkHealth()
      const payload = makePrPayload()
      const body = Buffer.from(JSON.stringify(payload))
      await handler.handleWebhook(body, makePrHeaders(body))

      // Let async processing complete
      await vi.advanceTimersByTimeAsync(100)

      expect(sessions.create).toHaveBeenCalledWith(
        expect.stringContaining('PR #42'),
        '/tmp/workspace',
        expect.objectContaining({ source: 'webhook' }),
      )
      expect(sessions.sendInput).toHaveBeenCalledWith(
        expect.any(String),
        'mock pr review prompt',
      )
    })

    it('names session with update suffix for synchronize action', async () => {
      await handler.checkHealth()
      const payload = makePrPayload({ action: 'synchronize' })
      const body = Buffer.from(JSON.stringify(payload))
      await handler.handleWebhook(body, makePrHeaders(body))

      await vi.advanceTimersByTimeAsync(100)

      expect(sessions.create).toHaveBeenCalledWith(
        expect.stringContaining('update @deadbee'),
        '/tmp/workspace',
        expect.objectContaining({ source: 'webhook' }),
      )
    })

    describe('session superseding', () => {
      it('supersedes active session when new event arrives for the same PR', async () => {
        await handler.checkHealth()

        // First event — creates a session
        const payload1 = makePrPayload({ action: 'opened' })
        const body1 = Buffer.from(JSON.stringify(payload1))
        const result1 = await handler.handleWebhook(body1, makePrHeaders(body1, { delivery: 'pr-d-1' }))
        expect(result1.statusCode).toBe(202)

        await vi.advanceTimersByTimeAsync(100)

        const event1 = handler.getEvent(result1.body.eventId as string)
        expect(event1?.status).toBe('session_created')

        // Second event — same PR, new SHA (synchronize)
        const payload2 = makePrPayload({ action: 'synchronize' })
        // Override the head SHA to simulate a new push
        payload2.pull_request.head.sha = 'newsha_1234567890abcdef1234567890abcdef12'
        const body2 = Buffer.from(JSON.stringify(payload2))
        const result2 = await handler.handleWebhook(body2, makePrHeaders(body2, { delivery: 'pr-d-2' }))
        expect(result2.statusCode).toBe(202)

        // Old event should be superseded
        const event1After = handler.getEvent(result1.body.eventId as string)
        expect(event1After?.status).toBe('superseded')
        expect(event1After?.error).toContain('Superseded')

        // Old session should have been deleted
        expect(sessions.delete).toHaveBeenCalledWith(event1?.sessionId)
      })

      it('does not supersede sessions for different PRs', async () => {
        await handler.checkHealth()

        // Event for PR #42
        const payload1 = makePrPayload({ action: 'opened' })
        const body1 = Buffer.from(JSON.stringify(payload1))
        const result1 = await handler.handleWebhook(body1, makePrHeaders(body1, { delivery: 'pr-d-1' }))
        await vi.advanceTimersByTimeAsync(100)

        // Event for PR #99 (different PR)
        const payload2 = makePrPayload({ action: 'opened' })
        payload2.number = 99
        payload2.pull_request.number = 99
        payload2.pull_request.title = 'Different PR'
        payload2.pull_request.head.sha = 'othershaothershaothershaothershaothersha00'
        const body2 = Buffer.from(JSON.stringify(payload2))
        await handler.handleWebhook(body2, makePrHeaders(body2, { delivery: 'pr-d-2' }))

        // First event should NOT be superseded
        const event1After = handler.getEvent(result1.body.eventId as string)
        expect(event1After?.status).toBe('session_created')
        expect(sessions.delete).not.toHaveBeenCalled()
      })

      it('does not supersede already completed sessions', async () => {
        await handler.checkHealth()

        // First event — completes
        const payload1 = makePrPayload({ action: 'opened' })
        const body1 = Buffer.from(JSON.stringify(payload1))
        const result1 = await handler.handleWebhook(body1, makePrHeaders(body1, { delivery: 'pr-d-1' }))
        await vi.advanceTimersByTimeAsync(100)

        // Simulate session completion
        const sessionId = result1.body.sessionId as string
        sessions._exitCallbacks[0](sessionId, 0, null, false)
        expect(handler.getEvent(result1.body.eventId as string)?.status).toBe('completed')

        // Second event — same PR, new SHA
        const payload2 = makePrPayload({ action: 'synchronize' })
        payload2.pull_request.head.sha = 'newsha_1234567890abcdef1234567890abcdef12'
        const body2 = Buffer.from(JSON.stringify(payload2))
        await handler.handleWebhook(body2, makePrHeaders(body2, { delivery: 'pr-d-2' }))

        // Completed event should NOT be superseded
        const event1After = handler.getEvent(result1.body.eventId as string)
        expect(event1After?.status).toBe('completed')
        expect(sessions.delete).not.toHaveBeenCalled()
      })

      it('does not overwrite superseded status when workspace creation fails', async () => {
        await handler.checkHealth()
        // Make workspace creation slow, then fail
        let rejectWorkspace: (err: Error) => void
        vi.mocked(createWorkspace).mockReturnValueOnce(
          new Promise((_resolve, reject) => { rejectWorkspace = reject })
        )

        // First event — starts processing, workspace hangs
        const payload1 = makePrPayload({ action: 'opened' })
        const body1 = Buffer.from(JSON.stringify(payload1))
        const result1 = await handler.handleWebhook(body1, makePrHeaders(body1, { delivery: 'pr-d-1' }))
        expect(handler.getEvent(result1.body.eventId as string)?.status).toBe('processing')

        // Second event — supersedes the first
        const payload2 = makePrPayload({ action: 'synchronize' })
        payload2.pull_request.head.sha = 'newsha_1234567890abcdef1234567890abcdef12'
        const body2 = Buffer.from(JSON.stringify(payload2))
        await handler.handleWebhook(body2, makePrHeaders(body2, { delivery: 'pr-d-2' }))
        expect(handler.getEvent(result1.body.eventId as string)?.status).toBe('superseded')

        // Now the old workspace creation fails
        rejectWorkspace!(new Error('clone failed'))
        await vi.advanceTimersByTimeAsync(100)

        // Status should still be 'superseded', not overwritten to 'error'
        expect(handler.getEvent(result1.body.eventId as string)?.status).toBe('superseded')
      })

      it('supersedes events still in processing state', async () => {
        await handler.checkHealth()
        // Make workspace hang so event stays in 'processing'
        vi.mocked(createWorkspace).mockReturnValueOnce(new Promise(() => {}))

        const payload1 = makePrPayload({ action: 'opened' })
        const body1 = Buffer.from(JSON.stringify(payload1))
        const result1 = await handler.handleWebhook(body1, makePrHeaders(body1, { delivery: 'pr-d-1' }))
        expect(handler.getEvent(result1.body.eventId as string)?.status).toBe('processing')

        // Second event arrives while first is still processing
        const payload2 = makePrPayload({ action: 'synchronize' })
        payload2.pull_request.head.sha = 'newsha_1234567890abcdef1234567890abcdef12'
        const body2 = Buffer.from(JSON.stringify(payload2))
        const result2 = await handler.handleWebhook(body2, makePrHeaders(body2, { delivery: 'pr-d-2' }))
        expect(result2.statusCode).toBe(202)

        // Old event should be superseded even though it was still processing
        const event1After = handler.getEvent(result1.body.eventId as string)
        expect(event1After?.status).toBe('superseded')
      })
    })

    describe('cache and comment integration', () => {
      it('calls loadPrCache with correct repo and PR number', async () => {
        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(mockLoadPrCache).toHaveBeenCalledWith('owner/repo', 42)
      })

      it('calls fetchExistingReviewComment with correct repo and PR number', async () => {
        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(mockFetchExistingReviewComment).toHaveBeenCalledWith('owner/repo', 42)
      })

      it('passes cache data and comment ID to buildPrReviewPrompt', async () => {
        const mockCache = {
          prNumber: 42,
          repo: 'owner/repo',
          lastReviewedSha: 'prev123',
          timestamp: '2026-04-02T10:00:00.000Z',
          priorReviewSummary: 'summary',
          codebaseContext: 'context',
          reviewFindings: 'findings',
        }
        mockLoadPrCache.mockReturnValueOnce(mockCache as any)
        mockFetchExistingReviewComment.mockResolvedValueOnce(12345)

        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(mockBuildPrReviewPrompt).toHaveBeenCalledWith(
          expect.any(Object),
          '/tmp/workspace',
          {
            priorCache: mockCache,
            cachePath: '/home/user/.codekin/pr-cache/owner/repo/pr-42.json',
            existingCommentId: 12345,
          },
        )
      })

      it('includes Write in allowed tools', async () => {
        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(sessions.create).toHaveBeenCalledWith(
          expect.any(String),
          '/tmp/workspace',
          expect.objectContaining({
            allowedTools: expect.arrayContaining(['Write']),
            addDirs: ['/home/user/.codekin/pr-cache/owner/repo'],
          }),
        )
      })

      it('works when cache and comment return undefined (first review)', async () => {
        mockLoadPrCache.mockReturnValueOnce(undefined)
        mockFetchExistingReviewComment.mockResolvedValueOnce(undefined)

        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(result.statusCode).toBe(202)
        expect(mockBuildPrReviewPrompt).toHaveBeenCalledWith(
          expect.any(Object),
          '/tmp/workspace',
          expect.objectContaining({
            priorCache: undefined,
            existingCommentId: undefined,
          }),
        )
      })
    })

    describe('auto-cleanup on result', () => {
      it('deletes webhook session after successful result', async () => {
        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        const eventId = result.body.eventId as string
        const event = handler.getEvent(eventId)
        expect(event?.status).toBe('session_created')

        for (const cb of sessions._resultCallbacks) {
          cb(event!.sessionId!, false)
        }

        expect(handler.getEvent(eventId)?.status).toBe('completed')
        expect(sessions.delete).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(2000)
        expect(sessions.delete).toHaveBeenCalledWith(event!.sessionId)
      })

      it('does not delete session on error result', async () => {
        await handler.checkHealth()
        const payload = makePrPayload()
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        const event = handler.getEvent(result.body.eventId as string)

        for (const cb of sessions._resultCallbacks) {
          cb(event!.sessionId!, true)
        }

        expect(handler.getEvent(result.body.eventId as string)?.status).toBe('session_created')
        await vi.advanceTimersByTimeAsync(5000)
        expect(sessions.delete).not.toHaveBeenCalled()
      })

      it('ignores result for non-webhook sessions', async () => {
        await handler.checkHealth()

        for (const cb of sessions._resultCallbacks) {
          cb('unknown-session-id', false)
        }

        await vi.advanceTimersByTimeAsync(5000)
        expect(sessions.delete).not.toHaveBeenCalled()
      })
    })

    describe('PR closed/merged cleanup', () => {
      function makeClosedPrPayload(merged: boolean) {
        const payload = makePrPayload({ action: 'closed' })
        payload.pull_request.merged = merged
        payload.pull_request.state = 'closed'
        return payload
      }

      it('returns 200 for closed action with merged: true and archives cache', async () => {
        await handler.checkHealth()
        const payload = makeClosedPrPayload(true)
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body))

        expect(result.statusCode).toBe(200)
        expect(result.body.accepted).toBe(true)
        expect(result.body.action).toBe('merged')
        expect(mockArchivePrCache).toHaveBeenCalledWith('owner/repo', 42)
        expect(mockDeletePrCache).not.toHaveBeenCalled()
      })

      it('returns 200 for closed action with merged: false and deletes cache', async () => {
        await handler.checkHealth()
        const payload = makeClosedPrPayload(false)
        const body = Buffer.from(JSON.stringify(payload))
        const result = await handler.handleWebhook(body, makePrHeaders(body))

        expect(result.statusCode).toBe(200)
        expect(result.body.accepted).toBe(true)
        expect(result.body.action).toBe('closed')
        expect(mockDeletePrCache).toHaveBeenCalledWith('owner/repo', 42)
        expect(mockArchivePrCache).not.toHaveBeenCalled()
      })

      it('does not create a workspace or session for closed action', async () => {
        await handler.checkHealth()
        vi.mocked(createWorkspace).mockClear()
        sessions.create.mockClear()
        const payload = makeClosedPrPayload(true)
        const body = Buffer.from(JSON.stringify(payload))
        await handler.handleWebhook(body, makePrHeaders(body))
        await vi.advanceTimersByTimeAsync(100)

        expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled()
        expect(sessions.create).not.toHaveBeenCalled()
      })

      it('kills active sessions for the same PR on close', async () => {
        await handler.checkHealth()

        // First: open a PR review session
        const openPayload = makePrPayload({ action: 'opened' })
        const openBody = Buffer.from(JSON.stringify(openPayload))
        const openResult = await handler.handleWebhook(openBody, makePrHeaders(openBody, { delivery: 'pr-open' }))
        await vi.advanceTimersByTimeAsync(100)
        const openEvent = handler.getEvent(openResult.body.eventId as string)
        expect(openEvent?.status).toBe('session_created')

        // Then: close the PR
        const closePayload = makeClosedPrPayload(false)
        const closeBody = Buffer.from(JSON.stringify(closePayload))
        await handler.handleWebhook(closeBody, makePrHeaders(closeBody, { delivery: 'pr-close' }))

        // The open session should be superseded
        const openEventAfter = handler.getEvent(openResult.body.eventId as string)
        expect(openEventAfter?.status).toBe('superseded')
        expect(sessions.delete).toHaveBeenCalledWith(openEvent?.sessionId)
      })
    })
  })
})
