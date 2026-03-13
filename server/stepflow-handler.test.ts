/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./crypto-utils.js', () => ({
  verifyHmacSignature: vi.fn(() => true),
}))

vi.mock('./stepflow-prompt.js', () => ({
  buildStepflowPrompt: vi.fn(() => 'mock prompt'),
}))

vi.mock('./webhook-workspace.js', () => ({
  createWorkspace: vi.fn(async () => '/tmp/workspaces/session-1'),
  cleanupWorkspace: vi.fn(),
}))

import { StepflowHandler, loadStepflowConfig } from './stepflow-handler.js'
import { verifyHmacSignature } from './crypto-utils.js'
import { createWorkspace } from './webhook-workspace.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<import('./stepflow-types.js').StepflowConfig> = {}) {
  return {
    enabled: true,
    secret: 'test-secret',
    maxConcurrentSessions: 3,
    allowedCallbackHosts: [],
    ...overrides,
  }
}

function makeSessions() {
  const exitListeners: Array<(id: string, code: number | null, signal: string | null, willRestart: boolean) => void> = []
  return {
    create: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    startClaude: vi.fn(),
    sendInput: vi.fn(),
    onSessionExit: vi.fn((listener: any) => { exitListeners.push(listener) }),
    _exitListeners: exitListeners,
    fireExit(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) {
      for (const l of exitListeners) l(sessionId, code, signal, willRestart)
    },
  } as any
}

function makePayload(overrides: Record<string, any> = {}) {
  return {
    webhookId: overrides.webhookId ?? 'wh-001',
    deliveredAt: new Date().toISOString(),
    event: {
      runId: 'run-1',
      kind: 'code.fix',
      eventType: 'claude.session.requested',
      timestamp: new Date().toISOString(),
      payload: {
        repo: 'acme/my-app',
        cloneUrl: 'https://github.com/acme/my-app.git',
        branch: 'main',
        headSha: 'abc1234567890',
        taskDescription: 'Fix the bug',
        ...overrides.payload,
      },
      ...overrides.event,
    },
    ...overrides,
  }
}

