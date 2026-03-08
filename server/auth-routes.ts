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
