/** Tests for OrchestratorTaskService — task rules, child sync, and Joe notifications. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TaskStore } from './task-store.js'
import { OrchestratorTaskService } from './orchestrator-tasks.js'
import type { ChildSession, ChildStatus } from './orchestrator-children.js'

function child(status: ChildStatus, overrides: Partial<ChildSession> = {}, taskId = 'task'): ChildSession {
  return {
    id: 'child-1',
    request: { repo: '/repos/a', task: 't', branchName: 'fix/t', completionPolicy: 'pr', useWorktree: true, taskId },
    status,
    startedAt: 'then',
    completedAt: null,
    result: null,
    error: null,
    terminalNotifiedAt: null,
    worktree: 'active',
    worktreePath: '/repos/a-wt',
    verification: null,
    attempt: 1,
    ...overrides,
  }
}

describe('OrchestratorTaskService', () => {
  let store: TaskStore
  let notify: ReturnType<typeof vi.fn>
  let service: OrchestratorTaskService

  beforeEach(() => {
    store = new TaskStore(':memory:')
    notify = vi.fn(() => true)
    service = new OrchestratorTaskService({ store, notify })
  })
  afterEach(() => { store.close() })

  const newTask = (title = 'Fix login') => service.create([{ repo: '/repos/a', title, createdBy: 'user' }])[0]

  describe('create', () => {
    it('does not notify Joe unless delegated', () => {
      newTask()
      expect(notify).not.toHaveBeenCalled()
    })

    it('hands delegated tasks to Joe in one notification', () => {
      const tasks = service.create([
        { repo: '/repos/a', title: 'One', acceptance: 'tests pass', createdBy: 'user' },
        { repo: '/repos/a', title: 'Two', createdBy: 'user' },
      ], { delegate: true })
      expect(notify).toHaveBeenCalledTimes(1)
      const args = notify.mock.calls[0][0]
      expect(args.label).toBe('Tasks Delegated')
      expect(args.body).toContain(`${tasks[0].id}: One (done when: tests pass)`)
      expect(args.body).toContain(`${tasks[1].id}: Two`)
      expect(args.body).toContain('spawn_child (pass taskId')
    })
  })

  describe('execution substate', () => {
    it('is queued, not running, until an attempt is actually active', () => {
      const active = new Set<string>()
      service = new OrchestratorTaskService({ store, notify, isChildActive: (id) => active.has(id) })
      const task = newTask()
      expect(service.view(task).execution).toBe('idle')

      service.requestStart(task.id)
      expect(service.list().tasks[0]).toMatchObject({ status: 'todo', execution: 'queued' })

      active.add('child-1')
      service.syncFromChild(child('running', {}, task.id))
      expect(service.list().tasks[0]).toMatchObject({ status: 'in_progress', execution: 'running', queuedAt: null })

      // The attempt stops unverified; answering Retry queues work for Joe again.
      active.delete('child-1')
      service.syncFromChild(child('unverified', { error: 'no PR' }, task.id))
      service.answer(task.id, 'Retry')
      expect(service.list().tasks[0]).toMatchObject({ status: 'in_progress', execution: 'queued' })
    })

    it('reports milestones only for tasks with an originating session', () => {
      const onMilestone = vi.fn()
      service = new OrchestratorTaskService({ store, notify, onMilestone })
      newTask('No origin')
      const [linked] = service.create([{ repo: '/repos/a', title: 'From a session', createdBy: 'joe', originSessionId: 's1' }])
      service.syncFromChild(child('completed', { verification: { state: 'verified', commit: 'abc', prUrl: 'https://pr', detail: 'PR open', checkedAt: 'now' } }, linked.id))
      expect(onMilestone.mock.calls.map(([t, m]: [{ title: string }, string]) => `${t.title}:${m}`)).toEqual(['From a session:accepted', 'From a session:review'])
    })

    it('lists tasks started from, or executing in, a session', () => {
      const [fromSession] = service.create([{ repo: '/repos/a', title: 'From s1', createdBy: 'joe', originSessionId: 's1' }])
      const executing = newTask('Runs in child-1')
      service.syncFromChild(child('running', {}, executing.id))
      newTask('Unrelated')
      expect(service.list({ originSessionId: 's1' }).tasks.map(t => t.id)).toEqual([fromSession.id])
      expect(service.list({ originSessionId: 'child-1' }).tasks.map(t => t.id)).toEqual([executing.id])
    })
  })

  describe('syncFromChild', () => {
    it('links the attempt and moves the task to in_progress', () => {
      const task = newTask()
      service.syncFromChild(child('running', {}, task.id))
      expect(service.get(task.id)).toMatchObject({ status: 'in_progress', childId: 'child-1', childIds: ['child-1'] })
      expect(service.events(task.id).at(-1)?.summary).toContain('Attempt 1 started')
    })

    it('is idempotent for repeated updates', () => {
      const task = newTask()
      service.syncFromChild(child('running', {}, task.id))
      service.syncFromChild(child('blocked', {}, task.id))
      service.syncFromChild(child('running', {}, task.id))
      expect(service.events(task.id)).toHaveLength(2)  // created + attempt started
    })

    it('records verified evidence and moves to in_review', () => {
      const task = newTask()
      const verification = { state: 'verified' as const, commit: 'abc123', prUrl: 'https://gh/pull/7', detail: 'pull request is open at the branch HEAD', checkedAt: 'now' }
      service.syncFromChild(child('completed', { verification }, task.id))
      expect(service.get(task.id)).toMatchObject({ status: 'in_review', prUrl: 'https://gh/pull/7', commit: 'abc123', verification, decision: null })
    })

    it.each(['unverified', 'failed', 'timed_out'] as const)('opens a retry-or-dismiss decision when the attempt ends %s', (status) => {
      const task = newTask()
      service.syncFromChild(child(status, { error: 'Completion not verified: no pull request exists' }, task.id))
      const updated = service.get(task.id)!
      expect(updated.status).toBe('needs_decision')
      expect(updated.decision).toMatchObject({ askedBy: 'system', options: ['Retry', 'Dismiss'], answer: null })
      expect(updated.decision?.question).toContain('no pull request exists')
    })

    it('returns a canceled attempt to todo', () => {
      const task = newTask()
      service.syncFromChild(child('running', {}, task.id))
      service.syncFromChild(child('canceled', { error: 'Session was stopped by the user' }, task.id))
      expect(service.get(task.id)?.status).toBe('todo')
    })

    it('keeps an open Joe decision while the child keeps running', () => {
      const task = newTask()
      service.syncFromChild(child('running', {}, task.id))
      service.requestDecision(task.id, { question: 'A or B?' })
      service.syncFromChild(child('blocked', {}, task.id))
      expect(service.get(task.id)?.status).toBe('needs_decision')
    })

    it('clears a system decision when a new attempt starts', () => {
      const task = newTask()
      service.syncFromChild(child('failed', { error: 'boom' }, task.id))
      service.answer(task.id, 'Retry')
      service.syncFromChild(child('running', { id: 'child-2' }, task.id))
      expect(service.get(task.id)).toMatchObject({ status: 'in_progress', decision: null, childId: 'child-2', childIds: ['child-1', 'child-2'] })
    })

    it('never reopens a closed task and ignores children without a task', () => {
      const task = newTask()
      service.update(task.id, { status: 'dismissed' }, 'user')
      service.syncFromChild(child('running', {}, task.id))
      expect(service.get(task.id)?.status).toBe('dismissed')
      expect(() => service.syncFromChild(child('running', {}, ''))).not.toThrow()
    })
  })

  describe('decisions', () => {
    it('Joe asks, the user answers, Joe is told the answer', () => {
      const task = newTask()
      service.requestDecision(task.id, { question: 'Change the public API?', recommendation: 'No — add an overload', options: ['Change it', 'Add overload'] })
      expect(service.get(task.id)).toMatchObject({ status: 'needs_decision', decision: { askedBy: 'joe', recommendation: 'No — add an overload' } })

      const answered = service.answer(task.id, 'Add overload')
      expect(answered).toMatchObject({ status: 'in_progress', decision: { answer: 'Add overload' } })
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ label: 'Decision Answered' }))
      expect(notify.mock.calls[0][0].body).toContain('Answer: Add overload')
    })

    it('dismisses directly when the user dismisses a failed attempt', () => {
      const task = newTask()
      service.syncFromChild(child('failed', { error: 'boom' }, task.id))
      const updated = service.answer(task.id, 'Dismiss')
      expect(updated.status).toBe('dismissed')
      expect(updated.closedAt).toBeTruthy()
      expect(notify.mock.calls[0][0].body).toContain('do not continue')
    })

    it('tells Joe to resume the child on Retry', () => {
      const task = newTask()
      service.syncFromChild(child('timed_out', { error: 'out of time' }, task.id))
      service.answer(task.id, 'Retry')
      expect(notify.mock.calls[0][0].body).toContain('resume_child (id child-1)')
    })

    it('refuses answers without an open decision and decisions on closed tasks', () => {
      const task = newTask()
      expect(() => service.answer(task.id, 'x')).toThrow(/No open decision/)
      service.update(task.id, { status: 'done' }, 'user')
      expect(() => service.requestDecision(task.id, { question: 'q' })).toThrow(/done/)
      expect(() => service.answer('missing', 'x')).toThrow(/not found/)
    })
  })

  describe('review', () => {
    function reviewed() {
      const task = newTask()
      service.syncFromChild(child('completed', { verification: { state: 'verified', commit: 'abc', prUrl: 'https://gh/pull/1', detail: 'ok', checkedAt: 'now' } }, task.id))
      return task
    }

    it('accepts a reviewed task', () => {
      const task = reviewed()
      expect(service.accept(task.id)).toMatchObject({ status: 'done' })
    })

    it('sends it back with a note and asks Joe to resume the child', () => {
      const task = reviewed()
      expect(service.requestChanges(task.id, 'Rename the flag')).toMatchObject({ status: 'in_progress', reviewNote: 'Rename the flag' })
      const body = notify.mock.calls[0][0].body
      expect(body).toContain('Rename the flag')
      expect(body).toContain('resume_child (id child-1)')
      expect(body).toContain('PR: https://gh/pull/1')
    })

    it('refuses review actions outside in_review', () => {
      const task = newTask()
      expect(() => service.accept(task.id)).toThrow(/ready for review/)
      expect(() => service.requestChanges(task.id, 'x')).toThrow(/ready for review/)
    })
  })

  describe('requestStart', () => {
    it('asks Joe to start a to-do task, or resume a stopped attempt', () => {
      const task = newTask()
      service.requestStart(task.id)
      expect(notify.mock.calls[0][0]).toMatchObject({ label: 'Task Start Requested' })
      expect(notify.mock.calls[0][0].body).toContain('spawn_child (pass taskId')

      service.syncFromChild(child('running', {}, task.id))
      expect(() => service.requestStart(task.id)).toThrow(/Only to-do tasks/)
      service.syncFromChild(child('canceled', {}, task.id))
      service.requestStart(task.id)
      expect(notify.mock.calls[1][0].body).toContain('resume_child (id child-1)')
      expect(service.events(task.id).filter(e => e.summary === 'Start requested')).toHaveLength(2)
    })
  })

  describe('update', () => {
    it('edits fields, dismisses, and reopens with history', () => {
      const task = newTask()
      service.update(task.id, { title: 'Fix SSO login', priority: 'high' }, 'joe')
      service.update(task.id, { status: 'dismissed' }, 'user', 'duplicate of #12')
      const reopened = service.update(task.id, { status: 'todo' }, 'user')
      expect(reopened).toMatchObject({ title: 'Fix SSO login', priority: 'high', status: 'todo', closedAt: null })
      expect(service.events(task.id).map(e => e.summary).slice(1)).toEqual([
        'Edited title, priority',
        'Marked dismissed — duplicate of #12',
        'Reopened',
      ])
    })
  })

  describe('assertStartable', () => {
    it('refuses closed tasks and repo mismatches', () => {
      const task = newTask()
      expect(service.assertStartable(task.id, '/repos/a').id).toBe(task.id)
      expect(() => service.assertStartable(task.id, '/repos/b')).toThrow(/belongs to \/repos\/a/)
      service.update(task.id, { status: 'done' }, 'user')
      expect(() => service.assertStartable(task.id, '/repos/a')).toThrow(/reopen/)
    })
  })
})
