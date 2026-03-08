import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'

// Hoisted mock fns accessible in both mock factory and tests
const mockIsDuplicate = vi.hoisted(() => vi.fn(() => false))
const mockDedupShutdown = vi.hoisted(() => vi.fn())

// Mock all webhook sub-modules before importing the handler
vi.mock('./webhook-dedup.js', () => {
  class MockWebhookDedup {
    isDuplicate = mockIsDuplicate
    shutdown = mockDedupShutdown
    flushToDisk = vi.fn()
  }
  return {
    WebhookDedup: MockWebhookDedup,
    computeIdempotencyKey: vi.fn(() => 'mock-idempotency-key'),
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
    ...overrides,
  }
}

type ExitCallback = (sessionId: string, code: number, signal: string | null, willRestart: boolean) => void

function fakeSessionManager() {
  const exitCallbacks: ExitCallback[] = []
  return {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 'session-1' })),
    get: vi.fn(() => null),
    broadcast: vi.fn(),
    sendInput: vi.fn(),
    onSessionExit: vi.fn((cb: ExitCallback) => { exitCallbacks.push(cb) }),
    _exitCallbacks: exitCallbacks,
  } as unknown as ReturnType<typeof fakeSessionManager>
}

function makePayload(overrides: Record<string, unknown> = {}) {
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
})
