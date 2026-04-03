/**
 * Auth and health REST routes.
 *
 * Mounted directly on the Express app (no path prefix).
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { SessionManager } from './session-manager.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/** Per-IP rate limiter for auth-verify to prevent token enumeration. */
const authVerifyAttempts = new Map<string, { count: number; resetAt: number }>()
const AUTH_VERIFY_WINDOW_MS = 60_000
const AUTH_VERIFY_MAX_ATTEMPTS = 20

setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of authVerifyAttempts) {
    if (now >= entry.resetAt) authVerifyAttempts.delete(ip)
  }
}, AUTH_VERIFY_WINDOW_MS)

function checkAuthVerifyRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = authVerifyAttempts.get(ip)
  if (!entry || now >= entry.resetAt) {
    authVerifyAttempts.set(ip, { count: 1, resetAt: now + AUTH_VERIFY_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= AUTH_VERIFY_MAX_ATTEMPTS
}

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

  router.post('/auth-verify', (req, res) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
    if (!checkAuthVerifyRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests' })
    }
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
