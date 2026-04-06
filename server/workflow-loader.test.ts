/** Tests for workflow-loader — verifies skill discovery, validation, and loading from disk; mocks child_process, fs, config, and better-sqlite3. */
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

const VALID_MD_WITH_MODEL = `---
kind: test-review.daily
name: Test Review
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review
model: claude-sonnet-4-6
---
You are performing an automated test review of the codebase.
`

function fakeEngine() {
  return {
    registerWorkflow: vi.fn(),
    hasWorkflow: vi.fn(() => false),
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
    waitForReady: vi.fn(() => Promise.resolve()),
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

    it('parses optional model field from frontmatter', () => {
      mockReaddirSync.mockReturnValue(['review.md'])
      mockReadFileSync.mockReturnValue(VALID_MD_WITH_MODEL)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('handles frontmatter lines without colon-space separator', () => {
      // Lines like "# comment" or blank lines should be skipped
      const mdWithComments = `---
kind: test-review.daily
name: Test Review
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review
some-malformed-line
---
Prompt text.
`
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(mdWithComments)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      // Should still parse successfully — malformed line is ignored
      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('handles CRLF line endings in frontmatter', () => {
      const crlfMd = '---\r\nkind: test-review.daily\r\nname: Test Review\r\nsessionPrefix: test-review\r\noutputDir: .codekin/reports/test\r\nfilenameSuffix: _test-review.md\r\ncommitMessage: chore: test review\r\n---\r\nPrompt text.\r\n'
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(crlfMd)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
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

      it('rejects paths outside REPOS_ROOT', async () => {
        mockRealpathSync.mockReturnValue('/etc/passwd')
        const handler = registeredDef.steps[0].handler
        await expect(handler(
          { repoPath: '/tmp/../../etc/passwd' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )).rejects.toThrow('outside REPOS_ROOT')
      })

      it('passes lastCommit through to result', async () => {
        mockRealpathSync.mockReturnValue('/tmp/repo')
        mockExecFileSync
          .mockReturnValueOnce(Buffer.from('develop\n'))
          .mockReturnValueOnce(Buffer.from('abc123 latest commit\n'))

        const handler = registeredDef.steps[0].handler
        const result = await handler(
          { repoPath: '/tmp/repo', repoName: 'test' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.lastCommit).toBe('abc123 latest commit')
        expect(result.branch).toBe('develop')
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
          model: undefined,
          provider: undefined,
          allowedTools: ['Bash(gh pr:*)'],
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

      it('passes model from input when provided', async () => {
        const handler = registeredDef.steps[1].handler
        await handler(
          { repoPath: '/tmp/repo', repoName: 'my-repo', model: 'claude-opus-4' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(sessions.create).toHaveBeenCalledWith(
          'test-review:my-repo',
          '/tmp/repo',
          expect.objectContaining({ model: 'claude-opus-4' })
        )
      })

      it('passes model from def when input model is absent', async () => {
        // Reload with model-bearing MD
        mockReaddirSync.mockReturnValue(['test.md'])
        mockReadFileSync.mockReturnValue(VALID_MD_WITH_MODEL)

        const eng = fakeEngine()
        const sess = fakeSessionManager()
        loadMdWorkflows(eng, sess)

        const defWithModel = eng.registerWorkflow.mock.calls[0][0]
        const handler = defWithModel.steps[1].handler
        await handler(
          { repoPath: '/tmp/repo', repoName: 'my-repo' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(sess.create).toHaveBeenCalledWith(
          'test-review:my-repo',
          '/tmp/repo',
          expect.objectContaining({ model: 'claude-sonnet-4-6' })
        )
      })

      it('passes undefined model when neither input nor def have it', async () => {
        const handler = registeredDef.steps[1].handler
        await handler(
          { repoPath: '/tmp/repo', repoName: 'my-repo' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(sessions.create).toHaveBeenCalledWith(
          'test-review:my-repo',
          '/tmp/repo',
          expect.objectContaining({ model: undefined })
        )
      })

      it('carries forward branch and lastCommit in output', async () => {
        const handler = registeredDef.steps[1].handler
        const result = await handler(
          { repoPath: '/tmp/repo', repoName: 'r', branch: 'feat/x', lastCommit: 'def456' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        expect(result.branch).toBe('feat/x')
        expect(result.lastCommit).toBe('def456')
      })

      it('uses "unknown" when repoPath has no segments', async () => {
        const handler = registeredDef.steps[1].handler
        await handler(
          { repoPath: '', repoName: '' },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        // Empty repoName falls through to path split; empty path gives ''
        // The || 'unknown' fallback should kick in for truly empty path
        expect(sessions.create).toHaveBeenCalled()
      })
    })

    describe('run_prompt step', () => {
      it('sends the default prompt when no repo override exists', async () => {
        vi.useFakeTimers()

        // No repo override file
        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        // Session immediately returns a result
        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'output', data: 'Review output text' },
            { type: 'result' },
          ],
        })

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        // Advance past the poll delay
        await vi.advanceTimersByTimeAsync(2000)

        const result = await promise

        expect(sessions.sendInput).toHaveBeenCalledWith(
          'session-1',
          'You are performing an automated test review of the codebase.'
        )
        expect(result.reportText).toBe('Review output text')
        expect(result.repoName).toBe('my-repo')

        vi.useRealTimers()
      })

      it('uses repo override prompt when available', async () => {
        vi.useFakeTimers()

        const overrideMd = `---
kind: test-review.daily
name: Test Review Override
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review
---
This is the repo-specific override prompt.
`

        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockImplementation((path: string) => {
          if (String(path).includes('.codekin/workflows/test-review.daily.md')) return overrideMd
          return VALID_MD
        })

        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'output', data: 'Override result' },
            { type: 'result' },
          ],
        })

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        await vi.advanceTimersByTimeAsync(2000)

        const result = await promise

        expect(sessions.sendInput).toHaveBeenCalledWith(
          'session-1',
          'This is the repo-specific override prompt.'
        )
        expect(result.reportText).toBe('Override result')
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('Using per-repo prompt override')
        )

        logSpy.mockRestore()
        vi.useRealTimers()
      })

      it('appends customPrompt to the base prompt', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'output', data: 'Custom result' },
            { type: 'result' },
          ],
        })

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          {
            sessionId: 'session-1',
            repoName: 'my-repo',
            repoPath: '/tmp/repo',
            branch: 'main',
            customPrompt: 'Focus on security issues.',
          },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        await vi.advanceTimersByTimeAsync(2000)

        await promise

        expect(sessions.sendInput).toHaveBeenCalledWith(
          'session-1',
          expect.stringContaining('Additional focus areas:\nFocus on security issues.')
        )

        vi.useRealTimers()
      })
    })

    describe('waitForSessionResult (via run_prompt)', () => {
      it('returns text from exit message when no result message', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'output', data: 'Partial output' },
            { type: 'exit', code: 0 },
          ],
        })

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        await vi.advanceTimersByTimeAsync(2000)

        const result = await promise

        expect(result.reportText).toBe('Partial output')

        vi.useRealTimers()
      })

      it('returns fallback text when exit has no output', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'exit', code: 1 },
          ],
        })

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        await vi.advanceTimersByTimeAsync(2000)

        const result = await promise

        expect(result.reportText).toBe('Claude exited without output')

        vi.useRealTimers()
      })

      it('throws on abort signal', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        // Session never produces output — just empty outputHistory forever
        sessions.get.mockReturnValue({ outputHistory: [] })

        const abortController = new AbortController()
        // Pre-abort so the signal is already aborted when the poll loop checks
        abortController.abort()

        const handler = registeredDef.steps[2].handler
        let caughtError: Error | null = null
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: abortController.signal }
        ).catch((err: Error) => { caughtError = err })

        // Advance past the poll delay
        await vi.advanceTimersByTimeAsync(2000)
        await promise

        expect(caughtError).toBeTruthy()
        expect(caughtError!.message).toContain('Aborted')

        vi.useRealTimers()
      })

      it('throws when session is not found during polling', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        // Session returns null immediately — session already gone
        sessions.get.mockReturnValue(null)

        const handler = registeredDef.steps[2].handler
        let caughtError: Error | null = null
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        ).catch((err: Error) => { caughtError = err })

        await vi.advanceTimersByTimeAsync(5000)
        await promise

        expect(caughtError).toBeTruthy()
        expect(caughtError!.message).toContain('not found')

        vi.useRealTimers()
      })

      it('concatenates multiple output messages', async () => {
        vi.useFakeTimers()

        mockExistsSync.mockImplementation((p: string) => {
          if (String(p).includes('.codekin/workflows')) return false
          return true
        })

        sessions.get.mockReturnValue({
          outputHistory: [
            { type: 'output', data: 'Part 1. ' },
            { type: 'output', data: 'Part 2.' },
            { type: 'result' },
          ],
        })

        const handler = registeredDef.steps[2].handler
        const promise = handler(
          { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
          { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
        )

        await vi.advanceTimersByTimeAsync(2000)

        const result = await promise
        expect(result.reportText).toBe('Part 1. Part 2.')

        vi.useRealTimers()
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

      it('skips cleanup when output has no sessionId', async () => {
        await registeredDef.afterRun({ output: {} })
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

      it('skips when claudeProcess is null', async () => {
        sessions.get.mockReturnValue({ claudeProcess: null })

        await registeredDef.afterRun({ output: { sessionId: 'session-1' } })
        expect(sessions.stopClaude).not.toHaveBeenCalled()
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

      it('creates the reports branch when it does not exist', async () => {
        const gitCalls: string[][] = []
        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          gitCalls.push(args)
          // rev-parse --abbrev-ref HEAD → main
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('main\n')
          // rev-parse --verify codekin/reports → fail (branch doesn't exist)
          if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found')
          // branch codekin/reports → success
          if (args[0] === 'branch') return Buffer.from('')
          return Buffer.from('')
        })

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

        // Should have called 'git branch codekin/reports'
        const branchCall = gitCalls.find(args => args[0] === 'branch' && args[1] === 'codekin/reports')
        expect(branchCall).toBeDefined()
      })

      it('uses git worktree instead of stash/checkout', async () => {
        const gitCalls: string[][] = []
        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          gitCalls.push(args)
          if (args[0] === 'rev-parse' && args[1] === '--verify') return Buffer.from('')
          return Buffer.from('')
        })

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

        // Should use worktree add, not stash/checkout
        const worktreeAddCall = gitCalls.find(args => args[0] === 'worktree' && args[1] === 'add')
        expect(worktreeAddCall).toBeDefined()
        const stashCall = gitCalls.find(args => args[0] === 'stash')
        expect(stashCall).toBeUndefined()
        const checkoutCall = gitCalls.find(args => args[0] === 'checkout')
        expect(checkoutCall).toBeUndefined()
      })

      it('cleans up worktree after commit', async () => {
        const gitCalls: string[][] = []
        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          gitCalls.push(args)
          if (args[0] === 'rev-parse' && args[1] === '--verify') return Buffer.from('')
          return Buffer.from('')
        })

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

        // Should clean up the worktree
        const worktreeRemoveCall = gitCalls.find(args => args[0] === 'worktree' && args[1] === 'remove')
        expect(worktreeRemoveCall).toBeDefined()
      })

      it('handles push failure gracefully and still cleans up worktree', async () => {
        const gitCalls: string[][] = []
        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          gitCalls.push(args)
          if (args[0] === 'rev-parse' && args[1] === '--verify') return Buffer.from('')
          if (args[0] === 'push') throw new Error('remote rejected')
          return Buffer.from('')
        })

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const handler = registeredDef.steps[3].handler
        const result = await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'Content',
            sessionId: 's1',
            branch: 'develop',
          },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        // Should still return valid result
        expect(result.filePath).toBeDefined()
        // Should still clean up worktree despite push failure
        const worktreeRemoveCall = gitCalls.find(args => args[0] === 'worktree' && args[1] === 'remove')
        expect(worktreeRemoveCall).toBeDefined()

        warnSpy.mockRestore()
      })

      it('includes run metadata in the report markdown', async () => {
        mockExecFileSync.mockReturnValue(Buffer.from('main\n'))

        const handler = registeredDef.steps[3].handler
        await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'The actual analysis.',
            sessionId: 'session-42',
            branch: 'main',
          },
          { runId: 'run-abc', run: {}, abortSignal: new AbortController().signal }
        )

        // Check the markdown content written
        const writtenContent = mockWriteFileSync.mock.calls[0][1] as string
        expect(writtenContent).toContain('# Test Review: my-repo')
        expect(writtenContent).toContain('**Repository**: /tmp/repo')
        expect(writtenContent).toContain('**Branch**: main')
        expect(writtenContent).toContain('**Workflow Run**: run-abc')
        expect(writtenContent).toContain('**Session**: session-42')
        expect(writtenContent).toContain('The actual analysis.')
      })

      it('uses "unknown" for branch when not provided', async () => {
        mockExecFileSync.mockReturnValue(Buffer.from('main\n'))

        const handler = registeredDef.steps[3].handler
        await handler(
          {
            repoPath: '/tmp/repo',
            repoName: 'my-repo',
            reportText: 'Content',
            sessionId: 's1',
            branch: undefined,
          },
          { runId: 'r1', run: {}, abortSignal: new AbortController().signal }
        )

        const writtenContent = mockWriteFileSync.mock.calls[0][1] as string
        expect(writtenContent).toContain('**Branch**: unknown')
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

    it('returns both builtin and repo kinds together', () => {
      const repoPath = '/tmp/my-app'
      const repoDir = join(repoPath, '.codekin', 'workflows')
      const repoMd = VALID_MD.replace('test-review.daily', 'repo-only.kind').replace('Test Review', 'Repo Only')

      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p) === repoDir) return ['repo-only.kind.md']
        return ['builtin.md']
      })
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('repo-only')) return repoMd
        return VALID_MD
      })

      const kinds = listAvailableKinds(repoPath)
      expect(kinds).toHaveLength(2)
      expect(kinds.find(k => k.source === 'builtin')).toBeDefined()
      expect(kinds.find(k => k.source === 'repo')).toBeDefined()
    })

    it('returns empty when called without repoPath and no builtins', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue([])

      const kinds = listAvailableKinds()
      expect(kinds).toEqual([])
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

    it('registers same kind from different repos independently', () => {
      const repoPath1 = '/tmp/repo-a-unique'
      const repoPath2 = '/tmp/repo-b-unique'
      const repoDir1 = join(repoPath1, '.codekin', 'workflows')
      const repoDir2 = join(repoPath2, '.codekin', 'workflows')
      const repoMd = VALID_MD.replace('test-review.daily', 'shared.kind').replace('Test Review', 'Shared')

      mockExistsSync.mockImplementation((p: string) =>
        String(p) === repoDir1 || String(p) === repoDir2
      )
      mockReaddirSync.mockImplementation((p: string) => {
        if (String(p) === repoDir1 || String(p) === repoDir2) return ['shared.kind.md']
        return []
      })
      mockReadFileSync.mockReturnValue(repoMd)

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn()
          .mockReturnValueOnce(false) // first repo — not registered yet
          .mockReturnValueOnce(true), // second repo — engine already has it
      } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath1)
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath2)
      // Second repo is skipped because engine.hasWorkflow returns true
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)
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
      expect(prefixes).toHaveLength(2)
      expect(prefixes).toContain('chore: test review')
      expect(prefixes).toContain('chore: coverage')
    })

    it('returns empty array when no workflows directory exists', () => {
      mockExistsSync.mockReturnValue(false)

      const prefixes = getWorkflowCommitPrefixes()
      expect(prefixes).toEqual([])
    })

    it('returns one prefix per workflow', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['single.md'])
      mockReadFileSync.mockReturnValue(VALID_MD)

      const prefixes = getWorkflowCommitPrefixes()
      expect(prefixes).toHaveLength(1)
      expect(prefixes[0]).toBe('chore: test review')
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

    it('skips non-md files in repo workflows dir', () => {
      const repoPath = '/tmp/nonmd-repo-test'
      const repoDir = join(repoPath, '.codekin', 'workflows')

      mockExistsSync.mockImplementation((p: string) => String(p) === repoDir)
      mockReaddirSync.mockImplementation((p: string) =>
        String(p) === repoDir ? ['notes.txt', 'config.json', 'actual.md'] : [],
      )
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('actual.md')) {
          return VALID_MD.replace('test-review.daily', 'nonmd.filter').replace('Test Review', 'Filter Test')
        }
        return ''
      })

      const mockEngine = {
        registerWorkflow: vi.fn(),
        hasWorkflow: vi.fn(() => false),
      } as any

      ensureRepoWorkflowsRegistered(mockEngine, {} as any, repoPath)

      // Only the .md file should trigger registration
      expect(mockEngine.registerWorkflow).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // parseMdWorkflow edge cases (tested via loadMdWorkflows)
  // -------------------------------------------------------------------------

  describe('parseMdWorkflow edge cases (via loadMdWorkflows)', () => {
    it('handles frontmatter with values containing colons', () => {
      const mdWithColons = `---
kind: test-review.daily
name: Review: Daily Code Check
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review: daily
---
Prompt text.
`
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(mdWithColons)

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('trims whitespace from prompt body', () => {
      const mdWithWhitespace = `---
kind: test-review.daily
name: Test Review
sessionPrefix: test-review
outputDir: .codekin/reports/test
filenameSuffix: _test-review.md
commitMessage: chore: test review
---

  Prompt with leading/trailing whitespace.

`
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(mdWithWhitespace)

      const engine = fakeEngine()
      const sessions = fakeSessionManager()
      loadMdWorkflows(engine, sessions)

      expect(engine.registerWorkflow).toHaveBeenCalledTimes(1)
    })

    it('rejects empty frontmatter (all required fields missing)', () => {
      const emptyFm = `---
---
Prompt text.
`
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(emptyFm)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('rejects content with no closing frontmatter delimiter', () => {
      const noClosing = `---
kind: test-review.daily
name: Test Review
This just keeps going without a closing ---
`
      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(noClosing)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const engine = fakeEngine()
      loadMdWorkflows(engine, fakeSessionManager())

      expect(engine.registerWorkflow).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // loadRepoOverride edge cases (tested via run_prompt step)
  // -------------------------------------------------------------------------

  describe('loadRepoOverride parse failure (via run_prompt step)', () => {
    it('falls back to default prompt when repo override has invalid frontmatter', async () => {
      vi.useFakeTimers()

      mockReaddirSync.mockReturnValue(['test.md'])
      mockReadFileSync.mockReturnValue(VALID_MD)
      const engine = fakeEngine()
      const sessions = fakeSessionManager()
      loadMdWorkflows(engine, sessions)
      const registeredDef = engine.registerWorkflow.mock.calls[0][0]

      // Override file exists but has bad content
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation((path: string) => {
        if (String(path).includes('.codekin/workflows/test-review.daily.md')) {
          return 'invalid content - no frontmatter'
        }
        return VALID_MD
      })

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      sessions.get.mockReturnValue({
        outputHistory: [
          { type: 'output', data: 'Fallback output' },
          { type: 'result' },
        ],
      })

      const handler = registeredDef.steps[2].handler
      const promise = handler(
        { sessionId: 'session-1', repoName: 'my-repo', repoPath: '/tmp/repo', branch: 'main' },
        { runId: 'r1', run: { kind: 'test-review.daily' }, abortSignal: new AbortController().signal }
      )

      await vi.advanceTimersByTimeAsync(2000)

      const result = await promise

      // Should have used the default prompt since override failed
      expect(sessions.sendInput).toHaveBeenCalledWith(
        'session-1',
        'You are performing an automated test review of the codebase.'
      )
      expect(result.reportText).toBe('Fallback output')

      warnSpy.mockRestore()
      vi.useRealTimers()
    })
  })
})
