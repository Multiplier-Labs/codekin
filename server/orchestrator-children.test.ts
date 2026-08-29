/** Tests for OrchestratorChildManager — verifies spawn, status tracking,
 * listing, timeout, and prompt generation. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
  PORT: 32352,
  DATA_DIR: '/tmp/codekin-test',
}))

// Tests inject their own notify fn; mock the outbox module so importing it
// does not drag in orchestrator-manager (reads config constants at load time).
vi.mock('./orchestrator-outbox.js', () => ({
  getOrchestratorOutbox: () => ({ enqueue: () => {} }),
}))

import { OrchestratorChildManager, AGENT_CHILD_ALLOWED_TOOLS, type ChildSessionRequest } from './orchestrator-children.js'
import { RunStore } from './run-store.js'

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

/**
 * Build a manager with a stubbed exec so ground-truth checks (gh / git)
 * never spawn real processes. The default stub reports the final step as
 * done ('[{"number": 1}]' parses as a non-empty PR list, and is non-empty
 * output for git ls-remote). Override `exec` to simulate a missing step.
 */
function makeManager(
  sessions: any,
  opts: { notify?: any; exec?: any } = {},
): OrchestratorChildManager {
  return new OrchestratorChildManager(sessions, {
    exec: opts.exec ?? vi.fn(async () => '[{"number": 1}]'),
    ...(opts.notify ? { notify: opts.notify } : {}),
  })
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
      manager = makeManager(sessions)
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
      manager = makeManager(sessions)

      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(child.status).toBe('running')
      const prompt = sessions._sentInputs[0]
      expect(prompt).toContain('Worktree Not Available')
    })

    it('reports worktree status "active" with the worktree path on success', async () => {
      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(child.worktree).toBe('active')
      expect(child.worktreePath).toBe('/repos/myproject-wt-child123')
    })

    it('reports worktree status "failed" when worktree creation fails', async () => {
      sessions = makeMockSessions(false)
      manager = makeManager(sessions)

      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(child.worktree).toBe('failed')
      expect(child.worktreePath).toBeNull()
    })

    it('reports worktree status "none" when no worktree was requested', async () => {
      const child = await manager.spawn(makeRequest({ useWorktree: false }))

      expect(child.worktree).toBe('none')
      expect(child.worktreePath).toBeNull()
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
      manager = makeManager(sessions)
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

    it('marks child as completed on exit when ground truth confirms the final step', async () => {
      // Default makeManager exec stub reports an existing PR for the branch.
      sessions.get = vi.fn(() => ({
        claudeProcess: null,
        outputHistory: [{ type: 'output', data: 'brief' }],
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

    it('marks child as failed on exit when the final step never landed', async () => {
      manager = makeManager(sessions, { exec: vi.fn(async () => '[]') })
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
      expect(child.error).toContain('before the final step')
    })

    it('marks commit-only child as failed on exit with no output at all', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: null,
        outputHistory: [],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'commit-only' }))

      for (const listener of sessions._exitListeners) {
        listener(child.id, 1, null, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('failed')
      })
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
  // Ground-truth final-step verification
  // -------------------------------------------------------------------------

  describe('ground-truth final-step verification', () => {
    const aliveSession = (output: string) => ({
      claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
      outputHistory: output ? [{ type: 'output', data: output }] : [],
      pendingToolApprovals: new Map(),
      pendingControlRequests: new Map(),
    })

    beforeEach(() => {
      sessions = makeMockSessions()
    })

    it('checks gh pr list (in the worktree) for pr policy', async () => {
      const exec = vi.fn(async () => '[{"number": 7}]')
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('done'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(exec).toHaveBeenCalledWith(
        'gh',
        ['pr', 'list', '--head', 'fix/login-bug', '--state', 'all', '--json', 'number', '--limit', '1'],
        '/repos/myproject-wt-child123',
      )
      expect(child.error).toBeNull()
    })

    it('nudges once when no PR exists, then completes with an unverified note', async () => {
      const exec = vi.fn(async () => '[]')
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('made the changes and committed'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))

      // First result: PR missing → nudge, keep monitoring
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('no Pull Request exists'))).toBe(true)
      })
      expect(child.status).toBe('running')

      // Second result: still no PR → no second nudge, terminal with note
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(child.error).toContain('Completion not verified')
      const nudges = sessions._sentInputs.filter((p: string) => p.includes('no Pull Request exists'))
      expect(nudges.length).toBe(1)
    })

    it('checks git ls-remote for merge policy and nudges when the branch is not on the remote', async () => {
      const exec = vi.fn(async () => '')
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('committed everything'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'merge' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('has not been pushed'))).toBe(true)
      })
      expect(exec).toHaveBeenCalledWith(
        'git',
        ['ls-remote', '--heads', 'origin', 'fix/login-bug'],
        '/repos/myproject-wt-child123',
      )
    })

    it('treats a non-empty ls-remote as pushed for merge policy', async () => {
      const exec = vi.fn(async () => 'abc123\trefs/heads/fix/login-bug\n')
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('pushed'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'merge' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(child.error).toBeNull()
    })

    it('falls back to transcript sniffing when the ground-truth command fails', async () => {
      const exec = vi.fn(async () => { throw new Error('gh: command not found') })
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('Opened a pull request with the changes.'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(child.error).toBeNull()
    })

    it('never verifies remotely for commit-only policy', async () => {
      const exec = vi.fn(async () => '[]')
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('committed locally'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'commit-only' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(exec).not.toHaveBeenCalled()
      expect(child.error).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Default allowlist
  // -------------------------------------------------------------------------

  describe('AGENT_CHILD_ALLOWED_TOOLS', () => {
    it('includes the broadened dev toolset', () => {
      for (const tool of [
        'Bash(python3:*)', 'Bash(pytest:*)',
        'Bash(sed:*)', 'Bash(rg:*)', 'Bash(jq:*)',
        'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(touch:*)',
      ]) {
        expect(AGENT_CHILD_ALLOWED_TOOLS).toContain(tool)
      }
    })

    it('still excludes destructive commands', () => {
      for (const tool of ['Bash(rm:*)', 'Bash(sudo:*)', 'Bash(docker:*)', 'Bash:*', 'Bash']) {
        expect(AGENT_CHILD_ALLOWED_TOOLS).not.toContain(tool)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      sessions = makeMockSessions()
      manager = makeManager(sessions)
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

    it('pauses the working clock while the child is blocked on a prompt', async () => {
      const pendingApprovals = new Map([['req-1', { toolInput: { command: 'git push' } }]])
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: pendingApprovals,
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ timeoutMs: 60_000, parentSessionId: 'parent-1' }))

      // Burn half the working budget, then block on a prompt
      vi.advanceTimersByTime(30_000)
      for (const cb of sessions._promptListeners) cb(child.id, 'permission', 'Bash', 'req-1')
      expect(child.status).toBe('blocked')

      // Way past the original working deadline while blocked — must NOT time out
      vi.advanceTimersByTime(10 * 60_000)
      expect(child.status).toBe('blocked')

      // Prompt answered: a result arrives with no pendings → clock resumes
      pendingApprovals.clear()
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'pushed and created a pull request '.repeat(10) }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
    })

    it('times out a child that stays blocked past the blocked-time budget', async () => {
      const pendingApprovals = new Map([['req-1', { toolInput: { command: 'git push' } }]])
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: pendingApprovals,
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ timeoutMs: 60_000, parentSessionId: 'parent-1' }))

      for (const cb of sessions._promptListeners) cb(child.id, 'permission', 'Bash', 'req-1')
      expect(child.status).toBe('blocked')

      // Exceed the 30-minute blocked budget
      vi.advanceTimersByTime(31 * 60_000)

      await vi.waitFor(() => {
        expect(child.status).toBe('timed_out')
      })
      expect(child.error).toContain('pending approval')
    })

    it('resumes the working clock after unblock with the remaining budget', async () => {
      // Ground truth reports no PR → after unblock, the child gets nudged and
      // monitoring continues on the resumed clock (~30s of budget left).
      manager = makeManager(sessions, { exec: vi.fn(async () => '[]') })
      const pendingApprovals = new Map([['req-1', { toolInput: { command: 'git push' } }]])
      const makeSession = (pending: Map<string, unknown>) => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: pending,
        pendingControlRequests: new Map(),
      })
      sessions.get = vi.fn(() => makeSession(pendingApprovals))

      const child = await manager.spawn(makeRequest({ timeoutMs: 60_000, parentSessionId: 'parent-1' }))

      // Use 30s of the budget, block, then unblock via a result event
      vi.advanceTimersByTime(30_000)
      for (const cb of sessions._promptListeners) cb(child.id, 'permission', 'Bash', 'req-1')
      vi.advanceTimersByTime(5 * 60_000)

      pendingApprovals.clear()
      sessions.get = vi.fn(() => makeSession(new Map()))
      for (const cb of sessions._resultListeners) cb(child.id, false)
      // Let the async ground-truth check + nudge settle, then burn the
      // remaining ~30s of working budget.
      await vi.advanceTimersByTimeAsync(0)
      expect(sessions._sentInputs.some((p: string) => p.includes('no Pull Request exists'))).toBe(true)
      vi.advanceTimersByTime(31_000)

      await vi.waitFor(() => {
        expect(child.status).toBe('timed_out')
      })
      expect(child.error).toContain('working time')
    })
  })

  // -------------------------------------------------------------------------
  // Listing and retrieval
  // -------------------------------------------------------------------------

  describe('list and get', () => {
    beforeEach(() => {
      sessions = makeMockSessions()
      manager = makeManager(sessions)
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
      manager = makeManager(sessions)
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
      manager = makeManager(sessions)
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
      manager = makeManager(sessions, { notify })
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
      manager = makeManager(sessions, { notify })

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
      manager = makeManager(sessions, { notify })

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
      manager = makeManager(sessions, { notify })
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

  // -------------------------------------------------------------------------
  // unified run store persistence
  // -------------------------------------------------------------------------

  describe('run store persistence', () => {
    let runStore: RunStore

    beforeEach(() => {
      sessions = makeMockSessions()
      runStore = new RunStore(':memory:')
      manager = new OrchestratorChildManager(sessions, {
        exec: vi.fn(async () => '[{"number": 1}]'),
        runStore,
      })
    })

    afterEach(() => {
      runStore.close()
    })

    it('persists a spawned child as an agent run with a spawn ledger entry', async () => {
      const child = await manager.spawn(makeRequest())

      const run = runStore.getRun(child.id)
      expect(run).toMatchObject({
        engine: 'agent',
        kind: 'child',
        status: 'running',
        title: 'Fix the login bug',
        repo: '/repos/myproject',
        branch: 'fix/login-bug',
        sessionIds: [child.id],
      })
      expect(runStore.listLedger(child.id)[0].summary).toContain('Spawned')
    })

    it('persists a blocked transition with a ledger note when a prompt fires', async () => {
      const child = await manager.spawn(makeRequest())
      for (const l of sessions._promptListeners) l(child.id, 'permission', 'Bash', 'req-1')

      expect(runStore.getRun(child.id)?.status).toBe('blocked')
      expect(runStore.listLedger(child.id).some((e) => e.summary.includes('approval for Bash'))).toBe(true)
    })

    it('persists a spawn failure as a failed run', async () => {
      sessions.startClaude.mockImplementation(() => { throw new Error('no CLI') })
      const child = await manager.spawn(makeRequest())

      expect(child.status).toBe('failed')
      expect(runStore.getRun(child.id)).toMatchObject({ status: 'failed', error: 'no CLI' })
    })
  })
})
