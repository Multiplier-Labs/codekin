/**
 * Tests for the task routes — validation, the user-only consent actions, and
 * the MCP client contract (CodekinApi against the real router).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type { Request } from 'express'

vi.mock('./config.js', () => ({
  resolveRepoPathInRoot: (p: string) => (p.startsWith('/repos/') ? p.replace(/\/+$/, '') : null),
}))

import { createTaskRouter } from './orchestrator-task-router.js'
import { OrchestratorTaskService } from './orchestrator-tasks.js'
import { TaskStore } from './task-store.js'
import { CodekinApi } from './codekin-mcp-api.js'

describe('task router', () => {
  let store: TaskStore
  let service: OrchestratorTaskService
  let notify: ReturnType<typeof vi.fn>
  let server: Server
  let baseUrl: string
  let authorized: boolean

  /** Requests carrying the Joe token act as Joe; everything else is the user. */
  const actorOf = (req: Request) => (req.headers.authorization === 'Bearer joe' ? 'joe' as const : 'user' as const)

  beforeEach(async () => {
    authorized = true
    store = new TaskStore(':memory:')
    notify = vi.fn(() => true)
    service = new OrchestratorTaskService({ store, notify })
    const app = express()
    app.use(express.json())
    app.use(createTaskRouter(() => authorized, actorOf, service))
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    store.close()
  })

  const user = (path: string, method = 'GET', body?: unknown) => fetch(`${baseUrl}/api/orchestrator/tasks${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer user' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const joeApi = () => new CodekinApi({ baseUrl, token: 'joe' })

  it('401s without auth', async () => {
    authorized = false
    expect((await user('')).status).toBe(401)
  })

  it('delegates several tasks at once and hands them to Joe', async () => {
    const res = await user('', 'POST', {
      repo: '/repos/app/', delegate: true, completionPolicy: 'merge', acceptance: 'tests pass',
      tasks: [{ title: 'Fix flaky test' }, { title: 'Bump lodash', priority: 'low' }],
    })
    const { tasks } = await res.json()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ repo: '/repos/app', completionPolicy: 'merge', acceptance: 'tests pass', source: 'user', createdBy: 'user' })
    expect(tasks[1].priority).toBe('low')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('validates create requests', async () => {
    expect((await user('', 'POST', { repo: '/elsewhere', tasks: [{ title: 'x' }] })).status).toBe(400)
    expect((await user('', 'POST', { repo: '/repos/a', tasks: [] })).status).toBe(400)
    expect((await user('', 'POST', { repo: '/repos/a', tasks: [{ title: '  ' }] })).status).toBe(400)
    expect((await user('', 'POST', { repo: '/repos/a', tasks: [{ title: 'x', priority: 'urgent' }] })).status).toBe(400)
    expect((await user('', 'POST', { repo: '/repos/a', completionPolicy: 'deploy', tasks: [{ title: 'x' }] })).status).toBe(400)
    expect((await user('', 'POST', { repo: '/repos/a', tasks: Array.from({ length: 21 }, () => ({ title: 'x' })) })).status).toBe(400)
  })

  it('lets Joe keep the list through the MCP client', async () => {
    const api = joeApi()
    const created = await api.createTask({ repo: '/repos/a', title: 'Fix N+1 in orders', source: 'report', sourceRef: '/repos/a/.codekin/reports/code-review/2026-09-30.md' }) as { tasks: Array<{ id: string; createdBy: string; source: string }> }
    const task = created.tasks[0]
    expect(task).toMatchObject({ createdBy: 'joe', source: 'report' })

    await api.updateTask(task.id, { priority: 'high', note: 'hot path' })
    await api.requestDecision(task.id, { question: 'Add an index or cache?', recommendation: 'Index', options: ['Index', 'Cache'] })

    const listed = await api.listTasks({ repo: '/repos/a', status: 'needs_decision' }) as { tasks: Array<{ id: string; priority: string }>; counts: Record<string, number> }
    expect(listed.tasks.map(t => [t.id, t.priority])).toEqual([[task.id, 'high']])
    expect(listed.counts.needs_decision).toBe(1)

    const detail = await api.getTask(task.id) as { events: Array<{ actor: string; summary: string }> }
    expect(detail.events.map(e => e.summary)).toEqual(['Created: Fix N+1 in orders', 'Edited priority — hot path', 'Asked: Add an index or cache?'])
  })

  it('refuses consent actions from Joe but accepts them from the user', async () => {
    const task = service.create([{ repo: '/repos/a', title: 't', createdBy: 'joe' }])[0]
    service.requestDecision(task.id, { question: 'Go?' })

    const asJoe = await fetch(`${baseUrl}/api/orchestrator/tasks/${task.id}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer joe' }, body: JSON.stringify({ answer: 'yes' }),
    })
    expect(asJoe.status).toBe(403)
    expect(service.get(task.id)?.decision?.answer).toBeNull()

    const asUser = await user(`/${task.id}/answer`, 'POST', { answer: 'yes' })
    expect(asUser.status).toBe(200)
    expect((await asUser.json()).task.decision.answer).toBe('yes')
  })

  it('maps state conflicts to 409 and unknown tasks to 404', async () => {
    const task = service.create([{ repo: '/repos/a', title: 't', createdBy: 'user' }])[0]
    expect((await user(`/${task.id}/accept`, 'POST')).status).toBe(409)
    expect((await user(`/${task.id}/request-changes`, 'POST', { note: 'x' })).status).toBe(409)
    expect((await user('/missing/accept', 'POST')).status).toBe(404)
    expect((await user('/missing')).status).toBe(404)
  })

  it('validates patch and decision bodies', async () => {
    const task = service.create([{ repo: '/repos/a', title: 't', createdBy: 'user' }])[0]
    expect((await user(`/${task.id}`, 'PATCH', { status: 'in_review' })).status).toBe(400)
    expect((await user(`/${task.id}`, 'PATCH', { title: '' })).status).toBe(400)
    expect((await user(`/${task.id}/decision`, 'POST', { question: '' })).status).toBe(400)
    expect((await user(`/${task.id}/decision`, 'POST', { question: 'q', options: ['a', 3] })).status).toBe(400)
    expect((await user(`/${task.id}`, 'PATCH', { status: 'dismissed', note: 'dupe' })).status).toBe(200)
    expect(service.get(task.id)?.status).toBe('dismissed')
  })

  it('rejects an invalid list filter', async () => {
    expect((await user('?status=blocked')).status).toBe(400)
    expect((await user('?repo=/elsewhere')).status).toBe(400)
  })
})
