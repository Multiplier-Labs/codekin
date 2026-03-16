/** Tests for OrchestratorChildManager — verifies prompt generation for
 * worktree vs non-worktree scenarios and worktree failure context. */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
}))

import { OrchestratorChildManager, type ChildSessionRequest } from './orchestrator-children.js'

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

function fakeSessionManager(worktreeSucceeds = true) {
  const sentInputs: string[] = []
  return {
    create: vi.fn(() => ({ id: 'child-session-id' })),
    createWorktree: vi.fn(async () => worktreeSucceeds ? '/repos/myproject-wt-child123' : null),
    startClaude: vi.fn(),
    sendInput: vi.fn((_, prompt: string) => { sentInputs.push(prompt) }),
    get: vi.fn(() => ({
      claudeProcess: {
        isAlive: () => true,
        on: vi.fn(),
        once: vi.fn(),
      },
      outputHistory: [],
    })),
    onSessionExit: vi.fn(() => vi.fn()),
    onSessionResult: vi.fn(() => vi.fn()),
    clearProcessingFlag: vi.fn(),
    _sentInputs: sentInputs,
  } as any
}

describe('OrchestratorChildManager', () => {
  describe('spawn() prompt generation', () => {
    it('includes worktree environment section when worktree succeeds', async () => {
      const sm = fakeSessionManager(true)
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ useWorktree: true })

      await mgr.spawn(request)

      expect(sm._sentInputs).toHaveLength(1)
      const prompt = sm._sentInputs[0]
      expect(prompt).toContain('Worktree Environment')
      expect(prompt).toContain('isolated git worktree')
      expect(prompt).toContain('fix/login-bug')
      expect(prompt).toContain('Do NOT use the `EnterWorktree`')
    })

    it('does NOT include worktree section when worktree not requested', async () => {
      const sm = fakeSessionManager(true)
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ useWorktree: false })

      await mgr.spawn(request)

      const prompt = sm._sentInputs[0]
      expect(prompt).not.toContain('Worktree Environment')
      expect(prompt).not.toContain('EnterWorktree')
    })

    it('includes worktree failure warning when worktree creation fails', async () => {
      const sm = fakeSessionManager(false) // worktree fails
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ useWorktree: true })

      await mgr.spawn(request)

      const prompt = sm._sentInputs[0]
      expect(prompt).toContain('Worktree Not Available')
      expect(prompt).toContain('directly in the main repository')
      expect(prompt).toContain('Create branch `fix/login-bug`')
      expect(prompt).not.toContain('Worktree Environment')
    })

    it('omits create-branch step in PR completion when in worktree', async () => {
      const sm = fakeSessionManager(true)
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ useWorktree: true, completionPolicy: 'pr' })

      await mgr.spawn(request)

      const prompt = sm._sentInputs[0]
      // Should NOT tell Claude to create/switch branches
      expect(prompt).not.toContain('Create and switch to branch')
      // Should still mention push + PR
      expect(prompt).toContain('Push the branch')
      expect(prompt).toContain('Pull Request')
    })

    it('includes create-branch step in PR completion when NOT in worktree', async () => {
      const sm = fakeSessionManager(false) // worktree fails
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ useWorktree: true, completionPolicy: 'pr' })

      await mgr.spawn(request)

      const prompt = sm._sentInputs[0]
      expect(prompt).toContain('Create and switch to branch')
    })

    it('passes branchName to createWorktree', async () => {
      const sm = fakeSessionManager(true)
      const mgr = new OrchestratorChildManager(sm)
      const request = makeRequest({ branchName: 'feat/my-feature' })

      await mgr.spawn(request)

      expect(sm.createWorktree).toHaveBeenCalledWith(
        expect.any(String),
        '/repos/myproject',
        'feat/my-feature',
      )
    })
  })
})
