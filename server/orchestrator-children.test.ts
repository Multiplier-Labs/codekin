/** Tests for OrchestratorChildManager — verifies spawn, status tracking,
 * listing, timeout, and prompt generation. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
  PORT: 32352,
  DATA_DIR: '/tmp/codekin-test',
}))

import { OrchestratorChildManager, type ChildSessionRequest } from './orchestrator-children.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ChildSessionRequest> = {}): ChildSessionRequest {
  return {
    repo: '/repos/myproject',
    task: 'Fix the login bug',
    branchName: 'fix/login-bug',
    completionPolicy: 'pr',
    deployAfter: false,
    useWorktree: true,
    ...overrides,
  }
}

function makeMockSessions(worktreeSucceeds = true) {
  const sentInputs: string[] = []
  const resultListeners: Array<(sessionId: string, isError: boolean) => void> = []
  const exitListeners: Array<(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void> = []

  return {
    create: vi.fn(),
    createWorktree: vi.fn(async () => worktreeSucceeds ? '/repos/myproject-wt-child123' : null),
    startClaude: vi.fn(),
    sendInput: vi.fn((_: string, prompt: string) => { sentInputs.push(prompt) }),
    get: vi.fn(() => ({
      claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
      outputHistory: [],
      pendingToolApprovals: new Map(),
      pendingControlRequests: new Map(),
    })),
    onSessionResult: vi.fn((cb: any) => {
      resultListeners.push(cb)
      return () => { const idx = resultListeners.indexOf(cb); if (idx >= 0) resultListeners.splice(idx, 1) }
    }),
    onSessionExit: vi.fn((cb: any) => {
      exitListeners.push(cb)
      return () => { const idx = exitListeners.indexOf(cb); if (idx >= 0) exitListeners.splice(idx, 1) }
    }),
    clearProcessingFlag: vi.fn(),
    _sentInputs: sentInputs,
    _resultListeners: resultListeners,
    _exitListeners: exitListeners,
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorChildManager', () => {
  let sessions: ReturnType<typeof makeMockSessions>
  let manager: OrchestratorChildManager

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // spawn
  // -------------------------------------------------------------------------

  describe('spawn', () => {
    beforeEach(() => {
      sessions = makeMockSessions()
      manager = new OrchestratorChildManager(sessions)
    })

    it('creates a child that transitions from starting to running', async () => {
      const child = await manager.spawn(makeRequest())

      expect(child.status).toBe('running')
      expect(child.request.task).toBe('Fix the login bug')
      expect(child.startedAt).toBeTruthy()
      expect(child.completedAt).toBeNull()
      expect(child.result).toBeNull()
    })

    it('calls sessions.create with correct args', async () => {
      const child = await manager.spawn(makeRequest())

      expect(sessions.create).toHaveBeenCalledWith(
        'testagent:fix/login-bug',
        '/repos/myproject',
        expect.objectContaining({
          source: 'agent',
          id: child.id,
          groupDir: '/repos/myproject',
          permissionMode: 'acceptEdits',
        }),
      )
      expect(sessions.startClaude).toHaveBeenCalledWith(child.id)
      expect(sessions.sendInput).toHaveBeenCalledWith(child.id, expect.stringContaining('Fix the login bug'))
    })

    it('creates a worktree when requested', async () => {
      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(sessions.createWorktree).toHaveBeenCalledWith(child.id, '/repos/myproject', 'fix/login-bug')
      expect(child.status).toBe('running')
    })

    it('falls back gracefully when worktree creation fails', async () => {
      sessions = makeMockSessions(false)
      manager = new OrchestratorChildManager(sessions)

      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(child.status).toBe('running')
      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Worktree Not Available')
    })

    it('records failed status when session creation throws', async () => {
      sessions.create = vi.fn(() => { throw new Error('create failed') })

      const child = await manager.spawn(makeRequest())

      expect(child.status).toBe('failed')
      expect(child.error).toBe('create failed')
      expect(child.completedAt).toBeTruthy()
    })

    it('throws when at max concurrent sessions (5)', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.spawn(makeRequest({ branchName: `fix/bug-${i}` }))
      }

      await expect(manager.spawn(makeRequest({ branchName: 'fix/one-too-many' }))).rejects.toThrow(/concurrent sessions/)
    })
  })

  // -------------------------------------------------------------------------
  // Status tracking via monitorChild hooks
  // -------------------------------------------------------------------------

  describe('status tracking', () => {
    beforeEach(() => {
      sessions = makeMockSessions()
      manager = new OrchestratorChildManager(sessions)
    })

    it('marks child as completed when result event fires', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #42 with all changes.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(child.result).toContain('Created PR #42')
    })

    it('marks child as failed on error result', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Error: something broke badly' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._resultListeners) {
        listener(child.id, true)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('failed')
      })
      expect(child.error).toBe('Claude returned an error')
    })

    it('marks child as completed on exit with sufficient output', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: null,
        outputHistory: [{ type: 'output', data: 'A'.repeat(200) }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._exitListeners) {
        listener(child.id, 0, null, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
    })

    it('marks child as failed on exit without sufficient output', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: null,
        outputHistory: [{ type: 'output', data: 'short' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._exitListeners) {
        listener(child.id, 1, null, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('failed')
      })
      expect(child.error).toContain('without sufficient output')
    })

    it('keeps monitoring when exit has willRestart=true', async () => {
      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._exitListeners) {
        listener(child.id, 1, 'SIGTERM', true)
      }

      expect(child.status).toBe('running')
    })

    it('marks child as failed when session is deleted', async () => {
      sessions.get = vi.fn(() => null)

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('failed')
      })
      expect(child.error).toBe('Session was deleted')
    })
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      sessions = makeMockSessions()
      manager = new OrchestratorChildManager(sessions)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('times out after specified duration', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ timeoutMs: 5000 }))

      vi.advanceTimersByTime(5000)

      await vi.waitFor(() => {
        expect(child.status).toBe('timed_out')
      })
      expect(child.error).toContain('Timed out')
      expect(child.completedAt).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // Listing and retrieval
  // -------------------------------------------------------------------------

  describe('list and get', () => {
    beforeEach(() => {
      sessions = makeMockSessions()
      manager = new OrchestratorChildManager(sessions)
    })

    it('lists children and retrieves by ID', async () => {
      const child1 = await manager.spawn(makeRequest({ branchName: 'fix/a' }))
      const child2 = await manager.spawn(makeRequest({ branchName: 'fix/b' }))

      const list = manager.list()
      expect(list.length).toBe(2)
      // Both children should be present
      const ids = list.map(c => c.id)
      expect(ids).toContain(child1.id)
      expect(ids).toContain(child2.id)
    })

    it('retrieves a child by ID', async () => {
      const child = await manager.spawn(makeRequest())

      expect(manager.get(child.id)).toBe(child)
      expect(manager.get('nonexistent')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Prompt generation (existing tests migrated + expanded)
  // -------------------------------------------------------------------------

  describe('prompt generation', () => {
    beforeEach(() => {
      sessions = makeMockSessions()
      manager = new OrchestratorChildManager(sessions)
    })

    it('includes worktree environment section when worktree succeeds', async () => {
      await manager.spawn(makeRequest({ useWorktree: true }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Worktree Environment')
      expect(prompt).toContain('isolated git worktree')
      expect(prompt).toContain('fix/login-bug')
      expect(prompt).toContain('Do NOT use the `EnterWorktree`')
    })

    it('does NOT include worktree section when worktree not requested', async () => {
      await manager.spawn(makeRequest({ useWorktree: false }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).not.toContain('Worktree Environment')
      expect(prompt).not.toContain('EnterWorktree')
    })

    it('omits create-branch step in PR completion when in worktree', async () => {
      await manager.spawn(makeRequest({ useWorktree: true, completionPolicy: 'pr' }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).not.toContain('Create and switch to branch')
      expect(prompt).toContain('Push the branch')
      expect(prompt).toContain('Pull Request')
    })

    it('includes create-branch step when NOT in worktree', async () => {
      sessions = makeMockSessions(false)
      manager = new OrchestratorChildManager(sessions)
      await manager.spawn(makeRequest({ useWorktree: true, completionPolicy: 'pr' }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Create and switch to branch')
    })

    it('generates merge completion instructions', async () => {
      await manager.spawn(makeRequest({ completionPolicy: 'merge', useWorktree: false }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Push directly to the current branch')
    })

    it('generates commit-only completion instructions', async () => {
      await manager.spawn(makeRequest({ completionPolicy: 'commit-only', useWorktree: false }))

      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Do NOT push')
    })
  })
})
