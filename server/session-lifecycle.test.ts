/** Tests for SessionLifecycle — verifies startClaude, handleClaudeExit, and restart logic. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock fs so we can control working-directory checks and prevent realpathSync
// from crashing when the path doesn't exist (e.g. in CI).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    realpathSync: vi.fn((p: string) => p),
  }
})

// Mock ClaudeProcess — we don't want real CLI spawns
vi.mock('./claude-process.js', async () => {
  const { EventEmitter } = await import('node:events')
  class MockClaudeProcess extends EventEmitter {
    start = vi.fn()
    stop = vi.fn()
    isAlive = vi.fn(() => true)
    sendMessage = vi.fn()
    sendControlResponse = vi.fn()
    hasSessionConflict = vi.fn(() => false)
    hadOutput = vi.fn(() => true)
    hasSpawnFailed = vi.fn(() => false)
    waitForExit = vi.fn(() => Promise.resolve())
  }
  return { ClaudeProcess: MockClaudeProcess }
})

// Mock crypto-utils
vi.mock('./crypto-utils.js', () => ({
  deriveSessionToken: vi.fn(() => 'mock-session-token'),
}))

// Mock session-restart-scheduler
const mockEvaluateRestart = vi.hoisted(() => vi.fn())
vi.mock('./session-restart-scheduler.js', () => ({
  evaluateRestart: mockEvaluateRestart,
}))

import { SessionLifecycle, type SessionLifecycleDeps } from './session-lifecycle.js'
import { existsSync } from 'fs'
import type { Session } from './types.js'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanManager() {
  return {
    reset: vi.fn(),
    onEnterPlanMode: vi.fn(),
    onTurnEnd: vi.fn(),
    onExitPlanModeRequested: vi.fn(),
    deny: vi.fn(),
    approve: vi.fn(),
    state: 'idle' as const,
    pendingReviewId: null,
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test-session',
    workingDir: '/repos/test',
    created: new Date().toISOString(),
    source: 'manual',
    claudeProcess: null,
    clients: new Set(),
    outputHistory: [],
    claudeSessionId: null,
    restartCount: 0,
    lastRestartAt: null,
    _stoppedByUser: false,
    _wasActiveBeforeRestart: false,
    pendingControlRequests: new Map(),
    pendingToolApprovals: new Map(),
    isProcessing: false,
    _turnCount: 0,
    _claudeTurnCount: 0,
    _namingAttempts: 0,
    _apiRetryCount: 0,
    _processGeneration: 0,
    _noOutputExitCount: 0,
    _lastActivityAt: Date.now(),
    planManager: makePlanManager() as any,
    ...overrides,
  } as Session
}

function makeDeps(overrides: Partial<SessionLifecycleDeps> = {}): SessionLifecycleDeps {
  return {
    getSession: vi.fn(() => undefined),
    hasSession: vi.fn(() => true),
    broadcast: vi.fn(),
    addToHistory: vi.fn(),
    broadcastAndHistory: vi.fn(),
    persistToDisk: vi.fn(),
    globalBroadcast: vi.fn(),
    authToken: 'test-token',
    serverPort: 32352,
    approvalManager: {
      getAllowedToolsForRepo: vi.fn(() => []),
      checkAutoApproval: vi.fn(() => false),
      saveAlwaysAllow: vi.fn(),
      savePatternApproval: vi.fn(),
      derivePattern: vi.fn(),
    } as any,
    promptRouter: {
      onPromptEvent: vi.fn(),
      onControlRequestEvent: vi.fn(),
    } as any,
    exitListeners: [],
    onSystemInit: vi.fn(),
    onTextEvent: vi.fn(),
    onThinkingEvent: vi.fn(),
    onToolOutputEvent: vi.fn(),
    onImageEvent: vi.fn(),
    onToolActiveEvent: vi.fn(),
    onToolDoneEvent: vi.fn(),
    handleClaudeResult: vi.fn(),
    buildSessionContext: vi.fn(() => null),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionLifecycle', () => {
  let deps: SessionLifecycleDeps
  let lifecycle: SessionLifecycle
  let session: Session

  beforeEach(() => {
    vi.useFakeTimers()
    session = makeSession()
    deps = makeDeps({ getSession: vi.fn(() => session), hasSession: vi.fn(() => true) })
    lifecycle = new SessionLifecycle(deps)
    ;(existsSync as any).mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // startClaude
  // -------------------------------------------------------------------------

  describe('startClaude', () => {
    it('returns false when session not found', () => {
      deps.getSession = vi.fn(() => undefined) as any
      lifecycle = new SessionLifecycle(deps)
      expect(lifecycle.startClaude('no-exist')).toBe(false)
    })

    it('spawns a ClaudeProcess, wires events, and broadcasts session_started', () => {
      const result = lifecycle.startClaude('sess-1')

      expect(result).toBe(true)
      expect(session.claudeProcess).not.toBeNull()
      expect(session.claudeProcess!.start).toHaveBeenCalled()
      expect(session._stoppedByUser).toBe(false)

      // Should broadcast claude_started
      expect(deps.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'claude_started' }))
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'claude_started' }))
      expect(deps.globalBroadcast).toHaveBeenCalledWith({ type: 'sessions_updated' })
    })

    it('kills existing process before starting a new one', () => {
      const oldProcess = new EventEmitter() as any
      oldProcess.removeAllListeners = vi.fn()
      oldProcess.stop = vi.fn()
      session.claudeProcess = oldProcess

      lifecycle.startClaude('sess-1')

      expect(oldProcess.stop).toHaveBeenCalled()
      expect(session.claudeProcess).not.toBe(oldProcess)
    })

    it('clears _stoppedByUser and _restartTimer on start', () => {
      session._stoppedByUser = true
      session._restartTimer = setTimeout(() => {}, 10000) as any

      lifecycle.startClaude('sess-1')

      expect(session._stoppedByUser).toBe(false)
      expect(session._restartTimer).toBeUndefined()
    })

    it('falls back to groupDir when workingDir is missing', () => {
      session.workingDir = '/repos/dead-worktree'
      session.groupDir = '/repos/test'
      session.worktreePath = '/repos/dead-worktree'
      ;(existsSync as any).mockImplementation((p: string) => {
        if (p === '/repos/dead-worktree') return false
        return true
      })

      const result = lifecycle.startClaude('sess-1')
      expect(result).toBe(true)
      expect(session.workingDir).toBe('/repos/test')
      expect(session.worktreePath).toBeUndefined()
      expect(deps.persistToDisk).toHaveBeenCalled()
    })

    it('returns false and stops when workingDir missing and no fallback', () => {
      session.workingDir = '/repos/gone'
      session.groupDir = undefined
      ;(existsSync as any).mockImplementation((p: string) => {
        if (p === '/repos/gone') return false
        return true
      })

      const result = lifecycle.startClaude('sess-1')
      expect(result).toBe(false)
      expect(session._stoppedByUser).toBe(true)
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'system_message', subtype: 'error' }))
    })

    it('bumps _processGeneration on each call', () => {
      expect(session._processGeneration).toBe(0)
      lifecycle.startClaude('sess-1')
      expect(session._processGeneration).toBe(1)
      // Second call kills existing process and bumps again
      lifecycle.startClaude('sess-1')
      expect(session._processGeneration).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // handleClaudeExit
  // -------------------------------------------------------------------------

  describe('handleClaudeExit', () => {
    let exitedProcess: any

    beforeEach(() => {
      exitedProcess = new EventEmitter() as any
      exitedProcess.hasSessionConflict = vi.fn(() => false)
      exitedProcess.hadOutput = vi.fn(() => true)
      exitedProcess.hasSpawnFailed = vi.fn(() => false)
      exitedProcess.removeAllListeners = vi.fn()
      session.claudeProcess = exitedProcess
    })

    it('ignores exit from stale (replaced) process', () => {
      const newProcess = new EventEmitter()
      session.claudeProcess = newProcess as any

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 0, null)

      // Should not have nulled claudeProcess or called any deps
      expect(session.claudeProcess).toBe(newProcess)
      expect(deps.broadcast).not.toHaveBeenCalled()
    })

    it('broadcasts exit message on clean stopped-by-user exit', () => {
      session._stoppedByUser = true
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 0, null)

      expect(session.claudeProcess).toBeNull()
      expect(session.isProcessing).toBe(false)
      expect(deps.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({ subtype: 'exit' }))
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'exit' }))
    })

    it('broadcasts session conflict message when session ID is in use', () => {
      exitedProcess.hasSessionConflict.mockReturnValue(true)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(deps.addToHistory).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ text: expect.stringContaining('session ID is already in use') }),
      )
    })

    it('notifies exit listeners with willRestart=false on stopped_by_user', () => {
      const listener = vi.fn()
      deps.exitListeners.push(listener)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 0, null)

      expect(listener).toHaveBeenCalledWith('sess-1', 0, null, false)
    })

    it('schedules restart on unexpected exit', () => {
      mockEvaluateRestart.mockReturnValue({
        kind: 'restart',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        updatedCount: 1,
        updatedLastRestartAt: Date.now(),
      })
      const listener = vi.fn()
      deps.exitListeners.push(listener)

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, 'SIGTERM')

      expect(listener).toHaveBeenCalledWith('sess-1', 1, 'SIGTERM', true)
      expect(session.restartCount).toBe(1)
      expect(deps.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({ subtype: 'restart' }))

      // Restart timer should fire and call startClaude
      expect(session._restartTimer).toBeDefined()
    })

    it('restart timer calls startClaude after delay', () => {
      mockEvaluateRestart.mockReturnValue({
        kind: 'restart',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        updatedCount: 1,
        updatedLastRestartAt: Date.now(),
      })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      // Before timer fires, startClaude shouldn't have been called (claudeProcess is null from exit)
      expect(session.claudeProcess).toBeNull()

      // Advance timer
      vi.advanceTimersByTime(2000)

      // startClaude should have run — session.claudeProcess should be set again
      expect(session.claudeProcess).not.toBeNull()
    })

    it('restart timer does nothing if session was stopped', () => {
      mockEvaluateRestart.mockReturnValue({
        kind: 'restart',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        updatedCount: 1,
        updatedLastRestartAt: Date.now(),
      })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      // User stops the session before timer fires
      session._stoppedByUser = true

      vi.advanceTimersByTime(2000)

      // Should not have started a new process
      expect(session.claudeProcess).toBeNull()
    })

    it('restart timer does nothing if session was removed', () => {
      mockEvaluateRestart.mockReturnValue({
        kind: 'restart',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        updatedCount: 1,
        updatedLastRestartAt: Date.now(),
      })
      ;(deps.hasSession as any).mockReturnValue(false)

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)
      vi.advanceTimersByTime(2000)

      expect(session.claudeProcess).toBeNull()
    })

    it('broadcasts error on exhausted restarts', () => {
      mockEvaluateRestart.mockReturnValue({ kind: 'exhausted', maxAttempts: 3 })
      const listener = vi.fn()
      deps.exitListeners.push(listener)

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(listener).toHaveBeenCalledWith('sess-1', 1, null, false)
      expect(deps.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({ subtype: 'error' }))
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'exit' }))
    })

    it('increments no-output counter but preserves claudeSessionId on single no-output exit', () => {
      session.claudeSessionId = 'old-session-id'
      session._noOutputExitCount = 0
      exitedProcess.hadOutput.mockReturnValue(false)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session.claudeSessionId).toBe('old-session-id')
      expect(session._noOutputExitCount).toBe(1)
    })

    it('preserves claudeSessionId when spawn failed', () => {
      session.claudeSessionId = 'old-session-id'
      exitedProcess.hadOutput.mockReturnValue(false)
      exitedProcess.hasSpawnFailed.mockReturnValue(true)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session.claudeSessionId).toBe('old-session-id')
    })

    it('falls back to groupDir when workingDir disappears mid-session', () => {
      session.workingDir = '/repos/dead-worktree'
      session.groupDir = '/repos/test'
      session.worktreePath = '/repos/dead-worktree'
      ;(existsSync as any).mockImplementation((p: string) => {
        if (p === '/repos/dead-worktree') return false
        return true
      })
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session.workingDir).toBe('/repos/test')
      expect(session.worktreePath).toBeUndefined()
      expect(deps.persistToDisk).toHaveBeenCalled()
    })

    it('stops session when workingDir gone and no fallback', () => {
      session.workingDir = '/repos/gone'
      session.groupDir = undefined
      ;(existsSync as any).mockImplementation((p: string) => {
        if (p === '/repos/gone') return false
        return true
      })
      // evaluateRestart should NOT be called in this path
      mockEvaluateRestart.mockReturnValue({ kind: 'restart', attempt: 1, maxAttempts: 3, delayMs: 2000, updatedCount: 1, updatedLastRestartAt: Date.now() })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session._stoppedByUser).toBe(true)
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'exit' }))
    })

    // --- Generation ID tests ---

    it('restart timer skips if generation changed (another start happened)', () => {
      mockEvaluateRestart.mockReturnValue({
        kind: 'restart',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        updatedCount: 1,
        updatedLastRestartAt: Date.now(),
      })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      // Simulate another code path starting Claude before the timer fires
      // (e.g. user sends input which triggers sendInput → startClaude)
      session._processGeneration = 99

      vi.advanceTimersByTime(2000)

      // The timer should have been a no-op — claudeProcess stays null
      // (startClaude was not called by the timer)
      expect(session.claudeProcess).toBeNull()
    })

    // --- Non-retryable exit code tests ---

    it('does not restart on non-retryable exit code', () => {
      mockEvaluateRestart.mockReturnValue({ kind: 'non_retryable', exitCode: 2 })
      const listener = vi.fn()
      deps.exitListeners.push(listener)

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 2, null)

      expect(listener).toHaveBeenCalledWith('sess-1', 2, null, false)
      expect(deps.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({
        subtype: 'error',
        text: expect.stringContaining('non-retryable'),
      }))
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'exit' }))
    })

    // --- No-output threshold tests ---

    it('preserves claudeSessionId on first no-output exit (threshold not reached)', () => {
      session.claudeSessionId = 'old-session-id'
      session._noOutputExitCount = 0
      exitedProcess.hadOutput.mockReturnValue(false)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session.claudeSessionId).toBe('old-session-id')
      expect(session._noOutputExitCount).toBe(1)
    })

    it('clears claudeSessionId after consecutive no-output exits reach threshold', () => {
      session.claudeSessionId = 'old-session-id'
      session._noOutputExitCount = 1 // already had one failure
      exitedProcess.hadOutput.mockReturnValue(false)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 1, null)

      expect(session.claudeSessionId).toBeNull()
      expect(session._noOutputExitCount).toBe(0) // reset after clearing
    })

    it('resets no-output counter when process produces output', () => {
      session._noOutputExitCount = 1
      exitedProcess.hadOutput.mockReturnValue(true)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 0, null)

      expect(session._noOutputExitCount).toBe(0)
    })

    it('swallows errors from exit listeners', () => {
      const badListener = vi.fn(() => { throw new Error('boom') })
      const goodListener = vi.fn()
      deps.exitListeners.push(badListener, goodListener)
      mockEvaluateRestart.mockReturnValue({ kind: 'stopped_by_user' })

      // Should not throw
      lifecycle.handleClaudeExit(exitedProcess, session, 'sess-1', 0, null)

      expect(badListener).toHaveBeenCalled()
      expect(goodListener).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // stopClaude / stopClaudeAndWait
  // -------------------------------------------------------------------------

  describe('stopClaude', () => {
    it('stops the process and broadcasts claude_stopped', () => {
      const proc = new EventEmitter() as any
      proc.removeAllListeners = vi.fn()
      proc.stop = vi.fn()
      session.claudeProcess = proc

      lifecycle.stopClaude('sess-1')

      expect(proc.stop).toHaveBeenCalled()
      expect(session.claudeProcess).toBeNull()
      expect(session._stoppedByUser).toBe(true)
      expect(deps.broadcast).toHaveBeenCalledWith(session, { type: 'claude_stopped' })
    })

    it('does nothing when no process is running', () => {
      session.claudeProcess = null
      lifecycle.stopClaude('sess-1')
      expect(deps.broadcast).not.toHaveBeenCalled()
    })
  })

  describe('stopClaudeAndWait', () => {
    it('waits for process exit before nulling reference', async () => {
      const proc = new EventEmitter() as any
      proc.removeAllListeners = vi.fn()
      proc.stop = vi.fn()
      proc.waitForExit = vi.fn(() => Promise.resolve())
      session.claudeProcess = proc

      await lifecycle.stopClaudeAndWait('sess-1')

      expect(proc.waitForExit).toHaveBeenCalled()
      expect(session.claudeProcess).toBeNull()
    })
  })
})