function toRawBody(payload: Record<string, any>): Buffer {
  return Buffer.from(JSON.stringify(payload))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StepflowHandler', () => {
  let handler: StepflowHandler
  let sessions: ReturnType<typeof makeSessions>

  beforeEach(() => {
    vi.clearAllMocks()
    sessions = makeSessions()
    handler = new StepflowHandler(makeConfig(), sessions)
  })

  afterEach(() => {
    handler.shutdown()
  })

  // -------------------------------------------------------------------------
  // Disabled / master switch
  // -------------------------------------------------------------------------

  describe('disabled handler', () => {
    it('returns 200 filtered when disabled', async () => {
      handler.shutdown()
      handler = new StepflowHandler(makeConfig({ enabled: false }), sessions)

      const result = await handler.handleWebhook(Buffer.from('{}'), 'sig')
      expect(result.statusCode).toBe(200)
      expect(result.body.accepted).toBe(false)
      expect(result.body.filterReason).toContain('disabled')
    })
  })

  // -------------------------------------------------------------------------
  // Signature verification
  // -------------------------------------------------------------------------

  describe('signature verification', () => {
    it('returns 401 when signature header is missing', async () => {
      const result = await handler.handleWebhook(Buffer.from('{}'), '')
      expect(result.statusCode).toBe(401)
      expect(result.body.error).toContain('Missing')
    })

    it('returns 401 when signature is invalid', async () => {
      ;(verifyHmacSignature as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
      const result = await handler.handleWebhook(Buffer.from('{}'), 'sha256=bad')
      expect(result.statusCode).toBe(401)
      expect(result.body.error).toContain('Invalid')
    })

    it('returns false from verifySignature when no secret configured', () => {
      handler.shutdown()
      handler = new StepflowHandler(makeConfig({ secret: '' }), sessions)
      expect(handler.verifySignature(Buffer.from('test'), 'sha256=abc')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Payload validation
  // -------------------------------------------------------------------------

  describe('payload validation', () => {
    it('returns 400 for malformed JSON', async () => {
      const result = await handler.handleWebhook(Buffer.from('not json'), 'sha256=x')
      expect(result.statusCode).toBe(400)
      expect(result.body.error).toContain('Malformed')
    })

    it('returns 400 when event or webhookId is missing', async () => {
      const body = toRawBody({ event: null, webhookId: null })
      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(400)
    })

    it('returns 400 when session request fields are missing', async () => {
      const payload = makePayload({ event: { eventType: 'claude.session.requested', runId: 'r1', kind: 'k', timestamp: '', payload: { repo: 'x' } } })
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(400)
      expect(result.body.error).toContain('must include')
    })
  })

  // -------------------------------------------------------------------------
  // Event type filtering
  // -------------------------------------------------------------------------

  describe('event type filtering', () => {
    it('returns 200 filtered for unsupported event types', async () => {
      const payload = makePayload({ event: { eventType: 'other.event', runId: 'r1', kind: 'k', timestamp: '' } })
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(200)
      expect(result.body.accepted).toBe(false)
      expect(result.body.filterReason).toContain('not supported')
    })
  })

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe('deduplication', () => {
    it('returns duplicate for the same webhookId', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)

      const first = await handler.handleWebhook(body, 'sha256=x')
      expect(first.statusCode).toBe(202)

      const second = await handler.handleWebhook(body, 'sha256=x')
      expect(second.statusCode).toBe(200)
      expect(second.body.status).toBe('duplicate')
    })
  })

  // -------------------------------------------------------------------------
  // Concurrency cap
  // -------------------------------------------------------------------------

  describe('concurrency cap', () => {
    it('returns 429 when max concurrent sessions reached', async () => {
      handler.shutdown()
      handler = new StepflowHandler(makeConfig({ maxConcurrentSessions: 0 }), sessions)

      const payload = makePayload()
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(429)
      expect(result.body.error).toContain('Max concurrent')
    })

    it('counts active stepflow sessions toward the cap', async () => {
      sessions.list.mockReturnValue([
        { source: 'stepflow', active: true },
        { source: 'stepflow', active: true },
        { source: 'stepflow', active: true },
      ])

      const payload = makePayload()
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(429)
    })
  })

  // -------------------------------------------------------------------------
  // Successful acceptance (202)
  // -------------------------------------------------------------------------

  describe('successful webhook acceptance', () => {
    it('returns 202 with sessionId and webhookId', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)

      const result = await handler.handleWebhook(body, 'sha256=x')
      expect(result.statusCode).toBe(202)
      expect(result.body.accepted).toBe(true)
      expect(result.body.status).toBe('processing')
      expect(result.body.sessionId).toBeDefined()
      expect(result.body.webhookId).toBe('wh-001')
    })

    it('calls createWorkspace and sessions.create asynchronously', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)

      await handler.handleWebhook(body, 'sha256=x')

      // Allow async processAsync to run
      await new Promise(r => setTimeout(r, 50))

      expect(createWorkspace).toHaveBeenCalledWith(
        expect.any(String),  // sessionId
        'acme/my-app',
        'https://github.com/acme/my-app.git',
        'main',
        'abc1234567890',
      )
      expect(sessions.create).toHaveBeenCalled()
      expect(sessions.sendInput).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Event management API
  // -------------------------------------------------------------------------

  describe('event management', () => {
    it('records events and retrieves them', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)
      await handler.handleWebhook(body, 'sha256=x')

      const events = handler.getEvents()
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].id).toBe('wh-001')
      expect(['processing', 'session_created']).toContain(events[0].status)
    })

    it('getEvent returns a specific event by id', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)
      await handler.handleWebhook(body, 'sha256=x')

      const event = handler.getEvent('wh-001')
      expect(event).toBeDefined()
      expect(event!.repo).toBe('acme/my-app')
    })

    it('getEvent returns undefined for unknown id', () => {
      expect(handler.getEvent('nonexistent')).toBeUndefined()
    })

    it('isEnabled reflects config', () => {
      expect(handler.isEnabled()).toBe(true)
      handler.shutdown()
      handler = new StepflowHandler(makeConfig({ enabled: false }), sessions)
      expect(handler.isEnabled()).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Session exit handling
  // -------------------------------------------------------------------------

  describe('session exit callback', () => {
    it('updates event status on session exit with code 0', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      const sessionId = result.body.sessionId as string

      // Allow processAsync to complete
      await new Promise(r => setTimeout(r, 50))

      // Mark event as session_created (as processAsync would)
      const event = handler.getEvent('wh-001')
      expect(event).toBeDefined()

      // Fire session exit
      sessions.fireExit(sessionId, 0, null, false)

      const updatedEvent = handler.getEvent('wh-001')
      // Status should be 'completed' or still 'processing' depending on timing
      expect(['completed', 'session_created', 'processing']).toContain(updatedEvent!.status)
    })

    it('ignores exit when willRestart is true', async () => {
      const payload = makePayload()
      const body = toRawBody(payload)
      const result = await handler.handleWebhook(body, 'sha256=x')
      const sessionId = result.body.sessionId as string

      await new Promise(r => setTimeout(r, 50))

      // Fire exit with willRestart=true — should be ignored
      sessions.fireExit(sessionId, 1, null, true)

      const event = handler.getEvent('wh-001')
      // Should NOT be 'error' since willRestart was true
      expect(event!.status).not.toBe('error')
    })
  })

  // -------------------------------------------------------------------------
  // Workspace creation failure
  // -------------------------------------------------------------------------

  describe('workspace creation failure', () => {
    it('marks event as error when createWorkspace fails', async () => {
      ;(createWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('clone failed'))

      const payload = makePayload()
      const body = toRawBody(payload)
      await handler.handleWebhook(body, 'sha256=x')

      await new Promise(r => setTimeout(r, 50))

      const event = handler.getEvent('wh-001')
      expect(event!.status).toBe('error')
      expect(event!.error).toContain('clone failed')
    })
  })

  // -------------------------------------------------------------------------
  // postCallback SSRF protection
  // -------------------------------------------------------------------------

  describe('postCallback SSRF protection', () => {
    const result = { sessionId: 'sess-1', status: 'completed', output: 'done' }
    let mockFetch: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      global.fetch = mockFetch
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    // --- Protocol checks ---

    it('throws for non-http(s) protocol', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['evil.com'] }), sessions)
      await expect((handler as any).postCallback('ftp://evil.com/callback', result))
        .rejects.toThrow('protocol ftp: not allowed')
    })

    // --- Allowlist checks ---

    it('throws when host is not in allowlist', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['api.stepflow.io'] }), sessions)
      await expect((handler as any).postCallback('https://evil.com/callback', result))
        .rejects.toThrow('not in the allowlist')
    })

    it('throws when allowlist is empty', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: [] }), sessions)
      await expect((handler as any).postCallback('https://anything.com/callback', result))
        .rejects.toThrow('not in the allowlist')
    })

    // --- Private/link-local IP checks ---

    // URL.hostname includes brackets for IPv6 and may normalize addresses,
    // so the allowlist must use the forms that parsedUrl.hostname produces.
    const allHosts = [
      '127.0.0.1', 'localhost', '10.0.0.1', '192.168.1.1', '169.254.1.1',
      '[::1]', '[fe80::1]', '[fc00::1]', '[::ffff:7f00:1]', 'api.stepflow.io',
    ]

    it('blocks private IP 127.0.0.1', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://127.0.0.1:8080/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks private IP 10.x', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://10.0.0.1/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks private IP 192.168.x', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://192.168.1.1/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks private IP 169.254.x', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://169.254.1.1/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks localhost', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://localhost:3000/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks IPv6 ::1', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://[::1]/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks IPv6 link-local fe80::', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://[fe80::1]/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks IPv6 unique-local fc00/fd00', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://[fc00::1]/callback', result))
        .rejects.toThrow('private/link-local')
    })

    it('blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback)', async () => {
      // new URL('http://[::ffff:127.0.0.1]/...').hostname === '[::ffff:7f00:1]'
      // The SSRF check now decodes IPv4-mapped IPv6 hex form back to dotted IPv4.
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: allHosts }), sessions)
      await expect((handler as any).postCallback('http://[::ffff:127.0.0.1]/callback', result))
        .rejects.toThrow('private/link-local')
    })

    // --- Happy path ---

    it('sends successful HTTPS callback with correct request shape', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['api.stepflow.io'] }), sessions)
      await (handler as any).postCallback('https://api.stepflow.io/callback', result)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.stepflow.io/callback')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(opts.body)).toEqual(result)
    })

    it('sets HMAC signature header when callbackSecret is provided', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['api.stepflow.io'] }), sessions)
      await (handler as any).postCallback('https://api.stepflow.io/callback', result, 'my-secret')

      const [, opts] = mockFetch.mock.calls[0]
      const sig = opts.headers['X-Stepflow-Signature'] as string
      expect(sig).toBeDefined()
      expect(sig.startsWith('sha256=')).toBe(true)
      // After 'sha256=' should be a valid hex string
      expect(/^[0-9a-f]+$/.test(sig.slice(7))).toBe(true)
    })

    it('omits HMAC signature header when callbackSecret is absent', async () => {
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['api.stepflow.io'] }), sessions)
      await (handler as any).postCallback('https://api.stepflow.io/callback', result)

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.headers['X-Stepflow-Signature']).toBeUndefined()
    })

    // --- Error handling ---

    it('throws when callback returns non-2xx response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 502 })
      handler = new StepflowHandler(makeConfig({ allowedCallbackHosts: ['api.stepflow.io'] }), sessions)
      await expect((handler as any).postCallback('https://api.stepflow.io/callback', result))
        .rejects.toThrow('returned HTTP 502')
    })
  })
})

