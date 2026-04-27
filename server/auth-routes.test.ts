/** Tests for createAuthRouter — verifies /auth-verify, /api/health, and IP rate limiting. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createAuthRouter } from './auth-routes.js'
import type { SessionManager } from './session-manager.js'

const TOKEN = 'good'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: Request) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
}

function fakeSessions(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    list: vi.fn(() => [
      { id: 'a', active: true } as never,
      { id: 'b', active: false } as never,
      { id: 'c', active: true } as never,
    ]),
    ...overrides,
  } as unknown as SessionManager
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

describe('createAuthRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }

  afterEach(async () => {
    await server?.close()
  })

  describe('POST /auth-verify', () => {
    beforeEach(async () => {
      const router = createAuthRouter(verifyToken, extractToken, fakeSessions(), true, '1.0.0', true)
      server = await startApp(router)
    })

    it('returns valid=true for a good token', async () => {
      const res = await fetch(`${server.baseUrl}/auth-verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(true)
    })

    it('returns valid=false for a bad token (not 401)', async () => {
      const res = await fetch(`${server.baseUrl}/auth-verify`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(false)
    })

    it('returns valid=false when no token supplied', async () => {
      const res = await fetch(`${server.baseUrl}/auth-verify`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(false)
    })

    it('rate-limits after 10 requests per minute per IP', async () => {
      // Fire 11 rapid requests
      const results: number[] = []
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${server.baseUrl}/auth-verify`, { method: 'POST' })
        results.push(res.status)
      }
      // First 10 succeed (200), 11th is 429
      expect(results.slice(0, 10).every(s => s === 200)).toBe(true)
      expect(results[10]).toBe(429)
    })
  })

  describe('GET /api/health', () => {
    beforeEach(async () => {
      const router = createAuthRouter(verifyToken, extractToken, fakeSessions(), true, '2.0.0', false)
      server = await startApp(router)
    })

    it('requires auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/health`)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('rejects invalid token with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/health`, {
        headers: { Authorization: 'Bearer wrong' },
      })
      expect(res.status).toBe(401)
    })

    it('returns health payload with active and total session counts', async () => {
      const res = await fetch(`${server.baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.claudeAvailable).toBe(true)
      expect(body.claudeVersion).toBe('2.0.0')
      expect(body.apiKeySet).toBe(false)
      expect(body.claudeSessions).toBe(2)
      expect(body.totalSessions).toBe(3)
    })
  })
})
