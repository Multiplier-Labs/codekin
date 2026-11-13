/**
 * Client for Agent Joe inside repo sessions: execution handover and the
 * tasks linked to a session (server/joe-session-routes.ts).
 */

import { joeRequest } from './request'
import type { SessionController } from '../types'
import type { TaskList } from './tasksApi'

/** Hand the session's execution to Joe. */
export async function handOverToJoe(token: string, sessionId: string, taskId?: string): Promise<SessionController> {
  return (await joeRequest<{ controller: SessionController }>(token, `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/handover`, { method: 'POST', body: taskId ? { taskId } : {} })).controller
}

/** Take execution back from Joe; later Joe instructions are refused. */
export async function takeBackControl(token: string, sessionId: string): Promise<SessionController> {
  return (await joeRequest<{ controller: SessionController }>(token, `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/take-back`, { method: 'POST' })).controller
}

/** Tasks started from, or executing in, a session. */
export function listSessionTasks(token: string, sessionId: string): Promise<TaskList> {
  return joeRequest<TaskList>(token, `/api/orchestrator/tasks?session=${encodeURIComponent(sessionId)}`)
}

/** The controller a session has when none was ever set (mirrors the server). */
export function effectiveOwner(session: { controller?: SessionController; source?: string } | undefined): 'user' | 'joe' {
  if (!session) return 'user'
  return session.controller?.owner ?? (session.source === 'agent' ? 'joe' : 'user')
}