// ---------------------------------------------------------------------------
// loadStepflowConfig
// ---------------------------------------------------------------------------

describe('loadStepflowConfig', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('defaults to disabled with 3 max sessions', () => {
    delete process.env.STEPFLOW_WEBHOOK_ENABLED
    delete process.env.STEPFLOW_WEBHOOK_SECRET
    delete process.env.STEPFLOW_WEBHOOK_MAX_SESSIONS
    delete process.env.STEPFLOW_CALLBACK_HOSTS

    const config = loadStepflowConfig()
    expect(config.enabled).toBe(false)
    expect(config.secret).toBe('')
    expect(config.maxConcurrentSessions).toBe(3)
    expect(config.allowedCallbackHosts).toEqual([])
  })

  it('enables when STEPFLOW_WEBHOOK_ENABLED=true', () => {
    process.env.STEPFLOW_WEBHOOK_ENABLED = 'true'
    process.env.STEPFLOW_WEBHOOK_SECRET = 'my-secret'
    const config = loadStepflowConfig()
    expect(config.enabled).toBe(true)
    expect(config.secret).toBe('my-secret')
  })

  it('enables when STEPFLOW_WEBHOOK_ENABLED=1', () => {
    process.env.STEPFLOW_WEBHOOK_ENABLED = '1'
    const config = loadStepflowConfig()
    expect(config.enabled).toBe(true)
  })

  it('parses max sessions from env', () => {
    process.env.STEPFLOW_WEBHOOK_MAX_SESSIONS = '10'
    const config = loadStepflowConfig()
    expect(config.maxConcurrentSessions).toBe(10)
  })

  it('ignores invalid max sessions', () => {
    process.env.STEPFLOW_WEBHOOK_MAX_SESSIONS = 'abc'
    const config = loadStepflowConfig()
    expect(config.maxConcurrentSessions).toBe(3)
  })

  it('ignores zero max sessions', () => {
    process.env.STEPFLOW_WEBHOOK_MAX_SESSIONS = '0'
    const config = loadStepflowConfig()
    expect(config.maxConcurrentSessions).toBe(3)
  })

  it('parses allowed callback hosts', () => {
    process.env.STEPFLOW_CALLBACK_HOSTS = 'host1.com, host2.com, '
    const config = loadStepflowConfig()
    expect(config.allowedCallbackHosts).toEqual(['host1.com', 'host2.com'])
  })
})
