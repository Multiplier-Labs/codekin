/**
 * REST routes for the Shepherd orchestrator session.
 *
 * Provides status and start endpoints so the frontend can discover
 * and connect to the always-on Shepherd session.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { SessionManager } from './session-manager.js'
import { ensureShepherdRunning, getShepherdSessionId } from './shepherd-manager.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createShepherdRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
): Router {
  const router = Router()

  /** Get Shepherd session status. */
  router.get('/api/shepherd/status', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = getShepherdSessionId(sessions)
    if (!sessionId) {
      return res.json({ sessionId: null, status: 'stopped' })
    }

    const session = sessions.get(sessionId)
    const status = session?.claudeProcess?.isAlive() ? 'active' : 'idle'
    res.json({ sessionId, status })
  })

  /** Ensure Shepherd is running and return its session ID. */
  router.post('/api/shepherd/start', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const sessionId = ensureShepherdRunning(sessions)
      res.json({ sessionId, status: 'active' })
    } catch (err) {
      console.error('[shepherd] Failed to start:', err)
      res.status(500).json({ error: 'Failed to start Shepherd' })
    }
  })

  return router
}
