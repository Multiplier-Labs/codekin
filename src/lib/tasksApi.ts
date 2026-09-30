/**
 * Client for Agent Joe's per-repo task list (/api/orchestrator/tasks).
 *
 * Mirrors server/task-store.ts — see docs/JOE-TASKS-SPEC.md.
 */

import { transport } from './transport'

export type TaskStatus = 'todo' | 'in_progress' | 'needs_decision' | 'in_review' | 'done' | 'dismissed'
export type TaskPriority = 'high' | 'normal' | 'low'
export type TaskCompletionPolicy = 'pr' | 'merge' | 'commit-only'

export interface TaskVerification {
  state: 'verified' | 'missing' | 'unknown' | 'not_applicable'
  commit: string | null
  prUrl: string | null
  detail: string
  checkedAt: string
}

export interface TaskDecision {
  question: string
  recommendation: string | null
  options: string[]
  askedBy: 'joe' | 'system'
  askedAt: string
  answer: string | null
  answeredAt: string | null
}

export interface JoeTask {
  id: string
  repo: string
  title: string
  detail: string
  acceptance: string
  priority: TaskPriority
  source: 'user' | 'joe' | 'report' | 'incident' | 'maintenance'
  sourceRef: string | null
  status: TaskStatus
  completionPolicy: TaskCompletionPolicy
  childId: string | null
  childIds: string[]
  prUrl: string | null
  commit: string | null
  verification: TaskVerification | null
  decision: TaskDecision | null
  reviewNote: string | null
  /** Repo session the request came from. */
  originSessionId?: string | null
  /** Maintenance responsibility governing the task, if any. */
  responsibilityId?: string | null
  /** Whether an attempt is running now, queued for Joe, or neither. */
  execution?: 'running' | 'queued' | 'idle'
  createdBy: 'user' | 'joe' | 'system'
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface TaskList {
  tasks: JoeTask[]
  counts: Record<TaskStatus, number>
}

export interface NewTask {
  title: string
  detail?: string
}

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await transport.fetch(`/api/orchestrator/tasks${path}`, {
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

export function listTasks(token: string, opts: { repo?: string } = {}): Promise<TaskList> {
  const qs = opts.repo ? `?repo=${encodeURIComponent(opts.repo)}` : ''
  return call<TaskList>(token, qs)
}

/** Create tasks in one repo and hand them to Joe to start. */
export async function delegateTasks(
  token: string,
  input: { repo: string; tasks: NewTask[]; acceptance?: string; completionPolicy: TaskCompletionPolicy },
): Promise<JoeTask[]> {
  const body = await call<{ tasks: JoeTask[] }>(token, '', { method: 'POST', body: { ...input, delegate: true } })
  return body.tasks
}

export async function answerDecision(token: string, id: string, answer: string): Promise<JoeTask> {
  return (await call<{ task: JoeTask }>(token, `/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { answer } })).task
}

export async function startTask(token: string, id: string): Promise<JoeTask> {
  return (await call<{ task: JoeTask }>(token, `/${encodeURIComponent(id)}/start`, { method: 'POST' })).task
}

export async function acceptTask(token: string, id: string): Promise<JoeTask> {
  return (await call<{ task: JoeTask }>(token, `/${encodeURIComponent(id)}/accept`, { method: 'POST' })).task
}

export async function requestChanges(token: string, id: string, note: string): Promise<JoeTask> {
  return (await call<{ task: JoeTask }>(token, `/${encodeURIComponent(id)}/request-changes`, { method: 'POST', body: { note } })).task
}

export async function setTaskStatus(token: string, id: string, status: 'todo' | 'done' | 'dismissed'): Promise<JoeTask> {
  return (await call<{ task: JoeTask }>(token, `/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } })).task
}

/** Split the delegate form's free text into tasks: one per non-empty line. */
export function parseTaskLines(text: string): NewTask[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map(title => ({ title: title.slice(0, 300) }))
}

/** Items waiting on the user — decisions to make plus results to review. */
export function attentionCount(counts: Record<TaskStatus, number> | null | undefined): number {
  return counts ? counts.needs_decision + counts.in_review : 0
}

/** Last path segment of a repo path, for display. */
export function repoName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
