/** Tests for loopsApi — request shape and the exact error messages callers show. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listLoopRuns,
  getLoopRun,
  preflightLoopRun,
  startLoopRun,
  pauseLoopRun,
  steerLoopRun,
  resolveLoopLesson,
  getLoopArtifactBody,
  forkLoopRun,
} from './loopsApi'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const JSON_AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }

describe('loopsApi requests', () => {
  it('lists runs with filters, sending the JSON content type on GET', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ runs: [{ id: 'r1' }] }))
    expect(await listLoopRuns('tok', { active: true, limit: 5 })).toEqual([{ id: 'r1' }])
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/loops/runs?active=1&limit=5', { headers: JSON_AUTH })
  })

  it('posts a steer instruction', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await steerLoopRun('tok', 'r/1', 'go left', true)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/loops/runs/r%2F1/steer', {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ instruction: 'go left', revisePlan: true }),
    })
  })

  it('reads an artifact body as text', async () => {
    mockFetch.mockResolvedValue(new Response('# Plan', { status: 200 }))
    expect(await getLoopArtifactBody('tok', 'r1', 'a1')).toBe('# Plan')
  })
})

describe('loopsApi error messages', () => {
  it('status-only messages', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'ignored' }, 500))
    await expect(listLoopRuns('tok')).rejects.toThrow(new Error('Failed to list loop runs: 500'))
    mockFetch.mockResolvedValue(jsonResponse({}, 404))
    await expect(getLoopRun('tok', 'r1')).rejects.toThrow(new Error('Failed to fetch loop run: 404'))
    mockFetch.mockResolvedValue(new Response('gone', { status: 410 }))
    await expect(getLoopArtifactBody('tok', 'r1', 'a1')).rejects.toThrow(new Error('Failed to fetch artifact: 410'))
  })

  it('controls prefer the server error, else name the action and status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Run is not running' }, 409))
    await expect(pauseLoopRun('tok', 'r1')).rejects.toThrow(new Error('Run is not running'))
    mockFetch.mockResolvedValue(new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    await expect(pauseLoopRun('tok', 'r1')).rejects.toThrow(new Error('Failed to pause loop run: 502'))
    mockFetch.mockResolvedValue(jsonResponse({}, 400))
    await expect(resolveLoopLesson('tok', 'l1', 'reject')).rejects.toThrow(new Error('Failed to reject lesson: 400'))
  })

  it('preflight, start and fork fail on a missing result even when the status is ok', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Unknown recipe' }, 400))
    await expect(preflightLoopRun('tok', { recipeId: 'x', repo: '/r' })).rejects.toThrow(new Error('Unknown recipe'))
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await expect(startLoopRun('tok', { recipeId: 'x', repo: '/r' })).rejects.toThrow(new Error('Failed to start loop run: 200'))
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(forkLoopRun('tok', 'r1')).rejects.toThrow(new Error('Failed to fork run: 500'))
  })
})
