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
  const promptListeners: Array<(sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void> = []

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
      worktreePath: '/repos/myproject-wt-child123',
    })),
    onSessionResult: vi.fn((cb: any) => {
      resultListeners.push(cb)
      return () => { const idx = resultListeners.indexOf(cb); if (idx >= 0) resultListeners.splice(idx, 1) }
    }),
    onSessionExit: vi.fn((cb: any) => {
      exitListeners.push(cb)
      return () => { const idx = exitListeners.indexOf(cb); if (idx >= 0) exitListeners.splice(idx, 1) }
    }),
    onSessionPrompt: vi.fn((cb: any) => {
      promptListeners.push(cb)
      return () => { const idx = promptListeners.indexOf(cb); if (idx >= 0) promptListeners.splice(idx, 1) }
    }),
    clearProcessingFlag: vi.fn(),
    _sentInputs: sentInputs,
    _resultListeners: resultListeners,
    _exitListeners: exitListeners,
    _promptListeners: promptListeners,
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

  // -------------------------------------------------------------------------
  // Parent-session terminal notifications
  // -------------------------------------------------------------------------

  describe('parent terminal notifications', () => {
    let notify: ReturnType<typeof vi.fn>

    beforeEach(() => {
      sessions = makeMockSessions()
      notify = vi.fn(() => true)
      manager = new OrchestratorChildManager(sessions, { notify })
    })

    it('fires exactly one notification when a child times out', async () => {
      vi.useFakeTimers()
      try {
        sessions.get = vi.fn(() => ({
          claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
          outputHistory: [],
          pendingToolApprovals: new Map(),
          pendingControlRequests: new Map(),
          worktreePath: '/repos/myproject-wt-abc12345',
        }))

        const child = await manager.spawn(makeRequest({
          parentSessionId: 'parent-orchestrator-id',
          timeoutMs: 5000,
        }))

        vi.advanceTimersByTime(5000)

        await vi.waitFor(() => {
          expect(child.status).toBe('timed_out')
        })

        expect(notify).toHaveBeenCalledTimes(1)
        const args = notify.mock.calls[0][0]
        expect(args.parentSessionId).toBe('parent-orchestrator-id')
        expect(args.label).toBe('Child Session Stopped')
        expect(args.title).toContain(child.id)
        expect(args.body).toContain('Status: timed_out')
        expect(args.body).toContain(`Branch: ${child.request.branchName}`)
        expect(args.body).toContain(`Repo: ${child.request.repo}`)
        expect(args.body).toContain('Inspect worktree at /repos/myproject-wt-abc12345')
        expect(child.terminalNotifiedAt).toBeTruthy()
      } finally {
        vi.useRealTimers()
      }
    })

    it('fires a notification when a child completes', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-abc12345',
      }))

      const child = await manager.spawn(makeRequest({
        parentSessionId: 'parent-orchestrator-id',
      }))

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })

      expect(notify).toHaveBeenCalledTimes(1)
      const args = notify.mock.calls[0][0]
      expect(args.parentSessionId).toBe('parent-orchestrator-id')
      expect(args.label).toBe('Child Session Stopped')
      expect(args.body).toContain('Status: completed')
      expect(args.body).toContain(`Branch: ${child.request.branchName}`)
      expect(args.body).toContain(`Repo: ${child.request.repo}`)
      // Hint for completed PR-policy children references PR follow-through.
      expect(args.body).toMatch(/PR/)
    })

    it('does NOT fire a notification when the child has no parentSessionId', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 with all changes.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-abc12345',
      }))

      const child = await manager.spawn(makeRequest()) // no parentSessionId

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })

      expect(notify).not.toHaveBeenCalled()
      expect(child.terminalNotifiedAt).toBeNull()
    })

    it('is idempotent — repeated terminal triggers fire the notification once', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-abc12345',
      }))

      const child = await manager.spawn(makeRequest({
        parentSessionId: 'parent-orchestrator-id',
      }))

      // First terminal trigger: result event marks the child completed.
      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(notify).toHaveBeenCalledTimes(1)

      // Re-invoke the private notifier directly (simulates a second
      // terminal-state callback firing after restart-resume / hook re-fire).
      // Cast to any so we can reach into the manager's internal helper.
      const stamp = child.terminalNotifiedAt
      ;(manager as any).notifyTerminal(child)
      expect(notify).toHaveBeenCalledTimes(1)
      // The stamp must not be reset by the second call.
      expect(child.terminalNotifiedAt).toBe(stamp)
    })

    it('does NOT stamp terminalNotifiedAt when delivery fails (returns false)', async () => {
      // Notify reports the parent is unreachable on the first attempt.
      notify = vi.fn(() => false)
      manager = new OrchestratorChildManager(sessions, { notify })

      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-abc12345',
      }))

      const child = await manager.spawn(makeRequest({
        parentSessionId: 'parent-orchestrator-id',
      }))

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })

      expect(notify).toHaveBeenCalledTimes(1)
      // Failed delivery must leave the stamp null so a future invocation can retry.
      expect(child.terminalNotifiedAt).toBeNull()

      // Second invocation succeeds — stamp is set, future calls become no-ops.
      notify.mockReturnValue(true)
      ;(manager as any).notifyTerminal(child)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(child.terminalNotifiedAt).toBeTruthy()

      ;(manager as any).notifyTerminal(child)
      expect(notify).toHaveBeenCalledTimes(2)
    })

    it('marks child as blocked when a result arrives with pending approvals', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'About to push...' }],
        pendingToolApprovals: new Map([['req-1', { requestId: 'req-1', toolName: 'Bash', toolInput: { command: 'git push --force' } }]]),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      expect(child.status).toBe('blocked')
      expect(child.completedAt).toBeNull()
    })

    it('does NOT stamp terminalNotifiedAt when notify throws', async () => {
      notify = vi.fn(() => { throw new Error('boom') })
      manager = new OrchestratorChildManager(sessions, { notify })

      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-abc12345',
      }))

      const child = await manager.spawn(makeRequest({
        parentSessionId: 'parent-orchestrator-id',
      }))

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })

      expect(notify).toHaveBeenCalledTimes(1)
      expect(child.terminalNotifiedAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Blocked-prompt notifications (realtime push to parent)
  // -------------------------------------------------------------------------

  describe('blocked-prompt notifications', () => {
    let notify: ReturnType<typeof vi.fn>

    function firePrompt(sessionId: string, promptType: 'permission' | 'question', toolName?: string, requestId?: string) {
      for (const listener of sessions._promptListeners) {
        listener(sessionId, promptType, toolName, requestId)
      }
    }

    beforeEach(() => {
      sessions = makeMockSessions()
      notify = vi.fn(() => true)
      manager = new OrchestratorChildManager(sessions, { notify })
    })

    it('subscribes to session prompt events on construction', () => {
      expect(sessions.onSessionPrompt).toHaveBeenCalledTimes(1)
    })

    it('marks the child blocked and notifies the parent with respond instructions', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: new Map([['req-42', { requestId: 'req-42', toolName: 'Bash', toolInput: { command: 'mkdir -p src/new' } }]]),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      firePrompt(child.id, 'permission', 'Bash', 'req-42')

      expect(child.status).toBe('blocked')
      expect(notify).toHaveBeenCalledTimes(1)
      const args = notify.mock.calls[0][0]
      expect(args.parentSessionId).toBe('parent-orchestrator-id')
      expect(args.label).toBe('Child Session Blocked')
      expect(args.title).toContain(child.id)
      expect(args.body).toContain('RequestId: req-42')
      expect(args.body).toContain(`/api/orchestrator/sessions/${child.id}/respond`)
      expect(args.body).toContain('$ mkdir -p src/new')
      expect(args.body).toContain('"value": "allow"')
    })

    it('suggests an answer payload for question prompts', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      firePrompt(child.id, 'question', 'AskUserQuestion', 'req-q1')

      const args = notify.mock.calls[0][0]
      expect(args.body).toContain('"value": "YOUR_ANSWER"')
    })

    it('notifies only once per requestId', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      firePrompt(child.id, 'permission', 'Bash', 'req-42')
      firePrompt(child.id, 'permission', 'Bash', 'req-42')

      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('notifies again for a different requestId', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      firePrompt(child.id, 'permission', 'Bash', 'req-1')
      firePrompt(child.id, 'permission', 'Bash', 'req-2')

      expect(notify).toHaveBeenCalledTimes(2)
    })

    it('ignores prompts from sessions that are not our children', async () => {
      await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))

      firePrompt('some-other-session', 'permission', 'Bash', 'req-9')

      expect(notify).not.toHaveBeenCalled()
    })

    it('ignores prompts for terminal children', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))
      for (const listener of sessions._resultListeners) listener(child.id, false)
      await vi.waitFor(() => expect(child.status).toBe('completed'))
      notify.mockClear()

      firePrompt(child.id, 'permission', 'Bash', 'req-late')

      expect(child.status).toBe('completed')
      expect(notify).not.toHaveBeenCalled()
    })

    it('marks the child blocked but skips notify when there is no parent', async () => {
      const child = await manager.spawn(makeRequest()) // no parentSessionId

      firePrompt(child.id, 'permission', 'Bash', 'req-42')

      expect(child.status).toBe('blocked')
      expect(notify).not.toHaveBeenCalled()
    })

    it('still completes normally after being blocked', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))
      firePrompt(child.id, 'permission', 'Bash', 'req-42')
      expect(child.status).toBe('blocked')

      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Done! Created PR #99 and pushed it.' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))
      for (const listener of sessions._resultListeners) listener(child.id, false)

      await vi.waitFor(() => expect(child.status).toBe('completed'))
    })

    it('counts blocked children as active', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-orchestrator-id' }))
      firePrompt(child.id, 'permission', 'Bash', 'req-42')

      expect(child.status).toBe('blocked')
      expect(manager.activeCount()).toBe(1)
    })
  })
})
