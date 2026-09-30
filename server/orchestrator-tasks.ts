/**
 * Agent Joe's per-repo task list — business rules over TaskStore
 * (docs/JOE-TASKS-SPEC.md).
 *
 * - Task status follows the linked child: running → in_progress, verified →
 *   in_review, unverified/failed/timed_out → needs_decision, canceled → todo.
 * - Human actions (delegate, answer, request changes) reach Joe as durable
 *   notifications; the server never spawns work behind Joe's back, so repo
 *   policies and trust still apply.
 */

import type { ChildSession } from './orchestrator-children.js'
import type { OrchestratorNotifyArgs } from './orchestrator-notify.js'
import {
  CLOSED_TASK_STATUSES,
  type CreateTaskInput,
  type Task,
  type TaskActor,
  type TaskDecision,
  type TaskPatch,
  type TaskStatus,
  type TaskStore,
} from './task-store.js'

/** A task action that does not fit the task's current state. */
export class TaskActionError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'TaskActionError'
  }
}

export interface TaskServiceDeps {
  store: TaskStore
  /** Deliver a notification to Joe (outbox-backed; returns false only if queueing failed). */
  notify: (args: Omit<OrchestratorNotifyArgs, 'parentSessionId'>) => boolean
}

const RETRY = 'Retry'
const DISMISS = 'Dismiss'

export class OrchestratorTaskService {
  private store: TaskStore
  private notify: TaskServiceDeps['notify']

