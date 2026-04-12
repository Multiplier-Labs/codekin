/** Tests for workflowApi — verifies workflow run and schedule REST client functions with mocked global fetch. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as Response
}

import {
  listRuns,
  getRun,
  triggerRun,
  cancelRun,
  listSchedules,
  triggerSchedule,
  getConfig,
  addRepoConfig,
  removeRepoConfig,
  patchRepoConfig,
} from './workflowApi.js'

describe('workflowApi', () => {
  const token = 'test-token'

  describe('listRuns', () => {
    it('fetches runs without filters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ runs: [{ id: 'r1', kind: 'test' }] }))
      const runs = await listRuns(token)
      expect(runs).toEqual([{ id: 'r1', kind: 'test' }])
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/runs', expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }))
    })

    it('appends query params for filters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ runs: [] }))
      await listRuns(token, { kind: 'test', status: 'failed', limit: 10, offset: 5 })
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('kind=test')
      expect(url).toContain('status=failed')
      expect(url).toContain('limit=10')
      expect(url).toContain('offset=5')
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(listRuns(token)).rejects.toThrow('Failed to list runs: 500')
    })
  })

  describe('getRun', () => {
    it('fetches a single run', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'r1', steps: [] } }))
      const run = await getRun(token, 'r1')
      expect(run).toEqual({ id: 'r1', steps: [] })
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/runs/r1', expect.any(Object))
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
      await expect(getRun(token, 'r1')).rejects.toThrow('Failed to get run: 404')
    })
  })

  describe('triggerRun', () => {
    it('triggers a workflow run', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'new-run' } }))
      const run = await triggerRun(token, 'test-kind', { key: 'val' })
      expect(run).toEqual({ id: 'new-run' })
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/runs', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'test-kind', input: { key: 'val' } }),
      }))
    })

    it('uses empty object as default input', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'r1' } }))
      await triggerRun(token, 'test-kind')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.input).toEqual({})
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 400))
      await expect(triggerRun(token, 'test')).rejects.toThrow('Failed to trigger run: 400')
    })
  })

  describe('cancelRun', () => {
    it('cancels a run', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200))
      await cancelRun(token, 'r1')
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/runs/r1/cancel', expect.objectContaining({
        method: 'POST',
      }))
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
      await expect(cancelRun(token, 'r1')).rejects.toThrow('Failed to cancel run: 404')
    })
  })

  describe('listSchedules', () => {
    it('fetches schedules', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ schedules: [{ id: 's1' }] }))
      const schedules = await listSchedules(token)
      expect(schedules).toEqual([{ id: 's1' }])
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(listSchedules(token)).rejects.toThrow('Failed to list schedules: 500')
    })
  })

  describe('triggerSchedule', () => {
    it('triggers a schedule', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run: { id: 'triggered-run' } }))
      const run = await triggerSchedule(token, 's1')
      expect(run).toEqual({ id: 'triggered-run' })
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(triggerSchedule(token, 's1')).rejects.toThrow('Failed to trigger schedule: 500')
    })
  })

  describe('getConfig', () => {
    it('fetches config', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ config: { reviewRepos: [] } }))
      const config = await getConfig(token)
      expect(config).toEqual({ reviewRepos: [] })
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(getConfig(token)).rejects.toThrow('Failed to get config: 500')
    })
  })

  describe('addRepoConfig', () => {
    it('adds a repo config', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ config: { reviewRepos: [{ id: 'r1' }] } }))
      const repo = { id: 'r1', name: 'Repo', repoPath: '/tmp', cronExpression: '0 6 * * *', enabled: true }
      const result = await addRepoConfig(token, repo)
      expect(result.config.reviewRepos).toHaveLength(1)
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/config/repos', expect.objectContaining({
        method: 'POST',
      }))
    })

    it('passes webhookUrl in request body when provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ config: { reviewRepos: [{ id: 'r1' }] }, webhookSetup: { status: 'created', message: 'ok' } }))
      const repo = { id: 'r1', name: 'Repo', repoPath: '/tmp', cronExpression: 'event', enabled: true, kind: 'pr-review' }
      const result = await addRepoConfig(token, repo, 'https://example.com/cc/api/webhooks/github')
      expect(result.webhookSetup).toEqual({ status: 'created', message: 'ok' })
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(callBody.webhookUrl).toBe('https://example.com/cc/api/webhooks/github')
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(addRepoConfig(token, {} as any)).rejects.toThrow('Failed to add repo config: 500')
    })
  })

  describe('removeRepoConfig', () => {
    it('removes a repo config', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ config: { reviewRepos: [] } }))
      const config = await removeRepoConfig(token, 'r1')
      expect(config.reviewRepos).toEqual([])
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/config/repos/r1', expect.objectContaining({
        method: 'DELETE',
      }))
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
      await expect(removeRepoConfig(token, 'r1')).rejects.toThrow('Failed to remove repo config: 404')
    })
  })

  describe('patchRepoConfig', () => {
    it('patches a repo config', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ config: { reviewRepos: [{ id: 'r1', name: 'Updated' }] } }))
      const config = await patchRepoConfig(token, 'r1', { name: 'Updated' })
      expect(config.reviewRepos[0].name).toBe('Updated')
      expect(mockFetch).toHaveBeenCalledWith('/cc/api/workflows/config/repos/r1', expect.objectContaining({
        method: 'PATCH',
      }))
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
      await expect(patchRepoConfig(token, 'r1', {})).rejects.toThrow('Failed to update repo config: 500')
    })
  })
})
