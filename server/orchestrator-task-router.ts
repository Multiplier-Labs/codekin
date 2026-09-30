/**
 * REST routes for Agent Joe's per-repo task list (docs/JOE-TASKS-SPEC.md).
 *
 * Both the user and Joe call these. Human-consent actions — answering a
 * decision, accepting or sending back a result — are refused for Joe's own
 * session token, so Joe can never answer its own questions.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { resolveRepoPathInRoot } from './config.js'
import { OrchestratorTaskService, TaskActionError } from './orchestrator-tasks.js'
import {
  TASK_COMPLETION_POLICIES,
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  type CreateTaskInput,
  type TaskActor,
  type TaskCompletionPolicy,
  type TaskPriority,
  type TaskSource,
  type TaskStatus,
} from './task-store.js'

const MAX_TASKS_PER_REQUEST = 20
const MAX_TITLE = 300
const MAX_TEXT = 10_000

function sendError(res: Response, err: unknown): void {
  if (err instanceof TaskActionError) res.status(err.status).json({ error: err.message })
  else res.status(500).json({ error: err instanceof Error ? err.message : 'Task action failed' })
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length <= max ? value : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null
}

export function createTaskRouter(
  verifyOrchestratorAuth: (req: Request) => boolean,
  actorOf: (req: Request) => Exclude<TaskActor, 'system'>,
  tasks: OrchestratorTaskService,
): Router {
  const router = Router()

  function authorize(req: Request, res: Response): boolean {
    if (verifyOrchestratorAuth(req)) return true
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }

  function requireUser(req: Request, res: Response): boolean {
    if (actorOf(req) === 'user') return true
    res.status(403).json({ error: 'Only the user can do this — ask them with request_decision' })
    return false
  }

  /** List tasks (optionally for one repo / status) with per-status counts. */
  router.get('/api/orchestrator/tasks', (req, res) => {
    if (!authorize(req, res)) return
    const status = oneOf<TaskStatus>(req.query.status, TASK_STATUSES)
    if (status === null) return res.status(400).json({ error: `Invalid status: one of ${TASK_STATUSES.join(', ')}` })
    let repo: string | undefined
    if (typeof req.query.repo === 'string' && req.query.repo) {
      repo = resolveRepoPathInRoot(req.query.repo) ?? undefined
      if (!repo) return res.status(400).json({ error: 'Invalid repo path: must be an existing directory under the configured repos root' })
    }
    const originSessionId = typeof req.query.session === 'string' && req.query.session ? req.query.session : undefined
    res.json(tasks.list({ repo, status, originSessionId }))
  })

  /** One task with its history. */
  router.get('/api/orchestrator/tasks/:id', (req: Request<{ id: string }>, res) => {
    if (!authorize(req, res)) return
    const task = tasks.get(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })
    res.json({ task: tasks.view(task), events: tasks.events(task.id) })
  })

  /** Create tasks in one repo; `delegate: true` hands them to Joe to start. */
  router.post('/api/orchestrator/tasks', (req: Request<Record<string, string>, unknown, Record<string, unknown>>, res) => {
    if (!authorize(req, res)) return
    const body = (req.body as Record<string, unknown> | undefined) ?? {}
    const repo = typeof body.repo === 'string' ? resolveRepoPathInRoot(body.repo) : null
    if (!repo) return res.status(400).json({ error: 'Invalid repo path: must be an existing directory under the configured repos root' })
    if (!Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > MAX_TASKS_PER_REQUEST) {
      return res.status(400).json({ error: `Provide tasks: 1–${MAX_TASKS_PER_REQUEST} entries` })
    }
    const completionPolicy = oneOf<TaskCompletionPolicy>(body.completionPolicy, TASK_COMPLETION_POLICIES)
    const source = oneOf<TaskSource>(body.source, TASK_SOURCES)
    const sourceRef = optionalText(body.sourceRef, 1000)
    if (completionPolicy === null) return res.status(400).json({ error: 'Invalid completionPolicy: pr, merge, or commit-only' })
    if (source === null) return res.status(400).json({ error: `Invalid source: one of ${TASK_SOURCES.join(', ')}` })
    if (sourceRef === null) return res.status(400).json({ error: 'Invalid sourceRef' })
    const originSessionId = optionalText(body.originSessionId, 200)
    const originRequestId = optionalText(body.originRequestId, 200)
    if (originSessionId === null || originRequestId === null) return res.status(400).json({ error: 'Invalid originSessionId / originRequestId' })

    const actor = actorOf(req)
    const inputs: CreateTaskInput[] = []
    for (const raw of body.tasks as unknown[]) {
      const entry = (raw ?? {}) as Record<string, unknown>
      const title = typeof entry.title === 'string' ? entry.title.trim() : ''
      const detail = optionalText(entry.detail, MAX_TEXT)
      const acceptance = optionalText(entry.acceptance ?? body.acceptance, MAX_TEXT)
      const priority = oneOf<TaskPriority>(entry.priority, TASK_PRIORITIES)
      if (!title || title.length > MAX_TITLE) return res.status(400).json({ error: `Each task needs a title (max ${MAX_TITLE} characters)` })
      if (detail === null || acceptance === null) return res.status(400).json({ error: `Task text is limited to ${MAX_TEXT} characters` })
      if (priority === null) return res.status(400).json({ error: 'Invalid priority: high, normal, or low' })
      inputs.push({
        repo,
        title,
        detail,
        acceptance,
        priority,
        completionPolicy,
        source: source ?? (actor === 'user' ? 'user' : 'joe'),
        sourceRef,
        originSessionId,
        originRequestId,
        createdBy: actor,
      })
    }
    res.json({ tasks: tasks.create(inputs, { delegate: body.delegate === true }) })
  })

  /** Edit a task; status may move to todo (reopen), done, or dismissed. */
  router.patch('/api/orchestrator/tasks/:id', (req: Request<{ id: string }, unknown, Record<string, unknown>>, res) => {
    if (!authorize(req, res)) return
    const body = (req.body as Record<string, unknown> | undefined) ?? {}
    const title = optionalText(body.title, MAX_TITLE)
    const detail = optionalText(body.detail, MAX_TEXT)
    const acceptance = optionalText(body.acceptance, MAX_TEXT)
    const note = optionalText(body.note, MAX_TEXT)
    const priority = oneOf<TaskPriority>(body.priority, TASK_PRIORITIES)
    const completionPolicy = oneOf<TaskCompletionPolicy>(body.completionPolicy, TASK_COMPLETION_POLICIES)
    const status = oneOf(body.status, ['todo', 'done', 'dismissed'] as const)
    if (title === null || title?.trim() === '' || detail === null || acceptance === null || note === null
      || priority === null || completionPolicy === null || status === null) {
      return res.status(400).json({ error: 'Invalid task fields' })
    }
    try {
      res.json({ task: tasks.update(req.params.id, { title: title?.trim(), detail, acceptance, priority, completionPolicy, status }, actorOf(req), note) })
    } catch (err) { sendError(res, err) }
  })

  /** Open a decision the user must answer (Joe's request_decision). */
  router.post('/api/orchestrator/tasks/:id/decision', (req: Request<{ id: string }, unknown, Record<string, unknown>>, res) => {
    if (!authorize(req, res)) return
    const { question, recommendation, options } = (req.body as Record<string, unknown> | undefined) ?? {}
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Missing required field: question' })
    }
    if (recommendation !== undefined && typeof recommendation !== 'string') {
      return res.status(400).json({ error: 'Invalid recommendation' })
    }
    if (options !== undefined && (!Array.isArray(options) || options.length > 6 || !options.every(o => typeof o === 'string' && o.trim() && o.length <= 200))) {
      return res.status(400).json({ error: 'Invalid options: up to 6 short strings' })
    }
    try {
      res.json({ task: tasks.requestDecision(req.params.id, { question: question.trim(), recommendation, options: options as string[] | undefined }) })
    } catch (err) { sendError(res, err) }
  })

  /** The user answers the open decision. */
  router.post('/api/orchestrator/tasks/:id/answer', (req: Request<{ id: string }, unknown, { answer?: unknown }>, res) => {
    if (!authorize(req, res) || !requireUser(req, res)) return
    const answer = (req.body as { answer?: unknown } | undefined)?.answer
    if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Missing required field: answer' })
    }
    try {
      res.json({ task: tasks.answer(req.params.id, answer.trim()) })
    } catch (err) { sendError(res, err) }
  })

  /** The user asks Joe to start a to-do task. */
  router.post('/api/orchestrator/tasks/:id/start', (req: Request<{ id: string }>, res) => {
    if (!authorize(req, res) || !requireUser(req, res)) return
    try {
      res.json({ task: tasks.requestStart(req.params.id) })
    } catch (err) { sendError(res, err) }
  })

  /** The user accepts a result that is ready for review. */
  router.post('/api/orchestrator/tasks/:id/accept', (req: Request<{ id: string }>, res) => {
    if (!authorize(req, res) || !requireUser(req, res)) return
    try {
      res.json({ task: tasks.accept(req.params.id) })
    } catch (err) { sendError(res, err) }
  })

  /** The user sends a result back with a note. */
  router.post('/api/orchestrator/tasks/:id/request-changes', (req: Request<{ id: string }, unknown, { note?: unknown }>, res) => {
    if (!authorize(req, res) || !requireUser(req, res)) return
    const note = (req.body as { note?: unknown } | undefined)?.note
    if (typeof note !== 'string' || !note.trim() || note.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Missing required field: note' })
    }
    try {
      res.json({ task: tasks.requestChanges(req.params.id, note.trim()) })
    } catch (err) { sendError(res, err) }
  })

  return router
}
