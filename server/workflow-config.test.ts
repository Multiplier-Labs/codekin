import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '{"reviewRepos": []}'),
    writeFileSync: vi.fn(),
  }
})

import {
  loadWorkflowConfig,
  saveWorkflowConfig,
  addReviewRepo,
  removeReviewRepo,
  updateReviewRepo,
} from './workflow-config.js'
import type { ReviewRepoConfig, WorkflowConfig } from './workflow-config.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

describe('workflow-config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loadWorkflowConfig', () => {
    it('returns empty config when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      const config = loadWorkflowConfig()
      expect(config).toEqual({ reviewRepos: [] })
    })

    it('loads config from file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        reviewRepos: [{ id: 'r1', name: 'Repo 1', repoPath: '/tmp/repo1', cronExpression: '0 6 * * *', enabled: true }],
      }))

      const config = loadWorkflowConfig()
      expect(config.reviewRepos).toHaveLength(1)
      expect(config.reviewRepos[0].name).toBe('Repo 1')
    })

    it('returns empty config on corrupted JSON', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('{broken json')
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const config = loadWorkflowConfig()
      expect(config).toEqual({ reviewRepos: [] })
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('saveWorkflowConfig', () => {
    it('creates directory if it does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      saveWorkflowConfig({ reviewRepos: [] })
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true })
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('skips mkdir if directory exists', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      saveWorkflowConfig({ reviewRepos: [] })
      expect(mkdirSync).not.toHaveBeenCalled()
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('writes config as formatted JSON', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      const config: WorkflowConfig = {
        reviewRepos: [{ id: 'r1', name: 'Test', repoPath: '/tmp', cronExpression: '0 6 * * *', enabled: true }],
      }
      saveWorkflowConfig(config)
      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string
      expect(JSON.parse(written)).toEqual(config)
    })
  })

  describe('addReviewRepo', () => {
    it('adds a new repo', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('{"reviewRepos": []}')

      const repo: ReviewRepoConfig = {
        id: 'new-repo',
        name: 'New Repo',
        repoPath: '/tmp/new',
        cronExpression: '0 8 * * *',
        enabled: true,
      }

      const config = addReviewRepo(repo)
      expect(config.reviewRepos).toHaveLength(1)
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('updates existing repo with same id', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        reviewRepos: [{ id: 'r1', name: 'Old Name', repoPath: '/tmp', cronExpression: '0 6 * * *', enabled: true }],
      }))

      const repo: ReviewRepoConfig = {
        id: 'r1',
        name: 'Updated Name',
        repoPath: '/tmp/updated',
        cronExpression: '0 12 * * *',
        enabled: false,
      }

      const config = addReviewRepo(repo)
      expect(config.reviewRepos).toHaveLength(1)
      expect(config.reviewRepos[0].name).toBe('Updated Name')
    })
  })

  describe('removeReviewRepo', () => {
    it('removes repo by id', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        reviewRepos: [
          { id: 'r1', name: 'Repo 1', repoPath: '/tmp/1', cronExpression: '0 6 * * *', enabled: true },
          { id: 'r2', name: 'Repo 2', repoPath: '/tmp/2', cronExpression: '0 7 * * *', enabled: true },
        ],
      }))

      const config = removeReviewRepo('r1')
      expect(config.reviewRepos).toHaveLength(1)
      expect(config.reviewRepos[0].id).toBe('r2')
    })

    it('does nothing for non-existent id', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        reviewRepos: [{ id: 'r1', name: 'Repo 1', repoPath: '/tmp/1', cronExpression: '0 6 * * *', enabled: true }],
      }))

      const config = removeReviewRepo('nonexistent')
      expect(config.reviewRepos).toHaveLength(1)
    })
  })

  describe('updateReviewRepo', () => {
    it('patches an existing repo', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        reviewRepos: [{ id: 'r1', name: 'Repo 1', repoPath: '/tmp/1', cronExpression: '0 6 * * *', enabled: true }],
      }))

      const config = updateReviewRepo('r1', { name: 'Patched', enabled: false })
      expect(config.reviewRepos[0].name).toBe('Patched')
      expect(config.reviewRepos[0].enabled).toBe(false)
      expect(config.reviewRepos[0].repoPath).toBe('/tmp/1') // unchanged
    })

    it('throws for non-existent repo', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('{"reviewRepos": []}')

      expect(() => updateReviewRepo('nonexistent', { name: 'X' })).toThrow('Repo not found: nonexistent')
    })
  })
})
