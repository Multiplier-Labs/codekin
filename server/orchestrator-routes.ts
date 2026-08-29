/**
 * REST routes for the orchestrator session.
 *
 * Thin wrapper that mounts focused sub-routers for session management,
 * memory/trust, and learning endpoints.
 */

import { Router } from 'express'
import type { Request } from 'express'
import type { SessionManager } from './session-manager.js'
import { getOrCreateOrchestratorId } from './orchestrator-manager.js'
import { OrchestratorMemory } from './orchestrator-memory.js'
import { OrchestratorChildManager } from './orchestrator-children.js'
import type { OrchestratorMonitor } from './orchestrator-monitor.js'
import type { RunStore } from './run-store.js'
import { createSessionRouter } from './orchestrator-session-router.js'
import { createMemoryRouter } from './orchestrator-memory-router.js'
import { createLearningRouter } from './orchestrator-learning-router.js'

type VerifyFn = (token: string | undefined) => boolean
type VerifySessionFn = (token: string | undefined, sessionId: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createOrchestratorRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
  monitorRef?: { current: OrchestratorMonitor | null },
  verifyTokenOrSessionToken?: VerifySessionFn,
  injectedMemory?: OrchestratorMemory,
  injectedChildren?: OrchestratorChildManager,
  runStore?: RunStore,
): Router {
  const router = Router()
  const memory = injectedMemory ?? new OrchestratorMemory()
  const children = injectedChildren ?? new OrchestratorChildManager(sessions, { runStore })

  /**
   * Verify that the request is authorized — accepts either the master auth
   * token OR the orchestrator session's scoped token.
   */
  function verifyOrchestratorAuth(req: Request): boolean {
    const token = extractToken(req)
    if (verifyToken(token)) return true
    if (verifyTokenOrSessionToken) {
      const orchestratorId = getOrCreateOrchestratorId()
      return verifyTokenOrSessionToken(token, orchestratorId)
    }
    return false
  }

  // Mount sub-routers
  router.use(createSessionRouter(verifyOrchestratorAuth, sessions, memory, children, monitorRef))
  router.use(createMemoryRouter(verifyOrchestratorAuth, memory, monitorRef))
  router.use(createLearningRouter(verifyOrchestratorAuth, memory))

  return router
}
