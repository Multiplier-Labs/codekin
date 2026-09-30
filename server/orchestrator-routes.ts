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
import { createTaskRouter } from './orchestrator-task-router.js'
import type { OrchestratorTaskService } from './orchestrator-tasks.js'
import { createAutomationRouter } from './automation-routes.js'
import type { AutomationService } from './automation-service.js'
import { createJoeSessionRouter } from './joe-session-routes.js'
import type { JoeSessionBridge } from './joe-session-bridge.js'
import { createMaintenanceRouter } from './maintenance-routes.js'
import type { MaintenanceService } from './maintenance-service.js'

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
  tasks?: OrchestratorTaskService,
  automations?: AutomationService,
  joeBridge?: JoeSessionBridge,
  maintenance?: MaintenanceService,
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

  /** The master token is the user; the orchestrator's scoped session token is Joe. */
  function actorOf(req: Request): 'user' | 'joe' {
    return verifyToken(extractToken(req)) ? 'user' : 'joe'
  }

  // Mount sub-routers. The Joe session routes go first: their paths are more
  // specific than the session router's /sessions/:id handlers.
  if (joeBridge) router.use(createJoeSessionRouter(verifyOrchestratorAuth, actorOf, joeBridge))
  router.use(createSessionRouter(verifyOrchestratorAuth, sessions, memory, children, monitorRef, tasks))
  if (tasks) router.use(createTaskRouter(verifyOrchestratorAuth, actorOf, tasks))
  if (automations) router.use(createAutomationRouter(verifyOrchestratorAuth, actorOf, automations))
  if (maintenance && automations) router.use(createMaintenanceRouter(verifyOrchestratorAuth, actorOf, maintenance, (repo) => automations.isValidRepo(repo)))
  router.use(createMemoryRouter(verifyOrchestratorAuth, memory, monitorRef))
  router.use(createLearningRouter(verifyOrchestratorAuth, memory))

  return router
}
