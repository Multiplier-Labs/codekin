/**
 * Auth and health REST routes.
 *
 * Mounted directly on the Express app (no path prefix).
 */

import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { SessionManager } from './session-manager.js'

/** Simple per-IP rate limiter for auth endpoints. */
function createIpRateLimiter(maxPerMinute: number): RequestHandler {
  const ipTimestamps = new Map<string, number[]>()

  // Periodic cleanup to prevent unbounded memory growth
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [ip, timestamps] of ipTimestamps) {
      const recent = timestamps.filter(t => now - t < 60_000)
      if (recent.length === 0) ipTimestamps.delete(ip)
      else ipTimestamps.set(ip, recent)
    }
  }, 5 * 60_000)
  if (cleanup.unref) cleanup.unref()

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const timestamps = (ipTimestamps.get(ip) ?? []).filter(t => now - t < 60_000)

    if (timestamps.length >= maxPerMinute) {
      ipTimestamps.set(ip, timestamps)
      return res.status(429).json({ error: 'Too Many Requests', retryAfter: 60 })
    }

    timestamps.push(now)
    ipTimestamps.set(ip, timestamps)
    next()
  }
}

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/**
 * Create an Express router with auth verification and health-check endpoints.
 *
 * @param verifyToken     - Returns true if the given bearer token is valid.
 * @param extractToken    - Extracts the bearer token from an incoming request (header, cookie, etc.).
 * @param sessions        - Session manager instance, used to report active/total session counts.
 * @param claudeAvailable - Whether the Claude CLI binary was found at startup.
 * @param claudeVersion   - Version string of the detected Claude CLI.
 * @param apiKeySet       - Whether an Anthropic API key is configured.
 * @returns An Express Router with POST `/auth-verify` and GET `/api/health` routes.
 */
export function createAuthRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
  claudeAvailable: boolean,
  claudeVersion: string,
  apiKeySet: boolean,
): Router {
  const router = Router()
  const authVerifyLimiter = createIpRateLimiter(10)

  router.post('/auth-verify', authVerifyLimiter, (req, res) => {
    const token = extractToken(req)
    res.json({ valid: verifyToken(token) })
  })

  router.get('/api/health', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const allSessions = sessions.list()
    res.json({
      status: 'ok',
      claudeAvailable,
      claudeVersion,
      apiKeySet,
      claudeSessions: allSessions.filter(s => s.active).length,
      totalSessions: allSessions.length,
    })
  })

  return router
}
