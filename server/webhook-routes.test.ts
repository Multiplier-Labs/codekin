/**
 * Tests for createWebhookRouter — webhook + stepflow management endpoints.
 *
 * Verifies auth on every route, the listing/lookup happy paths, and 404
 * handling when an event id does not exist.  Handlers are stubbed via
 * partial fakes so tests stay isolated from real persistence.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createWebhookRouter } from './webhook-routes.js'
import type { WebhookHandler } from './webhook-handler.js'
import type { StepflowHandler } from './stepflow-handler.js'

const TOKEN = 'good-token'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: Request) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` }
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

function makeWebhookHandler(): WebhookHandler {
  return {
    getEvents: vi.fn(() => [
      { id: 'evt-1', repo: 'owner/foo', status: 'completed' },
      { id: 'evt-2', repo: 'owner/bar', status: 'processing' },
    ]),
    getEvent: vi.fn((id: string) =>
      id === 'evt-1' ? { id: 'evt-1', repo: 'owner/foo', status: 'completed' } : undefined,
    ),
    getConfig: vi.fn(() => ({ enabled: true, secret: 'redacted' })),
  } as unknown as WebhookHandler
}

function makeStepflowHandler(): StepflowHandler {
  return {
    getEvents: vi.fn(() => [
      { id: 'sf-1', kind: 'pr-build', status: 'queued' },
    ]),
    getEvent: vi.fn((id: string) =>
      id === 'sf-1' ? { id: 'sf-1', kind: 'pr-build', status: 'queued' } : undefined,
    ),
  } as unknown as StepflowHandler
}

describe('createWebhookRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }
  let webhookHandler: WebhookHandler
  let stepflowHandler: StepflowHandler

  beforeEach(async () => {
    webhookHandler = makeWebhookHandler()
    stepflowHandler = makeStepflowHandler()
    const router = createWebhookRouter(verifyToken, extractToken, webhookHandler, stepflowHandler)
    server = await startApp(router)
  })

  afterEach(async () => {
    await server.close()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // /api/webhooks/events
  // -------------------------------------------------------------------------

  describe('GET /api/webhooks/events', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/events`)
      expect(res.status).toBe(401)
    })

    it('returns the list of events with auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/events`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.events).toHaveLength(2)
      expect(body.events[0].id).toBe('evt-1')
      expect(webhookHandler.getEvents).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // /api/webhooks/events/:id
  // -------------------------------------------------------------------------

  describe('GET /api/webhooks/events/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/events/evt-1`)
      expect(res.status).toBe(401)
    })

    it('returns the event for a known id', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/events/evt-1`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.event.id).toBe('evt-1')
      expect(webhookHandler.getEvent).toHaveBeenCalledWith('evt-1')
    })

    it('returns 404 for an unknown id', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/events/no-such-id`, { headers: auth() })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toMatch(/not found/i)
    })
  })

  // -------------------------------------------------------------------------
  // /api/webhooks/config
  // -------------------------------------------------------------------------

  describe('GET /api/webhooks/config', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/config`)
      expect(res.status).toBe(401)
    })

    it('returns the webhook config with auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/webhooks/config`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.config).toEqual({ enabled: true, secret: 'redacted' })
    })
  })

  // -------------------------------------------------------------------------
  // /api/stepflow/events
  // -------------------------------------------------------------------------

  describe('GET /api/stepflow/events', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/stepflow/events`)
      expect(res.status).toBe(401)
    })

    it('returns the list of stepflow events with auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/stepflow/events`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.events).toHaveLength(1)
      expect(body.events[0].id).toBe('sf-1')
    })
  })

  // -------------------------------------------------------------------------
  // /api/stepflow/events/:id
  // -------------------------------------------------------------------------

  describe('GET /api/stepflow/events/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/stepflow/events/sf-1`)
      expect(res.status).toBe(401)
    })

    it('returns the stepflow event for a known id', async () => {
      const res = await fetch(`${server.baseUrl}/api/stepflow/events/sf-1`, { headers: auth() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.event.id).toBe('sf-1')
    })

    it('returns 404 for an unknown stepflow id', async () => {
      const res = await fetch(`${server.baseUrl}/api/stepflow/events/missing`, { headers: auth() })
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Token extraction
  // -------------------------------------------------------------------------

  it('rejects with 401 when Authorization header is malformed', async () => {
    const res = await fetch(`${server.baseUrl}/api/webhooks/events`, {
      headers: { Authorization: 'NotBearer token' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects with 401 when token is wrong', async () => {
    const res = await fetch(`${server.baseUrl}/api/webhooks/config`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })
})
