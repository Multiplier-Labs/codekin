import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    _apiRetryCount: 0,
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
      get: vi.fn().mockReturnValue(session),
      sendInput: vi.fn(),
      sendPromptResponse: vi.fn(),
      setModel: vi.fn().mockReturnValue(true),
      setPermissionMode: vi.fn().mockReturnValue(true),
      addToHistory: vi.fn(),
      broadcast: vi.fn(),
      getDiff: vi.fn().mockResolvedValue({ type: 'diff_result' }),
      discardChanges: vi.fn().mockResolvedValue({ type: 'diff_result' }),
      createWorktree: vi.fn().mockResolvedValue(null),
    } as unknown as WsHandlerContext['sessions'],
    clientSessions: new Map([['ws-key' as unknown as WsHandlerContext['ws'], 'sess-1']]),
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
      expect((ctx.sent[0] as { message: string }).message).toContain('Invalid permission mode')
    })

    it('does nothing without active session', () => {
      ctx.clientSessions.clear()
      handleWsMessage({ type: 'set_permission_mode', permissionMode: 'plan' } as WsClientMessage, ctx)
      expect(ctx.sessions.setPermissionMode).not.toHaveBeenCalled()
    })
  })

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
      expect((ctx.sent[0] as { message: string }).message).toContain('Invalid model')
    })
  })

  describe('join_session', () => {
    it('includes model and permissionMode in session_joined', () => {
      const session = mockSession({ model: 'claude-opus-4-6', permissionMode: 'plan' })
      ;(ctx.sessions.join as ReturnType<typeof vi.fn>).mockReturnValue(session)
      handleWsMessage({ type: 'join_session', sessionId: 'sess-1' } as WsClientMessage, ctx)
      expect(ctx.sent).toHaveLength(1)
      const joinedMsg = ctx.sent[0] as { type: string; model?: string; permissionMode?: string }
      expect(joinedMsg.type).toBe('session_joined')
      expect(joinedMsg.model).toBe('claude-opus-4-6')
      expect(joinedMsg.permissionMode).toBe('plan')
    })
  })

  describe('ping', () => {
    it('responds with pong', () => {
      handleWsMessage({ type: 'ping' } as WsClientMessage, ctx)
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0].type).toBe('pong')
    })
  })
})
