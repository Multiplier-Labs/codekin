import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkGhHealth,
  fetchFailedLogs,
  fetchJobs,
  fetchAnnotations,
  fetchCommitMessage,
  fetchPRTitle,
  _setGhRunner,
  _resetGhRunner,
} from './webhook-github.js'

describe('webhook-github', () => {
  let mockGh: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGh = vi.fn()
    _setGhRunner(mockGh)
  })

  afterEach(() => {
    _resetGhRunner()
  })

  describe('checkGhHealth', () => {
    it('returns available when all checks pass', async () => {
      mockGh.mockResolvedValue('')
      const result = await checkGhHealth()
      expect(result).toEqual({ available: true })
      expect(mockGh).toHaveBeenCalledTimes(3)
    })

    it('returns not available when --version fails', async () => {
      mockGh.mockRejectedValue(new Error('not found'))
      const result = await checkGhHealth()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('not installed')
    })

    it('returns not available when auth status fails', async () => {
      mockGh
        .mockResolvedValueOnce('gh version 2.0') // --version ok
        .mockRejectedValueOnce(new Error('not logged in'))
      const result = await checkGhHealth()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('not authenticated')
    })

    it('returns not available when API call fails', async () => {
      mockGh
        .mockResolvedValueOnce('gh version 2.0') // --version ok
        .mockResolvedValueOnce('Logged in')       // auth ok
        .mockRejectedValueOnce(new Error('network error'))
      const result = await checkGhHealth()
      expect(result.available).toBe(false)
      expect(result.reason).toContain('cannot access')
    })
  })

  describe('fetchFailedLogs', () => {
    it('returns full output when under maxLines', async () => {
      mockGh.mockResolvedValue('line1\nline2\nline3')
      const logs = await fetchFailedLogs('owner/repo', 123, 10)
      expect(logs).toBe('line1\nline2\nline3')
      expect(mockGh).toHaveBeenCalledWith(['run', 'view', '123', '--repo', 'owner/repo', '--log-failed'])
    })

    it('truncates to last N lines when over maxLines', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
      mockGh.mockResolvedValue(lines.join('\n'))
      const logs = await fetchFailedLogs('owner/repo', 123, 5)
      expect(logs.split('\n')).toHaveLength(5)
      expect(logs).toContain('line-19')
      expect(logs).not.toContain('line-0')
    })

    it('returns empty string on error', async () => {
      mockGh.mockRejectedValue(new Error('fail'))
      const logs = await fetchFailedLogs('owner/repo', 123, 10)
      expect(logs).toBe('')
    })
  })

  describe('fetchJobs', () => {
    it('parses jobs and steps from JSON', async () => {
      const response = {
        jobs: [{
          id: 1,
          name: 'build',
          conclusion: 'failure',
          steps: [{ name: 'checkout', number: 1, conclusion: 'success' }],
        }],
      }
      mockGh.mockResolvedValue(JSON.stringify(response))
      const jobs = await fetchJobs('owner/repo', 123)
      expect(jobs).toEqual([{
        id: 1,
        name: 'build',
        conclusion: 'failure',
        steps: [{ name: 'checkout', number: 1, conclusion: 'success' }],
      }])
    })

    it('maps null conclusion to "unknown"', async () => {
      const response = {
        jobs: [{ id: 1, name: 'test', conclusion: null, steps: [{ name: 's', number: 1, conclusion: null }] }],
      }
      mockGh.mockResolvedValue(JSON.stringify(response))
      const jobs = await fetchJobs('owner/repo', 123)
      expect(jobs[0].conclusion).toBe('unknown')
      expect(jobs[0].steps[0].conclusion).toBe('unknown')
    })

    it('returns empty array when data.jobs is missing', async () => {
      mockGh.mockResolvedValue(JSON.stringify({}))
      const jobs = await fetchJobs('owner/repo', 123)
      expect(jobs).toEqual([])
    })

    it('handles jobs with no steps', async () => {
      const response = { jobs: [{ id: 1, name: 'build', conclusion: 'failure' }] }
      mockGh.mockResolvedValue(JSON.stringify(response))
      const jobs = await fetchJobs('owner/repo', 123)
      expect(jobs[0].steps).toEqual([])
    })

    it('returns empty array on error', async () => {
      mockGh.mockRejectedValue(new Error('fail'))
      const jobs = await fetchJobs('owner/repo', 123)
      expect(jobs).toEqual([])
    })
  })

  describe('fetchAnnotations', () => {
    it('traverses check-runs and fetches annotations for failures', async () => {
      mockGh
        // First call: check-runs
        .mockResolvedValueOnce(JSON.stringify({
          check_runs: [
            { id: 10, conclusion: 'failure' },
            { id: 11, conclusion: 'success' },
          ],
        }))
        // Second call: annotations for run 10
        .mockResolvedValueOnce(JSON.stringify([{
          path: 'src/index.ts',
          start_line: 5,
          end_line: 5,
          message: 'Error here',
          annotation_level: 'failure',
        }]))

      const annotations = await fetchAnnotations('owner/repo', 42)
      expect(annotations).toEqual([{
        path: 'src/index.ts',
        startLine: 5,
        endLine: 5,
        message: 'Error here',
        annotationLevel: 'failure',
      }])
      // Should only fetch annotations for the failed run (id=10), not success (id=11)
      expect(mockGh).toHaveBeenCalledTimes(2)
    })

    it('returns empty array when check-runs fetch fails', async () => {
      mockGh.mockRejectedValue(new Error('fail'))
      const annotations = await fetchAnnotations('owner/repo', 42)
      expect(annotations).toEqual([])
    })

    it('continues when individual annotation fetch fails', async () => {
      mockGh
        .mockResolvedValueOnce(JSON.stringify({
          check_runs: [
            { id: 10, conclusion: 'failure' },
            { id: 11, conclusion: 'failure' },
          ],
        }))
        .mockRejectedValueOnce(new Error('fail for run 10'))
        .mockResolvedValueOnce(JSON.stringify([{
          path: 'b.ts',
          start_line: 1,
          end_line: 2,
          message: 'ok',
          annotation_level: 'warning',
        }]))

      const annotations = await fetchAnnotations('owner/repo', 42)
      expect(annotations).toHaveLength(1)
      expect(annotations[0].path).toBe('b.ts')
    })

    it('returns empty array when no failed check runs', async () => {
      mockGh.mockResolvedValueOnce(JSON.stringify({
        check_runs: [{ id: 10, conclusion: 'success' }],
      }))
      const annotations = await fetchAnnotations('owner/repo', 42)
      expect(annotations).toEqual([])
      // Should only call once (check-runs), no annotation fetches
      expect(mockGh).toHaveBeenCalledTimes(1)
    })

    it('handles missing check_runs field', async () => {
      mockGh.mockResolvedValueOnce(JSON.stringify({}))
      const annotations = await fetchAnnotations('owner/repo', 42)
      expect(annotations).toEqual([])
    })
  })

  describe('fetchCommitMessage', () => {
    it('returns trimmed commit message', async () => {
      mockGh.mockResolvedValue('  fix: something\n')
      const msg = await fetchCommitMessage('owner/repo', 'abc123')
      expect(msg).toBe('fix: something')
    })

    it('returns empty string on error', async () => {
      mockGh.mockRejectedValue(new Error('fail'))
      const msg = await fetchCommitMessage('owner/repo', 'abc123')
      expect(msg).toBe('')
    })
  })

  describe('fetchPRTitle', () => {
    it('returns trimmed PR title', async () => {
      mockGh.mockResolvedValue('  Add feature X\n')
      const title = await fetchPRTitle('owner/repo', 42)
      expect(title).toBe('Add feature X')
    })

    it('returns empty string on error', async () => {
      mockGh.mockRejectedValue(new Error('fail'))
      const title = await fetchPRTitle('owner/repo', 42)
      expect(title).toBe('')
    })
  })
})
