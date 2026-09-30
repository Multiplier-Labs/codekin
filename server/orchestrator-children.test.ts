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
    provider: 'claude',
    repo: '/repos/myproject',
    task: 'Fix the login bug',
    branchName: 'fix/login-bug',
    completionPolicy: 'pr',
    useWorktree: true,
    ...overrides,
  }
}

function makeMockSessions(worktreeSucceeds = true) {
  const sentInputs: string[] = []
  const resultListeners: Array<(sessionId: string, isError: boolean) => void> = []
  const exitListeners: Array<(sessionId: string, code: number | null, signal: string | null, willRestart: boolean) => void> = []
  const promptListeners: Array<(sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void> = []
  const promptResolvedListeners: Array<(sessionId: string, requestId: string) => void> = []
  const stopListeners: Array<(sessionId: string, reason: 'stopped' | 'archived' | 'deleted') => void> = []

  return {
    create: vi.fn(),
    archive: { getSetting: (_key: string, fallback = '') => fallback } as { getSetting: (key: string, fallback?: string) => string },
    prepareSessionWorktree: vi.fn(async () => worktreeSucceeds
      ? { ok: true, path: '/repos/myproject-wt-child123', branch: 'fix/test', repoRoot: '/repos/myproject', reused: false }
      : { ok: false, code: 'git_failed', message: 'git worktree add failed' }),
    delete: vi.fn(),
    startClaude: vi.fn(),
    stopClaude: vi.fn(),
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
    onSessionPromptResolved: vi.fn((cb: any) => { promptResolvedListeners.push(cb); return () => {} }),
    onSessionStopped: vi.fn((cb: any) => { stopListeners.push(cb); return () => {} }),
    clearProcessingFlag: vi.fn(),
    _sentInputs: sentInputs,
    _promptResolvedListeners: promptResolvedListeners,
    _stopListeners: stopListeners,
    _resultListeners: resultListeners,
    _exitListeners: exitListeners,
    _promptListeners: promptListeners,
  } as any
}

const HEAD = 'abc123def456abc123def456abc123def456abcd'

/**
 * Fake gh / git for ground-truth checks. Defaults describe finished work:
 * an open PR and the remote branch both at the local HEAD. Pass `fail` to
 * make every command throw (gh missing, no remote).
 */
function fakeGit(opts: { head?: string; prs?: unknown[]; remote?: string; fail?: boolean } = {}) {
  const head = opts.head ?? HEAD
  return vi.fn(async (cmd: string, args: string[]) => {
    if (opts.fail) throw new Error(`${cmd}: command not found`)
    if (cmd === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (cmd === 'gh') {
      return JSON.stringify(opts.prs ?? [{ number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', headRefOid: head }])
    }
    if (cmd === 'git' && args[0] === 'ls-remote') return opts.remote ?? `${head}\trefs/heads/fix/login-bug\n`
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
  })
}

/**
 * Build a manager with a stubbed exec so ground-truth checks (gh / git)
 * never spawn real processes. The default stub reports the final step as
 * done at the local HEAD. Override `exec` to simulate a missing step.
 */
function makeManager(
  sessions: any,
  opts: { notify?: any; exec?: any } = {},
): OrchestratorChildManager {
  return new OrchestratorChildManager(sessions, {
    exec: opts.exec ?? fakeGit(),
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

      expect(sessions.prepareSessionWorktree).toHaveBeenCalledWith(child.id, '/repos/myproject', 'fix/login-bug')
      expect(sessions.create).toHaveBeenCalledWith(expect.any(String), '/repos/myproject', expect.objectContaining({ useWorktree: true }))
      expect(child.status).toBe('running')
    })

    it('fails the child instead of running in the shared checkout when worktree creation fails', async () => {
      sessions = makeMockSessions(false)
      manager = makeManager(sessions)

      const child = await manager.spawn(makeRequest({ useWorktree: true }))

      expect(child.status).toBe('failed')
      expect(child.error).toContain('git worktree add failed')
      expect(sessions.startClaude).not.toHaveBeenCalled()
      expect(sessions._sentInputs).toHaveLength(0)
      expect(sessions.delete).toHaveBeenCalledWith(child.id)
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
      expect(child.error).toBe('Coding agent returned an error')
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
      manager = makeManager(sessions, { exec: fakeGit({ prs: [] }) })
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

    it('marks child as canceled when its session disappears', async () => {
      sessions.get = vi.fn(() => null)

      const child = await manager.spawn(makeRequest())

      for (const listener of sessions._resultListeners) {
        listener(child.id, false)
      }

      await vi.waitFor(() => {
        expect(child.status).toBe('canceled')
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

    it('verifies an open PR at the worktree HEAD for pr policy', async () => {
      const exec = fakeGit()
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('done'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(exec).toHaveBeenCalledWith(
        'gh',
        ['pr', 'list', '--head', 'fix/login-bug', '--state', 'all', '--json', 'number,url,state,headRefOid', '--limit', '5'],
        '/repos/myproject-wt-child123',
      )
      expect(child.error).toBeNull()
      expect(child.verification).toMatchObject({ state: 'verified', commit: HEAD, prUrl: 'https://github.com/o/r/pull/1' })
    })

    it('nudges once when no PR exists, then ends unverified — never completed', async () => {
      manager = makeManager(sessions, { exec: fakeGit({ prs: [] }) })
      sessions.get = vi.fn(() => aliveSession('made the changes and committed'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))

      // First result: PR missing → nudge, keep monitoring
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('no pull request exists'))).toBe(true)
      })
      expect(child.status).toBe('running')

      // Second result: still no PR → no second nudge, terminal and unverified
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => {
        expect(child.status).toBe('unverified')
      })
      expect(child.error).toContain('Completion not verified')
      expect(child.verification?.state).toBe('missing')
      const nudges = sessions._sentInputs.filter((p: string) => p.includes('no pull request exists'))
      expect(nudges.length).toBe(1)
    })

    it('does not accept a closed PR', async () => {
      manager = makeManager(sessions, { exec: fakeGit({ prs: [{ number: 3, state: 'CLOSED', headRefOid: HEAD }] }) })
      sessions.get = vi.fn(() => aliveSession('done'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('only closed pull requests'))).toBe(true)
      })
    })

    it('treats a PR behind the local HEAD as missing (unpushed commits)', async () => {
      manager = makeManager(sessions, { exec: fakeGit({ prs: [{ number: 4, state: 'OPEN', headRefOid: 'fff000' }] }) })
      sessions.get = vi.fn(() => aliveSession('done'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('latest commits are not pushed'))).toBe(true)
      })
      expect(child.status).toBe('running')
    })

    it('checks git ls-remote for merge policy and nudges when the branch is not on the remote', async () => {
      const exec = fakeGit({ remote: '' })
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('committed everything'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'merge' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('is not on the remote'))).toBe(true)
      })
      expect(exec).toHaveBeenCalledWith(
        'git',
        ['ls-remote', '--heads', 'origin', 'fix/login-bug'],
        '/repos/myproject-wt-child123',
      )
    })

    it('nudges for merge policy when the remote branch is behind the local HEAD', async () => {
      manager = makeManager(sessions, { exec: fakeGit({ remote: 'fff000\trefs/heads/fix/login-bug\n' }) })
      sessions.get = vi.fn(() => aliveSession('pushed'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'merge' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(sessions._sentInputs.some((p: string) => p.includes('latest commits are not pushed'))).toBe(true)
      })
    })

    it('completes merge policy when the remote branch is at the local HEAD', async () => {
      manager = makeManager(sessions, { exec: fakeGit() })
      sessions.get = vi.fn(() => aliveSession('pushed'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'merge' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(child.error).toBeNull()
      expect(child.verification).toMatchObject({ state: 'verified', commit: HEAD })
    })

    it('ends unverified (not completed) when the ground-truth command fails, whatever the transcript says', async () => {
      manager = makeManager(sessions, { exec: fakeGit({ fail: true }) })
      sessions.get = vi.fn(() => aliveSession('Opened a pull request with the changes.'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'pr' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('unverified')
      })
      expect(child.verification?.state).toBe('unknown')
      // An unknown check is not something a nudge can fix.
      expect(sessions._sentInputs.length).toBe(1)
    })

    it('never verifies remotely for commit-only policy', async () => {
      const exec = fakeGit()
      manager = makeManager(sessions, { exec })
      sessions.get = vi.fn(() => aliveSession('committed locally'))

      const child = await manager.spawn(makeRequest({ completionPolicy: 'commit-only' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)

      await vi.waitFor(() => {
        expect(child.status).toBe('completed')
      })
      expect(exec).not.toHaveBeenCalledWith('gh', expect.anything(), expect.anything())
      expect(exec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['ls-remote']), expect.anything())
      expect(child.verification).toMatchObject({ state: 'not_applicable', commit: HEAD })
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


  describe('harness selection', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

    it.each(['claude', 'codex', 'opencode'] as const)('honors an explicit %s override without inheriting another harness model', async (provider) => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider: 'codex', model: 'codex-model' })
      const child = await makeManager(sessions).spawn(makeRequest({ provider, parentSessionId: 'joe' }))
      expect(sessions.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ provider, model: provider === 'codex' ? 'codex-model' : undefined }))
      expect(child.request.provider).toBe(provider)
    })

    it.each(['codex', 'opencode'] as const)('inherits the parent %s harness and model', async (provider) => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider, model: 'selected-model' })
      const child = await makeManager(sessions).spawn(makeRequest({ provider: undefined, parentSessionId: 'joe' }))
      expect(child.request).toMatchObject({ provider, model: 'selected-model' })
      expect(sessions.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ provider, model: 'selected-model' }))
    })

    it('uses the saved harness when the parent is not loaded', async () => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue(undefined)
      sessions.archive = { getSetting: () => 'opencode' }
      const child = await makeManager(sessions).spawn(makeRequest({ provider: undefined, parentSessionId: 'joe' }))
      expect(child.request.provider).toBe('opencode')
    })

    it('refuses to spawn without a selected harness', async () => {
      sessions = makeMockSessions()
      sessions.archive = { getSetting: () => '' }
      await expect(makeManager(sessions).spawn(makeRequest({ provider: undefined }))).rejects.toThrow(/Choose an agent harness/)
      expect(sessions.create).not.toHaveBeenCalled()
    })

    it('uses the saved model when the parent is not loaded and the harness matches', async () => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue(undefined)
      const settings: Record<string, string> = { agent_provider: 'codex', agent_model: 'gpt-6-sol' }
      sessions.archive = { getSetting: (key: string) => settings[key] ?? '' }
      const child = await makeManager(sessions).spawn(makeRequest({ provider: undefined, parentSessionId: 'joe' }))
      expect(child.request).toMatchObject({ provider: 'codex', model: 'gpt-6-sol' })
    })

    it('refuses a model id from another harness', async () => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider: 'codex', model: 'gpt-6-sol' })
      await expect(makeManager(sessions).spawn(makeRequest({ provider: undefined, model: 'claude-opus-5-5', parentSessionId: 'joe' })))
        .rejects.toThrow(/does not belong to the codex harness/)
      await expect(makeManager(sessions).spawn(makeRequest({ provider: 'claude', model: 'gpt-6-sol', parentSessionId: 'joe' })))
        .rejects.toThrow(/does not belong to the claude harness/)
      expect(sessions.create).not.toHaveBeenCalled()
    })

    it('preserves an explicit child model on the selected harness', async () => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider: 'codex', model: 'parent-model' })
      const child = await makeManager(sessions).spawn(makeRequest({ provider: 'codex', model: 'child-model', parentSessionId: 'joe' }))
      expect(child.request.model).toBe('child-model')
    })
  })

  describe('permission mode', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

    it.each(['default', 'acceptEdits', 'bypassPermissions', 'dangerouslySkipPermissions'] as const)('inherits Joe\'s %s mode', async (permissionMode) => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider: 'claude', model: 'claude-opus-5-5', permissionMode })
      const child = await makeManager(sessions).spawn(makeRequest({ parentSessionId: 'joe' }))
      expect(child.request.permissionMode).toBe(permissionMode)
      expect(sessions.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ permissionMode }))
    })

    it('runs in acceptEdits when Joe is planning or not loaded', async () => {
      sessions = makeMockSessions()
      sessions.get.mockReturnValue({ provider: 'claude', permissionMode: 'plan' })
      expect((await makeManager(sessions).spawn(makeRequest({ parentSessionId: 'joe' }))).request.permissionMode).toBe('acceptEdits')
      sessions.get.mockReturnValue(undefined)
      expect((await makeManager(sessions).spawn(makeRequest({ branchName: 'fix/other', parentSessionId: 'joe' }))).request.permissionMode).toBe('acceptEdits')
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
      // A deliberate stop, so the process is not auto-restarted as a crash.
      expect(sessions.stopClaude).toHaveBeenCalledWith(child.id)
    })

    it('resumes the working clock as soon as the prompt is resolved, without waiting for a result', async () => {
      const pendingApprovals = new Map([['req-1', { toolInput: { command: 'git push' } }]])
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: pendingApprovals,
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest({ timeoutMs: 60_000 }))
      vi.advanceTimersByTime(30_000)
      for (const cb of sessions._promptListeners) cb(child.id, 'permission', 'Bash', 'req-1')
      expect(child.status).toBe('blocked')

      pendingApprovals.clear()
      for (const cb of sessions._promptResolvedListeners) cb(child.id, 'req-1')
      expect(child.status).toBe('running')

      // The remaining ~30s of working budget burns with no result event.
      vi.advanceTimersByTime(31_000)
      await vi.waitFor(() => {
        expect(child.status).toBe('timed_out')
      })
      expect(child.error).toContain('working time')
    })

    it('stays blocked while another prompt is still pending', async () => {
      const pendingApprovals = new Map([['req-1', {}], ['req-2', {}]])
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [],
        pendingToolApprovals: pendingApprovals,
        pendingControlRequests: new Map(),
      }))

      const child = await manager.spawn(makeRequest())
      for (const cb of sessions._promptListeners) cb(child.id, 'permission', 'Bash', 'req-1')
      pendingApprovals.delete('req-1')
      for (const cb of sessions._promptResolvedListeners) cb(child.id, 'req-1')

      expect(child.status).toBe('blocked')
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
      manager = makeManager(sessions, { exec: fakeGit({ prs: [] }) })
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
      expect(sessions._sentInputs.some((p: string) => p.includes('no pull request exists'))).toBe(true)
      vi.advanceTimersByTime(31_000)

      await vi.waitFor(() => {
        expect(child.status).toBe('timed_out')
      })
      expect(child.error).toContain('working time')
    })
  })

  // -------------------------------------------------------------------------
  // Stop / archive / delete
  // -------------------------------------------------------------------------

  describe('session stop events', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      sessions = makeMockSessions()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      ['stopped', 'Session was stopped by the user'],
      ['archived', 'Session was archived'],
      ['deleted', 'Session was deleted'],
    ] as const)('cancels the child immediately when its session is %s', async (reason, error) => {
      const notify = vi.fn(() => true)
      manager = makeManager(sessions, { notify })
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-1' }))
      expect(manager.activeCount()).toBe(1)

      for (const cb of sessions._stopListeners) cb(child.id, reason)
      await vi.advanceTimersByTimeAsync(0)

      expect(child.status).toBe('canceled')
      expect(child.error).toBe(error)
      expect(manager.activeCount()).toBe(0)
      expect(notify).toHaveBeenCalledTimes(1)
      expect((notify.mock.calls[0] as any[])[0].body).toContain('Status: canceled')

      // The old working-time budget no longer fires.
      vi.advanceTimersByTime(2 * 3_600_000)
      expect(child.status).toBe('canceled')
      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('stays canceled when the session is deleted while its worktree is being prepared', async () => {
      let finishWorktree!: () => void
      sessions.prepareSessionWorktree = vi.fn(() => new Promise((resolve) => {
        finishWorktree = () => resolve({ ok: true, path: '/repos/myproject-wt-child123' })
      }))
      manager = makeManager(sessions)
      const spawning = manager.spawn(makeRequest())
      await vi.advanceTimersByTimeAsync(0)
      const [child] = manager.list()
      expect(child.status).toBe('starting')

      for (const cb of sessions._stopListeners) cb(child.id, 'deleted')
      finishWorktree()
      await spawning

      expect(child.status).toBe('canceled')
      expect(sessions.startClaude).not.toHaveBeenCalled()
    })

    it('ignores stop events for terminal children and unrelated sessions', async () => {
      manager = makeManager(sessions)
      const child = await manager.spawn(makeRequest())
      for (const cb of sessions._stopListeners) cb('someone-else', 'stopped')
      expect(child.status).toBe('running')

      for (const cb of sessions._stopListeners) cb(child.id, 'stopped')
      await vi.advanceTimersByTimeAsync(0)
      for (const cb of sessions._stopListeners) cb(child.id, 'deleted')
      expect(child.error).toBe('Session was stopped by the user')
    })
  })

  // -------------------------------------------------------------------------
  // Control: follow-up, stop, resume, close
  // -------------------------------------------------------------------------

  describe('control', () => {
    let session: any
    let notify: ReturnType<typeof vi.fn>

    beforeEach(() => {
      vi.useFakeTimers()
      sessions = makeMockSessions()
      session = {
        claudeProcess: { isAlive: vi.fn(() => true), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'done' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
        worktreePath: '/repos/myproject-wt-child123',
        archivedAt: undefined as string | undefined,
      }
      sessions.get = vi.fn(() => session)
      const fireStop = (reason: string) => (id: string) => { for (const cb of sessions._stopListeners) cb(id, reason) }
      sessions.stopSession = vi.fn(fireStop('stopped'))
      sessions.archiveSession = vi.fn((id: string) => { session.archivedAt = 'now'; fireStop('archived')(id) })
      sessions.delete = vi.fn(fireStop('deleted'))
      sessions.resumeSession = vi.fn(() => { session.archivedAt = undefined })
      sessions.getRemovalPreflight = vi.fn(async () => ({ modified: [], untracked: [] }))
      notify = vi.fn(() => true)
      manager = makeManager(sessions, { notify })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function finish(child: { id: string; status: string }) {
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => expect(child.status).toBe('completed'))
    }

    it('rejects every control call for sessions that are not its children', async () => {
      expect(() => manager.sendFollowUp('stranger', 'hi')).toThrow(/Not one of your child sessions/)
      expect(() => manager.stop('stranger')).toThrow(/Not one of your child sessions/)
      expect(() => manager.resume('stranger')).toThrow(/Not one of your child sessions/)
      await expect(manager.close('stranger')).rejects.toThrow(/Not one of your child sessions/)
      expect(sessions.stopSession).not.toHaveBeenCalled()
      expect(sessions.delete).not.toHaveBeenCalled()
    })

    it('sends a follow-up to an active child', async () => {
      const child = await manager.spawn(makeRequest())
      manager.sendFollowUp(child.id, 'Also update the README')
      expect(sessions.sendInput).toHaveBeenLastCalledWith(child.id, 'Also update the README')
    })

    it('refuses a follow-up while the child waits on a prompt, and for a finished child', async () => {
      const child = await manager.spawn(makeRequest())
      session.pendingToolApprovals.set('req-1', {})
      expect(() => manager.sendFollowUp(child.id, 'x')).toThrow(/respond_to_prompt/)
      session.pendingToolApprovals.clear()
      await finish(child)
      expect(() => manager.sendFollowUp(child.id, 'x')).toThrow(/resume/)
    })

    it('stops an active child without a redundant stop notification', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-1' }))
      manager.stop(child.id)
      await vi.advanceTimersByTimeAsync(0)
      expect(child.status).toBe('canceled')
      expect(sessions.stopSession).toHaveBeenCalledWith(child.id)
      expect(notify).not.toHaveBeenCalled()
      expect(() => manager.stop(child.id)).toThrow(/already canceled/)
    })

    it('resumes a finished child as a new supervised attempt on the same session', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-1' }))
      manager.stop(child.id)
      await vi.advanceTimersByTimeAsync(0)

      const resumed = manager.resume(child.id, 'Fix the failing test and push')
      expect(resumed).toMatchObject({ status: 'running', attempt: 2, error: null, completedAt: null })
      expect(manager.get(child.id)).toBe(resumed)
      expect(manager.activeCount()).toBe(1)
      expect(sessions.sendInput).toHaveBeenLastCalledWith(child.id, 'Fix the failing test and push')

      // Supervised again: completion is re-verified and the parent is notified.
      await finish(resumed)
      expect(resumed.verification?.state).toBe('verified')
      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('sends a default continue instruction and unarchives an archived child', async () => {
      const child = await manager.spawn(makeRequest())
      await finish(child)
      await manager.close(child.id)
      expect(session.archivedAt).toBe('now')

      manager.resume(child.id)
      expect(sessions.resumeSession).toHaveBeenCalledWith(child.id)
      expect(sessions._sentInputs.at(-1)).toContain('Continue the task: Fix the login bug')
      expect(sessions._sentInputs.at(-1)).toContain('open Pull Request')
    })

    it('refuses to resume an active child, a deleted session, or a removed worktree', async () => {
      const child = await manager.spawn(makeRequest())
      expect(() => manager.resume(child.id)).toThrow(/send it a follow-up/)
      await finish(child)
      session.worktreeState = 'removed'
      expect(() => manager.resume(child.id)).toThrow(/worktree was removed/)
      sessions.get = vi.fn(() => undefined)
      expect(() => manager.resume(child.id)).toThrow(/Session was deleted/)
    })

    it('refuses to resume past the concurrency limit', async () => {
      const first = await manager.spawn(makeRequest())
      await finish(first)
      for (let i = 0; i < 5; i++) await manager.spawn(makeRequest({ branchName: `fix/b${i}` }))
      expect(() => manager.resume(first.id)).toThrow(/5 concurrent/)
    })

    it('archives by default and keeps the worktree and branch', async () => {
      const child = await manager.spawn(makeRequest())
      await finish(child)
      const result = await manager.close(child.id)
      expect(result).toMatchObject({
        action: 'archived',
        worktree: { path: '/repos/myproject-wt-child123', outcome: 'kept' },
        branch: 'fix/login-bug',
      })
      expect(sessions.delete).not.toHaveBeenCalled()
    })

    it('refuses to close an active child unless cancel is set', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-1' }))
      await expect(manager.close(child.id)).rejects.toThrow(/cancel: true/)
      const result = await manager.close(child.id, { cancel: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(result.action).toBe('archived')
      expect(child.status).toBe('canceled')
      expect(notify).not.toHaveBeenCalled()
    })

    it('deletes a clean child and reports the worktree removal', async () => {
      const child = await manager.spawn(makeRequest())
      await finish(child)
      const result = await manager.close(child.id, { mode: 'delete' })
      expect(sessions.delete).toHaveBeenCalledWith(child.id)
      expect(result.worktree).toMatchObject({ outcome: 'removal_started', modified: [], untracked: [] })
      expect(manager.list()).toEqual([])
    })

    it('reports a dirty worktree as kept on delete', async () => {
      sessions.getRemovalPreflight = vi.fn(async () => ({ modified: ['src/a.ts'], untracked: ['notes.md'] }))
      const child = await manager.spawn(makeRequest())
      await finish(child)
      const result = await manager.close(child.id, { mode: 'delete' })
      expect(result.worktree).toEqual({ path: '/repos/myproject-wt-child123', outcome: 'kept', modified: ['src/a.ts'], untracked: ['notes.md'] })
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
      await manager.spawn(makeRequest({ useWorktree: false, completionPolicy: 'pr' }))

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
        exec: fakeGit(),
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

    it('persists an unverified child as awaiting_human, never succeeded', async () => {
      manager = new OrchestratorChildManager(sessions, { exec: fakeGit({ fail: true }), runStore })
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'Opened a PR' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))
      const child = await manager.spawn(makeRequest())
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => expect(child.status).toBe('unverified'))
      expect(runStore.getRun(child.id)?.status).toBe('awaiting_human')
    })

    it('records the verified PR url on the run', async () => {
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'done' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))
      const child = await manager.spawn(makeRequest())
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => expect(child.status).toBe('completed'))
      expect(runStore.getRun(child.id)).toMatchObject({ status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1' })
    })

    it('persists a canceled child as a canceled run', async () => {
      const child = await manager.spawn(makeRequest())
      for (const cb of sessions._stopListeners) cb(child.id, 'stopped')
      await vi.waitFor(() => expect(runStore.getRun(child.id)?.status).toBe('canceled'))
    })

    it('recovers children interrupted by a restart, notifies the parent once, and blocks unsupervised auto-restart', async () => {
      const child = await manager.spawn(makeRequest({ parentSessionId: 'parent-1' }))
      const interrupted = runStore.failInterrupted('agent')
      expect(interrupted).toEqual([child.id])

      // A fresh process: new manager, same run store, session restored from disk.
      const restored = { _wasActiveBeforeRestart: true, worktreePath: '/repos/myproject-wt-child123' }
      const fresh = makeMockSessions()
      fresh.get = vi.fn((id: string) => (id === child.id ? restored : undefined))
      const notify = vi.fn(() => true)
      const recoveredManager = new OrchestratorChildManager(fresh, { exec: fakeGit(), runStore, notify })

      const recovered = recoveredManager.recoverInterrupted(interrupted)
      expect(recovered).toHaveLength(1)
      expect(recoveredManager.list().map(c => c.id)).toEqual([child.id])
      expect(recoveredManager.get(child.id)).toMatchObject({ status: 'failed', error: 'interrupted by server restart', worktreePath: '/repos/myproject-wt-child123' })
      expect(recoveredManager.activeCount()).toBe(0)
      expect(restored._wasActiveBeforeRestart).toBe(false)
      expect(notify).toHaveBeenCalledTimes(1)
      expect((notify.mock.calls[0] as any[])[0]).toMatchObject({ parentSessionId: 'parent-1' })
      expect((notify.mock.calls[0] as any[])[0].body).toContain('Inspect worktree at /repos/myproject-wt-child123')

      // Idempotent: recovering again does not re-notify.
      recoveredManager.recoverInterrupted(interrupted)
      expect(notify).toHaveBeenCalledTimes(1)
    })

    it('get() falls back to the run store for children no longer in the live list', async () => {
      const child = await manager.spawn(makeRequest())
      const other = new OrchestratorChildManager(makeMockSessions(), { exec: fakeGit(), runStore })
      expect(other.list()).toEqual([])
      expect(other.get(child.id)).toMatchObject({ id: child.id, status: 'running', request: { task: 'Fix the login bug' } })
      expect(other.get('nope')).toBeNull()
    })

    it('notifies update listeners on every state change and carries the task id', async () => {
      const updates: string[] = []
      const notify = vi.fn(() => true)
      manager = new OrchestratorChildManager(sessions, { exec: fakeGit(), runStore, notify })
      manager.onChildUpdate((c) => { updates.push(`${c.request.taskId}:${c.status}`) })
      sessions.get = vi.fn(() => ({
        claudeProcess: { isAlive: vi.fn(() => false), stop: vi.fn() },
        outputHistory: [{ type: 'output', data: 'done' }],
        pendingToolApprovals: new Map(),
        pendingControlRequests: new Map(),
      }))
      const child = await manager.spawn(makeRequest({ taskId: 'task-9', parentSessionId: 'parent-1' }))
      for (const cb of sessions._resultListeners) cb(child.id, false)
      await vi.waitFor(() => expect(child.status).toBe('completed'))

      expect(updates[0]).toBe('task-9:starting')
      expect(updates).toContain('task-9:running')
      expect(updates.at(-1)).toBe('task-9:completed')
      expect(runStore.getRun(child.id)?.spec).toMatchObject({ taskId: 'task-9' })
      expect((notify.mock.calls[0] as any[])[0].body).toContain('Task: task-9')
    })

    it('persists a spawn failure as a failed run', async () => {
      sessions.startClaude.mockImplementation(() => { throw new Error('no CLI') })
      const child = await manager.spawn(makeRequest())

      expect(child.status).toBe('failed')
      expect(runStore.getRun(child.id)).toMatchObject({ status: 'failed', error: 'no CLI' })
    })
  })
})
