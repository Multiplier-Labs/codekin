/**
 * Client for Agent Joe inside repo sessions: execution handover and the
 * tasks linked to a session (server/joe-session-routes.ts).
 */

import { transport } from './transport'
import type { SessionController } from '../types'
import type { TaskList } from './tasksApi'

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await transport.fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* keep the status message */ }
    throw new Error(message)
  }
  return (await res.json()) as T
}

/** Hand the session's execution to Joe. */
export async function handOverToJoe(token: string, sessionId: string, taskId?: string): Promise<SessionController> {
  return (await call<{ controller: SessionController }>(token, `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/handover`, { method: 'POST', body: taskId ? { taskId } : {} })).controller
}

/** Take execution back from Joe; later Joe instructions are refused. */
export async function takeBackControl(token: string, sessionId: string): Promise<SessionController> {
  return (await call<{ controller: SessionController }>(token, `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/take-back`, { method: 'POST' })).controller
}

/** Tasks started from, or executing in, a session. */
export function listSessionTasks(token: string, sessionId: string): Promise<TaskList> {
  return call<TaskList>(token, `/api/orchestrator/tasks?session=${encodeURIComponent(sessionId)}`)
}

/** The controller a session has when none was ever set (mirrors the server). */
export function effectiveOwner(session: { controller?: SessionController; source?: string } | undefined): 'user' | 'joe' {
  if (!session) return 'user'
  return session.controller?.owner ?? (session.source === 'agent' ? 'joe' : 'user')
}
