import { beforeEach, describe, expect, it, vi } from 'vitest'
import { answerDecision, attentionCount, parseTaskLines, repoName, requestChanges, startTask } from './tasksApi'

describe('parseTaskLines', () => {
  it('makes one task per non-empty line and strips list markers', () => {
    expect(parseTaskLines('- Fix login\n\n  2) Bump lodash  \n* Add docs\n• Tidy\n3. Last')).toEqual([
      { title: 'Fix login' }, { title: 'Bump lodash' }, { title: 'Add docs' }, { title: 'Tidy' }, { title: 'Last' },
    ])
  })

  it('caps titles at 300 characters', () => {
    expect(parseTaskLines('x'.repeat(400))[0].title).toHaveLength(300)
  })
})

describe('helpers', () => {
  it('counts decisions and reviews as waiting on the user', () => {
    expect(attentionCount({ todo: 4, in_progress: 2, needs_decision: 1, in_review: 2, done: 9, dismissed: 1 })).toBe(3)
    expect(attentionCount(null)).toBe(0)
  })

  it('shows the last path segment of a repo', () => {
    expect(repoName('/srv/repos/org/app/')).toBe('app')
  })
})

describe('task requests', () => {
  const mockFetch = vi.fn()
  beforeEach(() => {
    mockFetch.mockReset()
    global.fetch = mockFetch
  })
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('rejects with the server error, or "Request failed (<status>)"', async () => {
    mockFetch.mockResolvedValue(json({ error: 'Task is not awaiting a decision' }, 409))
    await expect(answerDecision('tok', 't1', 'yes')).rejects.toThrow(new Error('Task is not awaiting a decision'))
    mockFetch.mockResolvedValue(new Response('bad gateway', { status: 502 }))
    await expect(startTask('tok', 't1')).rejects.toThrow(new Error('Request failed (502)'))
  })

  it('posts to the task route and unwraps the task', async () => {
    mockFetch.mockResolvedValue(json({ task: { id: 't1' } }, 200))
    expect(await requestChanges('tok', 't 1', 'tighten tests')).toEqual({ id: 't1' })
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/orchestrator/tasks/t%201/request-changes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ note: 'tighten tests' }),
    })
  })
})
