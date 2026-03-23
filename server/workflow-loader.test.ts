/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Hoist mock fns so they're available at module evaluation time
const mockExecSync = vi.hoisted(() => vi.fn())
const mockExecFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn(() => true))
const mockMkdirSync = vi.hoisted(() => vi.fn())
const mockReaddirSync = vi.hoisted(() => vi.fn(() => [] as string[]))
const mockReadFileSync = vi.hoisted(() => vi.fn(() => ''))
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockRealpathSync = vi.hoisted(() => vi.fn((p: string) => p))

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    readdirSync: (...args: any[]) => mockReaddirSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    realpathSync: (...args: any[]) => mockRealpathSync(...args),
  }
})

// Mock config to set REPOS_ROOT to /tmp so test paths pass validation
vi.mock('./config.js', () => ({
  REPOS_ROOT: '/tmp',
}))

// Mock better-sqlite3 (needed by workflow-engine import)
vi.mock('better-sqlite3', () => {
  class MockDatabase {
    pragma = vi.fn()
    exec = vi.fn()
    prepare = vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(),
      all: vi.fn(() => []),
    }))
    close = vi.fn()
  }
  return { default: MockDatabase }
})

import { loadMdWorkflows, listAvailableKinds, ensureRepoWorkflowsRegistered, getWorkflowCommitPrefixes } from './workflow-loader.js'
import { join } from 'path'

// Valid workflow MD content
const VALID_MD = `---
kind: test-review.daily
name: Test Review
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review
---
You are performing an automated test review of the codebase.
`

const VALID_MD_2 = `---
kind: coverage.daily
name: Coverage Assessment
sessionPrefix: coverage
outputDir: .codekin/reports/coverage
filenameSuffix: _coverage.md
commitMessage: chore: coverage
---
Analyze test coverage.
`

function fakeEngine() {
  return {
    registerWorkflow: vi.fn(),
  } as any
}

function fakeSessionManager() {
  return {
    create: vi.fn(() => ({ id: 'session-1' })),
    get: vi.fn(() => ({
      outputHistory: [],
      claudeProcess: { isAlive: () => false },
    })),
    startClaude: vi.fn(),
    stopClaude: vi.fn(),
    sendInput: vi.fn(),
  } as any
}