  constructor(deps: TaskServiceDeps) {
    this.store = deps.store
    this.notify = deps.notify
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(opts: { repo?: string; status?: TaskStatus } = {}): { tasks: Task[]; counts: Record<TaskStatus, number> } {
    return { tasks: this.store.list(opts), counts: this.store.counts(opts.repo) }
  }

  get(id: string): Task | null {
    return this.store.get(id)
  }

  require(id: string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskActionError('Task not found', 404)
    return task
  }

  events(id: string) {
    return this.store.events(id)
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Create tasks in one repo. `delegate` hands them to Joe to start now —
   * used by the user's "Delegate tasks" flow.
   */
  create(inputs: CreateTaskInput[], opts: { delegate?: boolean } = {}): Task[] {
    const tasks = inputs.map(input => this.store.create(input))
    if (opts.delegate && tasks.length > 0) {
      const repo = tasks[0].repo
      this.notify({
        label: 'Tasks Delegated',
        title: `The user delegated ${tasks.length} task${tasks.length === 1 ? '' : 's'} in ${repo}`,
        body: [
          ...tasks.map(t => `- ${t.id}: ${t.title}${t.acceptance ? ` (done when: ${t.acceptance.split('\n')[0]})` : ''}`),
          '',
          `Start each one with spawn_child (pass taskId, completionPolicy "${tasks[0].completionPolicy}"), following the repo's policy in REPOS.md.`,
          'If a task is unclear or conflicts with the repo policy, ask with request_decision instead of guessing.',
        ].join('\n'),
      })
    }
    return tasks
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  /** Edit fields; status can be moved to todo / done / dismissed only. */
  update(id: string, patch: Pick<TaskPatch, 'title' | 'detail' | 'acceptance' | 'priority' | 'completionPolicy'> & { status?: 'todo' | 'done' | 'dismissed' }, actor: TaskActor, note?: string): Task {
    const task = this.require(id)
    const changes: TaskPatch = { ...patch }
    const summary: string[] = []
    if (patch.status && patch.status !== task.status) {
      changes.closedAt = CLOSED_TASK_STATUSES.has(patch.status) ? new Date().toISOString() : null
      if (patch.status !== 'todo' || CLOSED_TASK_STATUSES.has(task.status)) changes.decision = null
      summary.push(patch.status === 'todo' && CLOSED_TASK_STATUSES.has(task.status) ? 'Reopened' : `Marked ${patch.status}`)
    }
    const edited = (['title', 'detail', 'acceptance', 'priority', 'completionPolicy'] as const).filter(k => patch[k] !== undefined && patch[k] !== task[k])
    if (edited.length) summary.push(`Edited ${edited.join(', ')}`)
    if (note) summary.push(note)
    return this.patch(id, changes, actor, summary.join(' — ') || undefined)
  }

  // -------------------------------------------------------------------------
  // Decisions and review
  // -------------------------------------------------------------------------

  /** Joe needs the user: hold the task in needs_decision until answered. */
  requestDecision(id: string, input: { question: string; recommendation?: string; options?: string[] }): Task {
    const task = this.require(id)
    if (CLOSED_TASK_STATUSES.has(task.status)) throw new TaskActionError(`Task is ${task.status}`, 409)
    const decision: TaskDecision = {
      question: input.question,
      recommendation: input.recommendation ?? null,
      options: input.options ?? [],
      askedBy: 'joe',
      askedAt: new Date().toISOString(),
      answer: null,
      answeredAt: null,
    }
    return this.patch(id, { status: 'needs_decision', decision }, 'joe', `Asked: ${input.question}`)
  }

  /** The user answers the open decision; Joe is told what to do next. */
  answer(id: string, answer: string): Task {
    const task = this.require(id)
    if (task.status !== 'needs_decision' || !task.decision || task.decision.answer !== null) {
      throw new TaskActionError('No open decision on this task', 409)
    }
    const decision: TaskDecision = { ...task.decision, answer, answeredAt: new Date().toISOString() }

    // System decisions (child ended without verified work) offer Dismiss directly.
    if (decision.askedBy === 'system' && answer === DISMISS) {
      const updated = this.patch(id, { status: 'dismissed', decision, closedAt: new Date().toISOString() }, 'user', 'Dismissed')
      this.notifyAnswer(updated, answer)
      return updated
    }

    const updated = this.patch(id, { status: 'in_progress', decision }, 'user', `Answered: ${answer}`)
    this.notifyAnswer(updated, answer)
    return updated
  }

  /** The user accepts a reviewed result. */
  accept(id: string): Task {
    const task = this.require(id)
    if (task.status !== 'in_review') throw new TaskActionError(`Only tasks ready for review can be accepted (task is ${task.status})`, 409)
    return this.patch(id, { status: 'done', closedAt: new Date().toISOString() }, 'user', 'Accepted')
  }

  /** The user sends a reviewed result back with a note; Joe resumes the child. */
  requestChanges(id: string, note: string): Task {
    const task = this.require(id)
    if (task.status !== 'in_review') throw new TaskActionError(`Only tasks ready for review can be sent back (task is ${task.status})`, 409)
    const updated = this.patch(id, { status: 'in_progress', reviewNote: note }, 'user', `Changes requested: ${note}`)
    this.notify({
      label: 'Changes Requested',
      title: `Task ${task.id}: ${task.title}`,
      body: [
        `Repo: ${task.repo}`,
        task.prUrl ? `PR: ${task.prUrl}` : null,
        `The user reviewed the result and asked for changes:`,
        note,
        '',
        task.childId
          ? `Resume the child with resume_child (id ${task.childId}) and pass these changes as instructions.`
          : 'Spawn a child with spawn_child (pass taskId) to make these changes.',
      ].filter((l): l is string => l !== null).join('\n'),
    })
    return updated
  }

  /** Patch a task known to exist (callers load it first). */
  private patch(id: string, patch: TaskPatch, actor: TaskActor, summary?: string): Task {
    const task = this.store.patch(id, patch, actor, summary)
    if (!task) throw new TaskActionError('Task not found', 404)
    return task
  }

  private notifyAnswer(task: Task, answer: string): void {
    const decision = task.decision
    this.notify({
      label: 'Decision Answered',
      title: `Task ${task.id}: ${task.title}`,
      body: [
        `Repo: ${task.repo}`,
        decision ? `Question: ${decision.question}` : null,
        `Answer: ${answer}`,
        '',
        task.status === 'dismissed'
          ? 'The user dismissed the task — do not continue it.'
          : decision?.askedBy === 'system' && answer === RETRY && task.childId
            ? `Retry: resume the child with resume_child (id ${task.childId}); look at why it stopped first (get_child).`
            : 'Continue the task accordingly (send_to_child, resume_child, or spawn_child with taskId).',
      ].filter((l): l is string => l !== null).join('\n'),
    })
  }

  // -------------------------------------------------------------------------
  // Child linkage
  // -------------------------------------------------------------------------

  /** Validate that a new child may be attached to the task (before spawning). */
  assertStartable(id: string, repo: string): Task {
    const task = this.require(id)
    if (CLOSED_TASK_STATUSES.has(task.status)) throw new TaskActionError(`Task is ${task.status} — reopen it first`, 409)
    if (task.repo !== repo) throw new TaskActionError(`Task belongs to ${task.repo}, not ${repo}`, 409)
    return task
  }

  /**
   * Sync a task with its child's lifecycle. Called for every persisted child
   * state change; idempotent (only writes when something changed).
   */
  syncFromChild(child: ChildSession): void {
    const taskId = child.request.taskId
    if (!taskId) return
    const task = this.store.get(taskId)
    if (!task || CLOSED_TASK_STATUSES.has(task.status)) return

    const patch: TaskPatch = {}
    let summary: string | undefined

    if (task.childId !== child.id) {
      patch.childId = child.id
      patch.childIds = task.childIds.includes(child.id) ? task.childIds : [...task.childIds, child.id]
      summary = `Attempt ${patch.childIds.length} started (session ${child.id})`
    }

    const openJoeDecision = task.decision?.askedBy === 'joe' && task.decision.answer === null
    switch (child.status) {
      case 'starting':
      case 'running':
      case 'blocked':
        if (openJoeDecision) break
        if (task.status !== 'in_progress') patch.status = 'in_progress'
        // A new attempt supersedes the previous one's evidence and system decision.
        if (task.decision?.askedBy === 'system') patch.decision = null
        break
      case 'completed':
        patch.status = 'in_review'
        patch.prUrl = child.verification?.prUrl ?? null
        patch.commit = child.verification?.commit ?? null
        patch.verification = child.verification
        patch.decision = null
        summary = `Ready for review${child.verification ? `: ${child.verification.detail}` : ''}`
        break
      case 'unverified':
      case 'failed':
      case 'timed_out': {
        const reason = child.error ?? `Child ended ${child.status}`
        patch.status = 'needs_decision'
        patch.verification = child.verification
        patch.decision = {
          question: `The attempt ended ${child.status.replace('_', ' ')}: ${reason}. Retry, or dismiss the task?`,
          recommendation: child.status === 'unverified' ? 'Check the branch/PR first — the work may be done but not delivered.' : null,
          options: [RETRY, DISMISS],
          askedBy: 'system',
          askedAt: new Date().toISOString(),
          answer: null,
          answeredAt: null,
        }
        summary = `Needs a decision: attempt ended ${child.status} — ${reason}`
        break
      }
      case 'canceled':
        patch.status = 'todo'
        summary = `Attempt canceled (${child.error ?? 'stopped'}); partial work kept in its worktree`
        break
    }

    if (patch.status === task.status) delete patch.status
    const changed = Object.keys(patch).length > 0
    if (changed) this.store.patch(task.id, patch, 'system', summary)
  }
}
