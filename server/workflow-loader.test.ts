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
  }
})

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

import { loadMdWorkflows } from './workflow-loader.js'

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
          if (String(p) === '/nonexistent') return false
          return true
        })

        const handler = registeredDef.steps[0].handler
        await expect(handler({ repoPath: '/nonexistent' }, { runId: 'r1', run: {}, abortSignal: new AbortController().signal }))
          .rejects.toThrow('does not exist')
      })

      it('validates a valid git repo', async () => {
        mockExecSync.mockReturnValue(Buffer.from('main\n'))

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
        mockExecSync.mockReturnValue(Buffer.from('main\n'))
        mockExecFileSync.mockReturnValue(Buffer.from(''))

        const handler = registeredDef.steps[0].handler
        await expect(handler(
          { repoPath: '/tmp/repo', sinceTimestamp: '2026-03-07T00:00:00Z' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )).rejects.toThrow('No code changes')
      })

      it('continues when there are code changes since last run', async () => {
        mockExecSync.mockReturnValue(Buffer.from('main\n'))
        mockExecFileSync.mockReturnValue(Buffer.from('abc123 some commit\n'))

        const handler = registeredDef.steps[0].handler
        const result = await handler(
          { repoPath: '/tmp/repo', sinceTimestamp: '2026-03-07T00:00:00Z' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.branch).toBe('main')
      })

      it('throws for non-git directory', async () => {
        mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })

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
  })
})
