/** Tests for handleWsMessage (ws-message-handler) — verifies WebSocket client message routing, session interactions, and server response payloads. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock config so REPOS_ROOT covers test paths
vi.mock('./config.js', () => ({ REPOS_ROOT: '/projects' }))

// Mock fs.realpathSync to return paths as-is in tests (no real filesystem)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, realpathSync: (p: string) => p }
})

import { handleWsMessage, type WsHandlerContext } from './ws-message-handler.js'
import type { WsClientMessage, WsServerMessage, Session } from './types.js'

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'Test Session',
    workingDir: '/tmp/test',
    created: new Date().toISOString(),
    source: 'manual',
    claudeProcess: null,
    clients: new Set(),
    outputHistory: [],
    claudeSessionId: null,
    restartCount: 0,
    lastRestartAt: null,
    _stoppedByUser: false,
    _stallTimer: null,
    _stallFired: false,
    _wasActiveBeforeRestart: false,
    pendingControlRequests: new Map(),
    pendingToolApprovals: new Map(),
    isProcessing: false,
    _turnCount: 0,
    _namingAttempts: 0,
    _processGeneration: 0,
    _noOutputExitCount: 0,
    _lifetimeRestarts: 0,
    _apiRetry: { count: 0 },
    ...overrides,
  }
}

function createContext(): WsHandlerContext & { sent: WsServerMessage[] } {
  const sent: WsServerMessage[] = []
  const session = mockSession()
  return {
    ws: {} as WsHandlerContext['ws'],
    sessions: {
      create: vi.fn().mockReturnValue(session),
      join: vi.fn().mockReturnValue(session),
      leave: vi.fn(),
      startClaude: vi.fn(),
      stopClaude: vi.fn(),
      stopClaudeAndWait: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(session),
      sendInput: vi.fn(),
      sendPromptResponse: vi.fn(),
      setModel: vi.fn().mockReturnValue(true),
      getSessionProvider: vi.fn().mockReturnValue('claude'),
      setProvider: vi.fn().mockReturnValue(true),
      setPermissionMode: vi.fn().mockReturnValue(true),
      addToHistory: vi.fn(),
      broadcast: vi.fn(),
      getDiff: vi.fn().mockResolvedValue({ type: 'diff_result', files: [], summary: {} }),
      discardChanges: vi.fn().mockResolvedValue({ type: 'diff_result', files: [], summary: {} }),
      createWorktree: vi.fn().mockResolvedValue(null),
    } as unknown as WsHandlerContext['sessions'],
    clientSessions: new Map(),
    send: vi.fn((msg: WsServerMessage) => sent.push(msg)),
    sent,
  }
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('handleWsMessage', () => {
  let ctx: ReturnType<typeof createContext>

  beforeEach(() => {
    ctx = createContext()
    // Wire up ws key so clientSessions.get(ws) works
    ctx.clientSessions.set(ctx.ws, 'sess-1')
  })

  /* ---- ping ---- */

  describe('ping', () => {
    it('responds with pong', () => {
      handleWsMessage({ type: 'ping' } as WsClientMessage, ctx)
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('pong')
    })
  })

  /* ---- resize ---- */

  describe('resize', () => {
    it('is a no-op — no error and no send', () => {
      handleWsMessage({ type: 'resize', cols: 80, rows: 24 } as WsClientMessage, ctx)
      expect(ctx.sent).toHaveLength(0)
      expect(ctx.send).not.toHaveBeenCalled()
    })
  })

  /* ---- create_session (no worktree) ---- */

  describe('create_session (no worktree)', () => {
    it('creates session, adds client, sends session_created, starts Claude', () => {
      const session = mockSession({ id: 'new-1', name: 'My Session', workingDir: '/projects/app' })
      ;(ctx.sessions.create as ReturnType<typeof vi.fn>).mockReturnValue(session)

      handleWsMessage({
        type: 'create_session',
        name: 'My Session',
        workingDir: '/projects/app',
      } as WsClientMessage, ctx)

      expect(ctx.sessions.create).toHaveBeenCalledWith('My Session', '/projects/app', expect.any(Object))
      expect(session.clients.has(ctx.ws)).toBe(true)
      expect(ctx.clientSessions.get(ctx.ws)).toBe('new-1')
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0]).toMatchObject({
        type: 'session_created',
        sessionId: 'new-1',
        sessionName: 'My Session',
        workingDir: '/projects/app',
      })
      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('new-1')
    })
  })

  /* ---- create_session (with worktree) ---- */

  describe('create_session (with worktree)', () => {
    it('creates session, creates worktree async, sends session_created after', async () => {
      const session = mockSession({ id: 'wt-1', name: 'WT Session', workingDir: '/projects/app' })
      ;(ctx.sessions.create as ReturnType<typeof vi.fn>).mockReturnValue(session)
      ;(ctx.sessions.createWorktree as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/worktree')

      handleWsMessage({
        type: 'create_session',
        name: 'WT Session',
        workingDir: '/projects/app',
        useWorktree: true,
      } as WsClientMessage, ctx)

      // session_created is sent asynchronously after worktree resolves
      expect(ctx.sent).toHaveLength(0)

      // Flush microtasks
      await vi.waitFor(() => expect(ctx.sent.length).toBeGreaterThan(0))

      expect(ctx.sessions.createWorktree).toHaveBeenCalledWith('wt-1', '/projects/app')
      expect(ctx.sent[0]).toMatchObject({
        type: 'session_created',
        sessionId: 'wt-1',
      })
      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('wt-1')
    })

    it('sends error when worktree creation fails, then falls back', async () => {
      const session = mockSession({ id: 'wt-2', name: 'WT Fail', workingDir: '/projects/app' })
      ;(ctx.sessions.create as ReturnType<typeof vi.fn>).mockReturnValue(session)
      ;(ctx.sessions.createWorktree as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      handleWsMessage({
        type: 'create_session',
        name: 'WT Fail',
        workingDir: '/projects/app',
        useWorktree: true,
      } as WsClientMessage, ctx)

      await vi.waitFor(() => expect(ctx.sent.length).toBeGreaterThan(0))

      // Should send error message first, then session_created fallback
      expect(ctx.sent[0]).toMatchObject({ type: 'system_message', subtype: 'error' })
      expect(ctx.sent[1]).toMatchObject({ type: 'session_created', sessionId: 'wt-2' })
      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('wt-2')
    })
  })

  /* ---- join_session ---- */

  describe('join_session', () => {
    it('leaves previous, joins new, sends session_joined with history', () => {
      const session = mockSession({
        id: 'sess-2',
        name: 'Joined',
        workingDir: '/tmp/joined',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        outputHistory: [{ type: 'pong' } as WsServerMessage],
        claudeProcess: { isAlive: () => true } as any,
      })
      ;(ctx.sessions.join as ReturnType<typeof vi.fn>).mockReturnValue(session)

      handleWsMessage({ type: 'join_session', sessionId: 'sess-2' } as WsClientMessage, ctx)

      // Should have left the previous session (sess-1)
      expect(ctx.sessions.leave).toHaveBeenCalledWith('sess-1', ctx.ws)
      expect(ctx.sessions.join).toHaveBeenCalledWith('sess-2', ctx.ws)
      expect(ctx.clientSessions.get(ctx.ws)).toBe('sess-2')
      expect(ctx.sent).toHaveLength(1)
      const msg = ctx.sent[0] as any
      expect(msg.type).toBe('session_joined')
      expect(msg.sessionId).toBe('sess-2')
      expect(msg.sessionName).toBe('Joined')
      expect(msg.workingDir).toBe('/tmp/joined')
      expect(msg.active).toBe(true)
      expect(msg.model).toBe('claude-opus-4-6')
      expect(msg.permissionMode).toBe('plan')
      expect(msg.outputBuffer).toHaveLength(1)
    })

    it('sends error when session is not found', () => {
      ;(ctx.sessions.join as ReturnType<typeof vi.fn>).mockReturnValue(null)

      handleWsMessage({ type: 'join_session', sessionId: 'nonexistent' } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toBe('Session not found')
    })
  })

  /* ---- leave_session ---- */

  describe('leave_session', () => {
    it('leaves and deletes from clientSessions', () => {
      handleWsMessage({ type: 'leave_session' } as WsClientMessage, ctx)

      expect(ctx.sessions.leave).toHaveBeenCalledWith('sess-1', ctx.ws)
      expect(ctx.clientSessions.has(ctx.ws)).toBe(false)
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('session_left')
    })

    it('does nothing when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'leave_session' } as WsClientMessage, ctx)

      expect(ctx.sessions.leave).not.toHaveBeenCalled()
      expect(ctx.sent).toHaveLength(0)
    })
  })

  /* ---- start_claude ---- */

  describe('start_claude', () => {
    it('calls sessions.startClaude', () => {
      handleWsMessage({ type: 'start_claude' } as WsClientMessage, ctx)

      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('sess-1')
    })

    it('sends error when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'start_claude' } as WsClientMessage, ctx)

      expect(ctx.sessions.startClaude).not.toHaveBeenCalled()
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toBe('Not in a session')
    })
  })

  /* ---- stop ---- */

  describe('stop', () => {
    it('calls sessions.stopClaude', () => {
      handleWsMessage({ type: 'stop' } as WsClientMessage, ctx)

      expect(ctx.sessions.stopClaude).toHaveBeenCalledWith('sess-1')
    })

    it('does nothing when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'stop' } as WsClientMessage, ctx)

      expect(ctx.sessions.stopClaude).not.toHaveBeenCalled()
    })
  })

  /* ---- input ---- */

  describe('input', () => {
    it('echoes message to clients and sends to Claude', () => {
      const session = mockSession()
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(session)

      handleWsMessage({ type: 'input', data: 'hello' } as WsClientMessage, ctx)

      expect(ctx.sessions.addToHistory).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'user_echo',
        text: 'hello',
      }))
      expect(ctx.sessions.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'user_echo',
        text: 'hello',
      }))
      expect(ctx.sessions.sendInput).toHaveBeenCalledWith('sess-1', 'hello')
    })

    it('uses displayText when provided', () => {
      const session = mockSession()
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(session)

      handleWsMessage({ type: 'input', data: '/cmd arg', displayText: 'pretty text' } as WsClientMessage, ctx)

      expect(ctx.sessions.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'user_echo',
        text: 'pretty text',
      }))
      expect(ctx.sessions.sendInput).toHaveBeenCalledWith('sess-1', '/cmd arg')
    })

    it('does nothing when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'input', data: 'hello' } as WsClientMessage, ctx)

      expect(ctx.sessions.sendInput).not.toHaveBeenCalled()
      expect(ctx.sessions.broadcast).not.toHaveBeenCalled()
    })
  })

  /* ---- prompt_response ---- */

  describe('prompt_response', () => {
    it('routes to sessions.sendPromptResponse', () => {
      handleWsMessage({
        type: 'prompt_response',
        value: 'yes',
        requestId: 'req-42',
      } as WsClientMessage, ctx)

      expect(ctx.sessions.sendPromptResponse).toHaveBeenCalledWith('sess-1', 'yes', 'req-42')
    })

    it('does nothing without active session (logs warning)', () => {
      ctx.clientSessions.clear()
      handleWsMessage({
        type: 'prompt_response',
        value: 'yes',
        requestId: 'req-42',
      } as WsClientMessage, ctx)

      expect(ctx.sessions.sendPromptResponse).not.toHaveBeenCalled()
    })
  })

  /* ---- set_model ---- */

  describe('set_model', () => {
    it('accepts valid model', () => {
      handleWsMessage({ type: 'set_model', model: 'claude-sonnet-4-6' } as WsClientMessage, ctx)

      expect(ctx.sessions.setModel).toHaveBeenCalledWith('sess-1', 'claude-sonnet-4-6')
      expect(ctx.sent).toHaveLength(0)
    })

    it('rejects invalid model', () => {
      handleWsMessage({ type: 'set_model', model: 'gpt-4o' } as WsClientMessage, ctx)

      expect(ctx.sessions.setModel).not.toHaveBeenCalled()
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toContain('Invalid model')
      expect((ctx.sent[0] as any).message).toContain('gpt-4o')
    })

    it('does nothing without active session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'set_model', model: 'claude-sonnet-4-6' } as WsClientMessage, ctx)

      expect(ctx.sessions.setModel).not.toHaveBeenCalled()
    })
  })

  /* ---- set_permission_mode ---- */

  describe('set_permission_mode', () => {
    it('accepts valid permission mode', () => {
      handleWsMessage({ type: 'set_permission_mode', permissionMode: 'plan' } as WsClientMessage, ctx)

      expect(ctx.sessions.setPermissionMode).toHaveBeenCalledWith('sess-1', 'plan')
      expect(ctx.sent).toHaveLength(0)
    })

    it('accepts bypassPermissions mode', () => {
      handleWsMessage({ type: 'set_permission_mode', permissionMode: 'bypassPermissions' } as WsClientMessage, ctx)

      expect(ctx.sessions.setPermissionMode).toHaveBeenCalledWith('sess-1', 'bypassPermissions')
    })

    it('rejects invalid permission mode', () => {
      handleWsMessage({ type: 'set_permission_mode', permissionMode: 'hacker-mode' } as unknown as WsClientMessage, ctx)

      expect(ctx.sessions.setPermissionMode).not.toHaveBeenCalled()
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toContain('Invalid permission mode')
    })

    it('does nothing without active session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'set_permission_mode', permissionMode: 'plan' } as WsClientMessage, ctx)

      expect(ctx.sessions.setPermissionMode).not.toHaveBeenCalled()
    })
  })

  /* ---- get_diff ---- */

  describe('get_diff', () => {
    it('calls sessions.getDiff and sends result', async () => {
      const diffResult = { type: 'diff_result', files: [{ path: 'a.ts' }], summary: { added: 1 } }
      ;(ctx.sessions.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue(diffResult)

      handleWsMessage({ type: 'get_diff', scope: 'worktree' } as WsClientMessage, ctx)

      await vi.waitFor(() => expect(ctx.sent.length).toBeGreaterThan(0))

      expect(ctx.sessions.getDiff).toHaveBeenCalledWith('sess-1', 'worktree')
      expect(ctx.sent[0]).toEqual(diffResult)
    })

    it('sends diff_error when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'get_diff', scope: 'worktree' } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('diff_error')
      expect((ctx.sent[0] as any).message).toBe('Not in a session')
    })
  })

  /* ---- discard_changes ---- */

  describe('discard_changes', () => {
    it('calls sessions.discardChanges and sends result', async () => {
      const result = { type: 'diff_result', files: [], summary: {} }
      ;(ctx.sessions.discardChanges as ReturnType<typeof vi.fn>).mockResolvedValue(result)

      handleWsMessage({
        type: 'discard_changes',
        scope: 'worktree',
        paths: ['a.ts'],
        statuses: ['modified'],
      } as WsClientMessage, ctx)

      await vi.waitFor(() => expect(ctx.sent.length).toBeGreaterThan(0))

      expect(ctx.sessions.discardChanges).toHaveBeenCalledWith('sess-1', 'worktree', ['a.ts'], ['modified'])
      expect(ctx.sent[0]).toEqual(result)
    })

    it('sends diff_error when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({
        type: 'discard_changes',
        scope: 'worktree',
        paths: ['a.ts'],
        statuses: ['modified'],
      } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('diff_error')
      expect((ctx.sent[0] as any).message).toBe('Not in a session')
    })
  })

  /* ---- move_to_worktree ---- */

  describe('move_to_worktree', () => {
    it('sends error when not in a session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'move_to_worktree' } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toBe('Not in a session')
    })

    it('sends error when session not found', () => {
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(null)

      handleWsMessage({ type: 'move_to_worktree' } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toBe('Session not found')
    })

    it('sends error when session is already in a worktree', () => {
      const session = mockSession({ worktreePath: '/tmp/existing-wt' } as any)
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(session)

      handleWsMessage({ type: 'move_to_worktree' } as WsClientMessage, ctx)

      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('error')
      expect((ctx.sent[0] as any).message).toBe('Session is already in a worktree')
    })

    it('stops Claude, creates worktree, broadcasts, and restarts', async () => {
      const session = mockSession({ workingDir: '/projects/app' })
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(session)
      ;(ctx.sessions.createWorktree as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/wt-branch')

      handleWsMessage({ type: 'move_to_worktree' } as WsClientMessage, ctx)

      await vi.waitFor(() => expect(ctx.sessions.startClaude).toHaveBeenCalled())

      expect(ctx.sessions.stopClaudeAndWait).toHaveBeenCalledWith('sess-1')
      expect(ctx.sessions.createWorktree).toHaveBeenCalledWith('sess-1', '/projects/app')
      expect(ctx.sessions.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'worktree_created',
        worktreePath: '/tmp/wt-branch',
      }))
      expect(ctx.sessions.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'system_message',
        subtype: 'notification',
      }))
      expect(ctx.sessions.addToHistory).toHaveBeenCalled()
      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('sess-1')
    })

    it('sends error and restarts Claude when worktree creation returns null', async () => {
      const session = mockSession({ workingDir: '/projects/app' })
      ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(session)
      ;(ctx.sessions.createWorktree as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      handleWsMessage({ type: 'move_to_worktree' } as WsClientMessage, ctx)

      await vi.waitFor(() => expect(ctx.sessions.startClaude).toHaveBeenCalled())

      expect(ctx.sent.some(m => m.type === 'system_message' && (m as any).subtype === 'error')).toBe(true)
      expect(ctx.sessions.startClaude).toHaveBeenCalledWith('sess-1')
    })
  })
})
