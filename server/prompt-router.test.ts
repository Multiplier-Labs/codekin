/** Tests for PromptRouter — verifies auto-approval decision tree, control request handling, and prompt routing. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PromptRouter, type PromptRouterDeps } from './prompt-router.js'
import type { Session } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanManager() {
  return {
    reset: vi.fn(),
    onEnterPlanMode: vi.fn(),
    onTurnEnd: vi.fn(),
    onExitPlanModeRequested: vi.fn(() => null),
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
    claudeProcess: {
      isAlive: vi.fn(() => true),
      sendMessage: vi.fn(),
      sendControlResponse: vi.fn(),
    } as any,
    clients: new Set(['ws-client'] as any),
    outputHistory: [],
    claudeSessionId: null,
    permissionMode: 'default',
    allowedTools: [],
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

function makeDeps(session: Session, overrides: Partial<PromptRouterDeps> = {}): PromptRouterDeps {
  return {
    getSession: vi.fn(() => session),
    allSessions: vi.fn(function* () { yield session }),
    broadcast: vi.fn(),
    addToHistory: vi.fn(),
    globalBroadcast: vi.fn(),
    approvalManager: {
      checkAutoApproval: vi.fn(() => false),
      saveAlwaysAllow: vi.fn(),
      savePatternApproval: vi.fn(),
      derivePattern: vi.fn(() => null),
      NEVER_AUTO_APPROVE_TOOLS: new Set(),
    } as any,
    promptListeners: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptRouter', () => {
  let session: Session
  let deps: PromptRouterDeps
  let router: PromptRouter

  beforeEach(() => {
    session = makeSession()
    deps = makeDeps(session)
    router = new PromptRouter(deps)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // resolveAutoApproval
  // -------------------------------------------------------------------------

  describe('resolveAutoApproval', () => {
    it('returns "permissionMode" for file tools in acceptEdits mode', () => {
      session.permissionMode = 'acceptEdits'
      const result = router.resolveAutoApproval(session, 'Read', {})
      expect(result).toBe('permissionMode')
    })

    it('returns "permissionMode" for Edit in bypassPermissions mode', () => {
      session.permissionMode = 'bypassPermissions'
      expect(router.resolveAutoApproval(session, 'Edit', {})).toBe('permissionMode')
    })

    it('does not auto-approve file tools in default mode', () => {
      session.permissionMode = 'default'
      expect(router.resolveAutoApproval(session, 'Read', {})).toBe('prompt')
    })

    it('returns "registry" when approval manager matches', () => {
      ;(deps.approvalManager.checkAutoApproval as any).mockReturnValue(true)
      const result = router.resolveAutoApproval(session, 'Bash', { command: 'npm test' })
      expect(result).toBe('registry')
    })

    it('returns "session" when tool matches session allowedTools', () => {
      session.allowedTools = ['WebFetch']
      const result = router.resolveAutoApproval(session, 'WebFetch', {})
      expect(result).toBe('session')
    })

    it('returns "session" for parameterized allowedTools pattern', () => {
      session.allowedTools = ['Bash(curl:*)']
      const result = router.resolveAutoApproval(session, 'Bash', { command: 'curl https://example.com' })
      expect(result).toBe('session')
    })

    it('does not match parameterized pattern when prefix differs', () => {
      session.allowedTools = ['Bash(curl:*)']
      const result = router.resolveAutoApproval(session, 'Bash', { command: 'wget https://example.com' })
      expect(result).toBe('prompt')
    })

    it('returns "headless" for webhook session with no clients', () => {
      session.source = 'webhook'
      session.clients = new Set() as any
      const result = router.resolveAutoApproval(session, 'Bash', { command: 'npm test' })
      expect(result).toBe('headless')
    })

    it('returns "headless" for orchestrator session with no clients', () => {
      session.source = 'orchestrator'
      session.clients = new Set() as any
      expect(router.resolveAutoApproval(session, 'Bash', {})).toBe('headless')
    })

    it('returns "prompt" for manual session with no clients', () => {
      session.source = 'manual'
      session.clients = new Set() as any
      expect(router.resolveAutoApproval(session, 'Bash', {})).toBe('prompt')
    })

    it('returns "prompt" when nothing matches', () => {
      expect(router.resolveAutoApproval(session, 'Bash', { command: 'rm -rf /' })).toBe('prompt')
    })
  })

  // -------------------------------------------------------------------------
  // requestToolApproval — auto-approval paths
  // -------------------------------------------------------------------------

  describe('requestToolApproval', () => {
    it('auto-approves via permissionMode', async () => {
      session.permissionMode = 'acceptEdits'
      const result = await router.requestToolApproval('sess-1', 'Write', { file_path: '/test.ts' })
      expect(result).toEqual({ allow: true, always: false })
    })

    it('auto-approves via registry', async () => {
      ;(deps.approvalManager.checkAutoApproval as any).mockReturnValue(true)
      const result = await router.requestToolApproval('sess-1', 'Bash', { command: 'npm test' })
      expect(result).toEqual({ allow: true, always: true })
    })

    it('auto-approves via session allowedTools', async () => {
      session.allowedTools = ['WebFetch']
      const result = await router.requestToolApproval('sess-1', 'WebFetch', {})
      expect(result).toEqual({ allow: true, always: false })
    })

    it('auto-approves headless session', async () => {
      session.source = 'webhook'
      session.clients = new Set() as any
      const result = await router.requestToolApproval('sess-1', 'Bash', { command: 'ls' })
      expect(result).toEqual({ allow: true, always: false })
    })

    it('returns deny for unknown session', async () => {
      ;(deps.getSession as any).mockReturnValue(undefined)
      const result = await router.requestToolApproval('no-exist', 'Bash', {})
      expect(result).toEqual({ allow: false, always: false })
    })

    it('broadcasts prompt to clients when approval needed', async () => {
      // Don't await — just check the broadcast happened
      const promise = router.requestToolApproval('sess-1', 'Bash', { command: 'npm test' })

      // Should have broadcast a prompt
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'prompt',
        promptType: 'permission',
        toolName: 'Bash',
      }))

      // Resolve the pending approval
      const approvalEntry = Array.from(session.pendingToolApprovals.values())[0]
      approvalEntry.resolve({ allow: true, always: false })

      await promise
    })

    it('alwaysAllow persists via approval manager', async () => {
      const promise = router.requestToolApproval('sess-1', 'Bash', { command: 'npm test' })

      // Simulate "always_allow" response through sendPromptResponse
      const approvalEntry = Array.from(session.pendingToolApprovals.values())[0]
      router.sendPromptResponse('sess-1', 'always_allow', approvalEntry.requestId)

      const result = await promise
      expect(result.allow).toBe(true)
      expect(result.always).toBe(true)
      expect(deps.approvalManager.saveAlwaysAllow).toHaveBeenCalledWith('/repos/test', 'Bash', { command: 'npm test' })
    })

    it('deny resolves with allow=false', async () => {
      const promise = router.requestToolApproval('sess-1', 'Bash', { command: 'rm -rf /' })

      const approvalEntry = Array.from(session.pendingToolApprovals.values())[0]
      router.sendPromptResponse('sess-1', 'deny', approvalEntry.requestId)

      const result = await promise
      expect(result.allow).toBe(false)
      expect(result.always).toBe(false)
    })

    it('dismisses prompt from pendingToolApprovals after resolution', async () => {
      const promise = router.requestToolApproval('sess-1', 'Bash', { command: 'ls' })

      const approvalEntry = Array.from(session.pendingToolApprovals.values())[0]
      const reqId = approvalEntry.requestId
      router.sendPromptResponse('sess-1', 'allow', reqId)

      await promise

      expect(session.pendingToolApprovals.has(reqId)).toBe(false)
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({ type: 'prompt_dismiss', requestId: reqId }))
    })
  })

  // -------------------------------------------------------------------------
  // onControlRequestEvent
  // -------------------------------------------------------------------------

  describe('onControlRequestEvent', () => {
    it('rejects invalid requestId', () => {
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'invalid id with spaces!!!!!!!!!', 'Bash', {})

      expect(cp.sendControlResponse).not.toHaveBeenCalled()
    })

    it('auto-approves when resolveAutoApproval matches', () => {
      session.permissionMode = 'acceptEdits'
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'req-1', 'Read', {})

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-1', 'allow')
    })

    it('auto-approves when PreToolUse hook already handles the tool', () => {
      session.pendingToolApprovals.set('hook-req', {
        resolve: vi.fn(),
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        requestId: 'hook-req',
      })
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'ctrl-req', 'Bash', { command: 'ls' })

      expect(cp.sendControlResponse).toHaveBeenCalledWith('ctrl-req', 'allow')
    })

    it('broadcasts prompt when manual approval needed', () => {
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'req-42', 'Bash', { command: 'rm -rf /' })

      expect(session.pendingControlRequests.has('req-42')).toBe(true)
      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'prompt',
        promptType: 'permission',
        toolName: 'Bash',
        requestId: 'req-42',
      }))
    })

    it('broadcasts globally when no clients connected', () => {
      session.clients = new Set() as any
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'req-99', 'Bash', { command: 'ls' })

      expect(deps.globalBroadcast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'prompt',
        sessionId: 'sess-1',
        sessionName: 'test-session',
      }))
    })

    it('notifies prompt listeners', () => {
      const listener = vi.fn()
      deps.promptListeners.push(listener)
      const cp = { sendControlResponse: vi.fn() } as any

      router.onControlRequestEvent(cp, session, 'sess-1', 'req-1', 'Bash', {})

      expect(listener).toHaveBeenCalledWith('sess-1', 'permission', 'Bash', 'req-1')
    })
  })

  // -------------------------------------------------------------------------
  // sendPromptResponse — control request path
  // -------------------------------------------------------------------------

  describe('sendPromptResponse (control requests)', () => {
    it('resolves control request with allow', () => {
      session.pendingControlRequests.set('cr-1', {
        requestId: 'cr-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      })

      router.sendPromptResponse('sess-1', 'allow', 'cr-1')

      expect(session.claudeProcess!.sendControlResponse).toHaveBeenCalledWith('cr-1', 'allow')
      expect(session.pendingControlRequests.has('cr-1')).toBe(false)
    })

    it('resolves control request with deny', () => {
      session.pendingControlRequests.set('cr-2', {
        requestId: 'cr-2',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
      })

      router.sendPromptResponse('sess-1', 'deny', 'cr-2')

      expect(session.claudeProcess!.sendControlResponse).toHaveBeenCalledWith('cr-2', 'deny')
    })

    it('persists always_allow for control requests', () => {
      session.pendingControlRequests.set('cr-3', {
        requestId: 'cr-3',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      })

      router.sendPromptResponse('sess-1', 'always_allow', 'cr-3')

      expect(deps.approvalManager.saveAlwaysAllow).toHaveBeenCalledWith('/repos/test', 'Bash', { command: 'npm test' })
    })

    it('infers sole pending prompt when no requestId given', () => {
      session.pendingControlRequests.set('cr-only', {
        requestId: 'cr-only',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      })

      router.sendPromptResponse('sess-1', 'allow')

      expect(session.claudeProcess!.sendControlResponse).toHaveBeenCalledWith('cr-only', 'allow')
    })

    it('rejects when multiple pending prompts and no requestId', () => {
      session.pendingControlRequests.set('cr-a', { requestId: 'cr-a', toolName: 'Bash', toolInput: {} })
      session.pendingControlRequests.set('cr-b', { requestId: 'cr-b', toolName: 'Read', toolInput: {} })

      router.sendPromptResponse('sess-1', 'allow')

      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'system_message',
        subtype: 'error',
        text: expect.stringContaining('multiple prompts pending'),
      }))
    })

    it('falls back to sendMessage when no pending prompts match', () => {
      router.sendPromptResponse('sess-1', 'hello world')

      expect(session.claudeProcess!.sendMessage).toHaveBeenCalledWith('hello world')
    })
  })

  // -------------------------------------------------------------------------
  // summarizeToolPermission
  // -------------------------------------------------------------------------

  describe('summarizeToolPermission', () => {
    it('formats Bash commands', () => {
      const result = router.summarizeToolPermission('Bash', { command: 'echo hello\necho world' })
      expect(result).toContain('$ echo hello...')
    })

    it('formats Read with file path', () => {
      expect(router.summarizeToolPermission('Read', { file_path: '/src/foo.ts' })).toContain('/src/foo.ts')
    })

    it('formats unknown tools', () => {
      expect(router.summarizeToolPermission('WebFetch', {})).toBe('Allow WebFetch?')
    })
  })

  // -------------------------------------------------------------------------
  // getPendingPrompts
  // -------------------------------------------------------------------------

  describe('getPendingPrompts', () => {
    it('returns empty when no pending prompts', () => {
      expect(router.getPendingPrompts()).toEqual([])
    })

    it('returns pending tool approvals and control requests', () => {
      session.pendingToolApprovals.set('ta-1', {
        resolve: vi.fn(),
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        requestId: 'ta-1',
      })
      session.pendingControlRequests.set('cr-1', {
        requestId: 'cr-1',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'What color?' }] },
      })

      const results = router.getPendingPrompts()
      expect(results).toHaveLength(1)
      expect(results[0].prompts).toHaveLength(2)
      expect(results[0].prompts[0]).toMatchObject({ requestId: 'ta-1', promptType: 'permission', toolName: 'Bash' })
      expect(results[0].prompts[1]).toMatchObject({ requestId: 'cr-1', promptType: 'question', toolName: 'AskUserQuestion' })
    })
  })

  // -------------------------------------------------------------------------
  // onPromptEvent
  // -------------------------------------------------------------------------

  describe('onPromptEvent', () => {
    it('broadcasts prompt and stores in pendingControlRequests when requestId present', () => {
      router.onPromptEvent(session, 'question', 'Pick a color', [{ label: 'Red', value: 'red' }], false, undefined, undefined, 'req-prompt-1', undefined)

      expect(deps.broadcast).toHaveBeenCalledWith(session, expect.objectContaining({
        type: 'prompt',
        promptType: 'question',
        requestId: 'req-prompt-1',
      }))
      expect(session.pendingControlRequests.has('req-prompt-1')).toBe(true)
    })

    it('notifies prompt listeners', () => {
      const listener = vi.fn()
      deps.promptListeners.push(listener)

      router.onPromptEvent(session, 'permission', 'Allow?', [], false, 'Bash', undefined, 'req-2', undefined)

      expect(listener).toHaveBeenCalledWith('sess-1', 'permission', 'Bash', 'req-2')
    })
  })
})
