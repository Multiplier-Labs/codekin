/**
 * Orchestrator identity — the stable session ID and workspace directory.
 *
 * Split out of orchestrator-manager.ts to break a module-initialisation cycle:
 * the outbox needs to resolve the orchestrator's session ID, while the manager
 * needs the outbox to queue its startup greeting. Both now depend on this leaf
 * module instead of on each other.
 *
 * Keep this module dependency-light — it sits underneath both the manager and
 * the outbox, so anything imported here is pulled into both.
 */

import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { DATA_DIR } from './config.js'
import type { SessionManager } from './session-manager.js'

/** The orchestrator's workspace directory (profile, memory, outbox, journals). */
export const ORCHESTRATOR_DIR = join(DATA_DIR, 'orchestrator')

/** Holds the orchestrator's stable session ID across server restarts. */
const SESSION_ID_FILE = join(ORCHESTRATOR_DIR, '.session-id')

/**
 * Read the orchestrator's stable session ID, minting and persisting one on
 * first call. The ID outlives any individual session object so the orchestrator
 * keeps its identity (and accumulated memory) across restarts.
 */
export function getOrCreateOrchestratorId(): string {
  if (existsSync(SESSION_ID_FILE)) {
    const id = readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    if (id) return id
  }
  const id = randomUUID()
  writeFileSync(SESSION_ID_FILE, id, 'utf-8')
  return id
}

/**
 * Resolve the orchestrator's *live* session ID — the stable ID, but only if a
 * session currently exists for it. Returns null when the orchestrator has never
 * started or its session has since been removed.
 */
export function getOrchestratorSessionId(sessions: SessionManager): string | null {
  const stableId = existsSync(SESSION_ID_FILE)
    ? readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    : null
  if (!stableId) return null
  return sessions.get(stableId) ? stableId : null
}