describe('workflow-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue([])
    mockReadFileSync.mockReturnValue('')
  })

  describe('loadMdWorkflows', () => {
    it('loads and registers workflows from MD files', () => {
      mockReaddirSync.mockReturnValue(['test-review.daily.md', 'coverage.daily.md'])
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('test-review')) return VALID_MD
        if (String(path).includes('coverage')) return VALID_MD_2
        return ''
      })

      const engine = fakeEngine()
      const sessions = fakeSessionManager()

      loadMdWorkflows(engine, sessions)

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(2)
      expect(engine.registerWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'test-review.daily' })
      )
      expect(engine.registerWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'coverage.daily' })
      )
    })

    it('skips non-MD files', () => {
      mockReaddirSync.mockReturnValue(['readme.txt', 'test.md', 'config.json'])
      mockReadFileSync.mockReturnValue(VALID_MD)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      // Only test.md should be processed
      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('handles missing workflows directory', () => {
      mockExistsSync.mockReturnValue(false)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).not.toHaveBeenCalled()
    })

    it('skips MD files with invalid frontmatter', () => {
      mockReaddirSync.mockReturnValue(['bad.md', 'good.md'])
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('bad')) return 'no frontmatter here'
        return VALID_MD
      })

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('skips MD files with missing required fields', () => {
      const incompleteMd = `---
kind: incomplete
name: Incomplete
---
Some prompt.
`
      mockReaddirSync.mockReturnValue(['incomplete.md'])
      mockReadFileSync.mockReturnValue(incompleteMd)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('registered workflow steps', () => {
    let engine: any
    let sessions: any
    let registeredDef: any

    beforeEach(() => {
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(VALID_MD)

      engine = fakeEngine()
      sessions = fakeSessionManager()
      loadMdWorkflows(engine, sessions)

      registeredDef = engine.registerWorkflow.mock.calls[0][0]
    })

    it('registers 4 steps', () => {
      expect(registeredDef.steps).toHaveLength(4)
      expect(registeredDef.steps.map((s: any) => s.key)).toEqual([
        'validate_repo',
        'create_session',
        'run_prompt',
        'save_report',
      ])
    })

    describe('validate_repo step', () => {
      it('throws when repoPath is missing', async () => {
        const handler = registeredDef.steps[0].handler
        await expect(handler({}, { runId: 'r1', run: {}, abortSignal: new AbortController().signal }))
          .rejects.toThrow('Missing repoPath')
      })

      it('throws when repoPath does not exist', async () => {
        mockExistsSync.mockImplementation((p: string) => {
          if (String(p) === '/tmp/nonexistent') return false
          return true
        })

        const handler = registeredDef.steps[0].handler
        await expect(handler({ repoPath: '/tmp/nonexistent' }, { runId: 'r1', run: {}, abortSignal: new AbortController().signal }))
          .rejects.toThrow('does not exist')
      })

      it('validates a valid git repo', async () => {
        mockExecFileSync.mockReturnValue(Buffer.from('main\n'))

        const handler = registeredDef.steps[0].handler
        const result = await handler(
          { repoPath: '/tmp/repo', repoName: 'my-repo' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.branch).toBe('main')
        expect(result.repoPath).toBe('/tmp/repo')
        expect(result.repoName).toBe('my-repo')
      })

      it('skips when no code changes since last run', async () => {
        mockExecFileSync
          .mockReturnValueOnce(Buffer.from('main\n'))   // git rev-parse
          .mockReturnValueOnce(Buffer.from('abc\n'))    // git log -1
          .mockReturnValueOnce(Buffer.from(''))         // git log --since (no commits)

        const handler = registeredDef.steps[0].handler
        await expect(handler(
          { repoPath: '/tmp/repo', sinceTimestamp: '2026-03-07T00:00:00Z' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )).rejects.toThrow('No code changes')
      })

      it('continues when there are code changes since last run', async () => {
        mockExecFileSync
          .mockReturnValueOnce(Buffer.from('main\n'))              // git rev-parse
          .mockReturnValueOnce(Buffer.from('abc short\n'))         // git log -1
          .mockReturnValueOnce(Buffer.from('abc123 some commit\n')) // git log --since

        const handler = registeredDef.steps[0].handler
        const result = await handler(
          { repoPath: '/tmp/repo', sinceTimestamp: '2026-03-07T00:00:00Z' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.branch).toBe('main')
      })

      it('throws for non-git directory', async () => {
        mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo') })

        const handler = registeredDef.steps[0].handler
        await expect(handler(
          { repoPath: '/tmp/not-git' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )).rejects.toThrow('Not a valid git repository')
      })
    })

    describe('create_session step', () => {
      it('creates a session with the correct name and working directory', async () => {
        const handler = registeredDef.steps[1].handler
        const result = await handler(
          { repoPath: '/tmp/repo', repoName: 'my-repo', branch: 'main', lastCommit: 'abc123' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(sessions.create).toHaveBeenCalledWith('test-review:my-repo', '/tmp/repo', {
          source: 'workflow',
          groupDir: '/tmp/repo',
        })
        expect(result.sessionId).toBe('session-1')
        expect(result.repoName).toBe('my-repo')
      })

      it('extracts repo name from path when not provided', async () => {
        const handler = registeredDef.steps[1].handler
        await handler(
          { repoPath: '/home/user/projects/my-app', branch: 'main' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(sessions.create).toHaveBeenCalledWith(
          'test-review:my-app',
          '/home/user/projects/my-app',
          expect.any(Object)
        )
      })
    })

    describe('afterRun hook', () => {
      it('stops Claude process on completion', async () => {
        sessions.get.mockReturnValue({
          claudeProcess: { isAlive: () => true },
        })

        await registeredDef.afterRun({ output: { sessionId: 'session-1' } })

        expect(sessions.stopClaude).toHaveBeenCalledWith('session-1')
      })

      it('skips cleanup when no session ID', async () => {
        await registeredDef.afterRun({ output: null })
        expect(sessions.stopClaude).not.toHaveBeenCalled()
      })

      it('skips cleanup when Claude is not alive', async () => {
        sessions.get.mockReturnValue({
          claudeProcess: { isAlive: () => false },
        })

        await registeredDef.afterRun({ output: { sessionId: 'session-1' } })
        expect(sessions.stopClaude).not.toHaveBeenCalled()
      })

      it('handles cleanup errors gracefully', async () => {
        sessions.get.mockImplementation(() => { throw new Error('session gone') })

        // Should not throw
        await registeredDef.afterRun({ output: { sessionId: 'session-1' } })
      })
    })

    describe('validate_repo path traversal protection', () => {
      it('rejects paths outside REPOS_ROOT', async () => {
        mockRealpathSync.mockReturnValue('/etc/passwd')
        const handler = registeredDef.steps[0].handler
        await expect(handler(
          { repoPath: '/tmp/../../etc/passwd' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )).rejects.toThrow('outside REPOS_ROOT')
      })
    })

    describe('save_report step', () => {
      it('writes report and commits on reports branch', async () => {
        mockExecFileSync.mockReturnValue(Buffer.from('main\n'))

        const handler = registeredDef.steps[3].handler
        const result = await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'Test report content',
            sessionId: 'session-1',
            branch: 'main',
          },
          { runId: 'run-123', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.filePath).toContain('.codekin/reports/test')
        expect(result.filename).toContain('_test-review.md')
        expect(result.sessionId).toBe('session-1')
        expect(mockWriteFileSync).toHaveBeenCalled()
        expect(mockExecFileSync).toHaveBeenCalled()
      })

      it('creates output directory if it does not exist', async () => {
        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('reports')) return false
          return true
        })
        mockExecFileSync.mockReturnValue(Buffer.from('main\n'))

        const handler = registeredDef.steps[3].handler
        await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'Content',
            sessionId: 's1',
            branch: 'main',
          },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(mockMkdirSync).toHaveBeenCalledWith(
          expect.stringContaining('reports'),
          { recursive: true }
        )
      })

      it('handles git commit failure gracefully', async () => {
        mockExecFileSync.mockImplementation(() => { throw new Error('git failed') })
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const handler = registeredDef.steps[3].handler
        const result = await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'Content',
            sessionId: 's1',
            branch: 'main',
          },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        // Still returns the file path even if git fails
        expect(result.filePath).toBeDefined()
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })
  })

  // -------------------------------------------------------------------------
  // listAvailableKinds
  // -------------------------------------------------------------------------

  describe('listAvailableKinds', () => {
    it('returns empty when no workflows directory exists', () => {
      mockExistsSync.mockReturnValue(false)
      const kinds = listAvailableKinds()
      expect(kinds).toEqual([])
    })

    it('returns built-in workflows as source "builtin"', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['review.md'])
      mockReadFileSync.mockReturnValue(VALID_MD)

      const kinds = listAvailableKinds()
      expect(kinds).toHaveLength(1)
      expect(kinds[0]).toEqual({
        kind: 'test-review.daily',
        name: 'Test Review',
        source: 'builtin',
      })
    })

    it('includes repo-only workflows as source "repo"', () => {
      const repoPath = '/tmp/my-app'
      const repoDir = join(repoPath, '.codekin', 'workflows')
      const repoMd = VALID_MD.replace('test-review.daily', 'custom.lint').replace('Test Review', 'Custom Lint')

      mockExistsSync.mockImplementation((p: string) => {
        if (String(p) === repoDir) return true
        return false
      })
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p) === repoDir) return ['custom.lint.md']
        return []
      })
      mockReadFileSync.mockReturnValue(repoMd)

      const kinds = listAvailableKinds(repoPath)
      expect(kinds).toHaveLength(1)
      expect(kinds[0]).toEqual({
        kind: 'custom.lint',
        name: 'Custom Lint',
        source: 'repo',
      })
    })

    it('does not duplicate repo kinds that match a built-in', () => {
      const repoPath = '/tmp/my-app'
      const repoDir = join(repoPath, '.codekin', 'workflows')

      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p) === repoDir) return ['test-review.daily.md']
        return ['review.md']
      })
      mockReadFileSync.mockReturnValue(VALID_MD)

      const kinds = listAvailableKinds(repoPath)
      const matching = kinds.filter(k => k.kind === 'test-review.daily')
      expect(matching).toHaveLength(1)
      expect(matching[0].source).toBe('builtin')
    })
  })

  // -------------------------------------------------------------------------
  // ensureRepoWorkflowsRegistered
  // -------------------------------------------------------------------------

  describe('ensureRepoWorkflowsRegistered', () => {
    it('registers repo workflows whose kind is not in the engine', () => {
      const repoPath = '/tmp/ensure-test'
      const repoDir = join(repoPath, '.codekin', 'workflows')
      const repoMd = VALID_MD.replace('test-review.daily', 'custom.ensure').replace('Test Review', 'Ensure Test')

      mockExistsSync.mockImplementation((p: string) => String(p) === repoDir)
      mockReaddirSync.mockImplementation((p: string) =>
        String(p) === repoDir ? ['custom.ensure.md'] : [],
      )
      mockReadFileSync.mockReturnValue(repoMd)

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn(() => false),
      } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('skips kinds already registered in the engine', () => {
      const repoPath = '/tmp/skip-test'
      const repoDir = join(repoPath, '.codekin', 'workflows')

      mockExistsSync.mockImplementation((p: string) => String(p) === repoDir)
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(VALID_MD)

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn(() => true),
      } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)
      expect(mockEngine.registerWorkflow).not.toHaveBeenCalled()
    })

    it('returns silently when repo has no .codekin/workflows dir', () => {
      mockExistsSync.mockReturnValue(false)
      const mockEngine = { registerWorkflow: vi.fn(), hasWorkflow: vi.fn() } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, '/tmp/no-workflows')
      expect(mockEngine.registerWorkflow).not.toHaveBeenCalled()
    })

    it('only registers once per repo+kind (registeredRepoKinds guard)', () => {
      // Use a unique repoPath so the module-level registeredRepoKinds Set
      // does not collide with other tests.
      const repoPath = '/tmp/idempotency-test'
      const repoDir = join(repoPath, '.codekin', 'workflows')
      const repoMd = VALID_MD.replace('test-review.daily', 'idempotent.kind').replace('Test Review', 'Idempotent')

      mockExistsSync.mockImplementation((p: string) => String(p) === repoDir)
      mockReaddirSync.mockImplementation((p: string) =>
        String(p) === repoDir ? ['idempotent.kind.md'] : [],
      )
      mockReadFileSync.mockReturnValue(repoMd)

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn(() => false),
      } as any

      // First call — should register
      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)

      mockEngine.registerWorkflow.mockClear()

      // Second call with same repo+kind — registeredRepoKinds guard skips it
      // (hasWorkflow still returns false, so the ONLY guard is registeredRepoKinds)
      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)
      expect(mockEngine.registerWorkflow).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getWorkflowCommitPrefixes
  // -------------------------------------------------------------------------

  describe('getWorkflowCommitPrefixes', () => {
    it('returns an array of commit message strings from built-in workflows', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['review.md', 'coverage.md'])
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('review')) return VALID_MD
        if (String(path).includes('coverage')) return VALID_MD_2
        return ''
      })

      const prefixes = getWorkflowCommitPrefixes()

      expect(Array.isArray(prefixes)).toBe(true)
      expect(prefixes.length).toBeGreaterThan(0)
      prefixes.forEach(prefix => {
        expect(typeof prefix).toBe('string')
        expect(prefix.length).toBeGreaterThan(0)
      })
    })

    it('returns empty array when no workflows directory exists', () => {
      mockExistsSync.mockReturnValue(false)

      const prefixes = getWorkflowCommitPrefixes()
      expect(prefixes).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // discoverRepoWorkflows edge cases (via ensureRepoWorkflowsRegistered)
  // -------------------------------------------------------------------------

  describe('discoverRepoWorkflows invalid file handling', () => {
    it('logs a warning and skips an invalid MD file in repo workflows dir', () => {
      const repoPath = '/tmp/invalid-md-test'
      const repoDir = join(repoPath, '.codekin', 'workflows')

      mockExistsSync.mockImplementation((p: string) => String(p) === repoDir)
      mockReaddirSync.mockImplementation((p: string) =>
        String(p) === repoDir ? ['bad-workflow.md', 'good-workflow.md'] : [],
      )
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('bad-workflow')) return 'no frontmatter here at all'
        if (String(path).includes('good-workflow')) {
          return VALID_MD.replace('test-review.daily', 'discover.valid').replace('Test Review', 'Discover Valid')
        }
        return ''
      })

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn(() => false),
      } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)

      // The bad file triggers a console.warn (line 426 in workflow-loader.ts)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[workflow-loader] Failed to parse repo workflow'),
        expect.anything(),
      )

      // The good file is still registered
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)

      warnSpy.mockRestore()
    })
  })
})
