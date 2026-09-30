/** Tests for TaskStore — persistence of Joe's per-repo task list. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TaskStore } from './task-store.js'

describe('TaskStore', () => {
  let store: TaskStore

  beforeEach(() => { store = new TaskStore(':memory:') })
  afterEach(() => { store.close() })

  it('creates a todo task with defaults and a history entry', () => {
    const task = store.create({ repo: '/repos/a', title: 'Fix login', createdBy: 'user' })
    expect(task).toMatchObject({
      repo: '/repos/a', title: 'Fix login', detail: '', acceptance: '', priority: 'normal',
      source: 'user', status: 'todo', completionPolicy: 'pr', childId: null, childIds: [],
      decision: null, verification: null, createdBy: 'user', closedAt: null,
    })
    expect(store.events(task.id).map(e => e.summary)).toEqual(['Created: Fix login'])
  })

  it('lists by repo and status, newest update first, and counts per status', () => {
    const a = store.create({ repo: '/repos/a', title: 'one', createdBy: 'user' })
    store.create({ repo: '/repos/a', title: 'two', createdBy: 'joe' })
    store.create({ repo: '/repos/b', title: 'three', createdBy: 'user' })
    store.patch(a.id, { status: 'in_review' }, 'system')

    expect(store.list({ repo: '/repos/a' }).map(t => t.title)).toEqual(['one', 'two'])
    expect(store.list({ status: 'in_review' }).map(t => t.title)).toEqual(['one'])
    expect(store.counts('/repos/a')).toMatchObject({ todo: 1, in_review: 1, done: 0 })
    expect(store.counts()).toMatchObject({ todo: 2, in_review: 1 })
  })

  it('patches JSON fields and records the summary', () => {
    const task = store.create({ repo: '/repos/a', title: 't', createdBy: 'user' })
    const verification = { state: 'verified' as const, commit: 'abc', prUrl: 'https://x/pull/1', detail: 'ok', checkedAt: 'now' }
    const updated = store.patch(task.id, { childId: 'c1', childIds: ['c1'], verification, prUrl: 'https://x/pull/1' }, 'system', 'Ready')
    expect(updated).toMatchObject({ childId: 'c1', childIds: ['c1'], verification, prUrl: 'https://x/pull/1' })
    expect(store.patch(task.id, { verification: null }, 'system')?.verification).toBeNull()
    expect(store.events(task.id).map(e => [e.actor, e.summary])).toEqual([['user', 'Created: t'], ['system', 'Ready']])
    expect(store.patch('nope', { title: 'x' }, 'user')).toBeNull()
  })

  it('finds a task by current or past child', () => {
    const task = store.create({ repo: '/repos/a', title: 't', createdBy: 'user' })
    store.patch(task.id, { childId: 'c2', childIds: ['c1', 'c2'] }, 'system')
    expect(store.getByChild('c2')?.id).toBe(task.id)
    expect(store.getByChild('c1')?.id).toBe(task.id)
    expect(store.getByChild('c3')).toBeNull()
  })

  it('emits an event on every mutation', () => {
    const listener = vi.fn()
    store.setEventListener(listener)
    const task = store.create({ repo: '/repos/a', title: 't', createdBy: 'user' })
    store.patch(task.id, { status: 'done' }, 'user')
    expect(listener.mock.calls.map(c => c[0])).toEqual([
      { taskId: task.id, repo: '/repos/a', status: 'todo' },
      { taskId: task.id, repo: '/repos/a', status: 'done' },
    ])
  })
})
