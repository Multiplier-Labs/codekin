/** Tests for useChatSocket hook — verifies WebSocket lifecycle and message handling with mocked WebSocket and ccApi (checkAuthSession, redirectToLogin). */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WsServerMessage, ChatMessage } from '../types'

// Mock checkAuthSession to resolve immediately (prevents async reconnect blocking with fake timers)
vi.mock('../lib/ccApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ccApi')>()
  return {
    ...actual,
    checkAuthSession: vi.fn().mockResolvedValue(true),
    redirectToLogin: vi.fn(),
  }
})

/** Narrow a ChatMessage to a specific type variant for type-safe property access. */
function msgAs<T extends ChatMessage['type']>(
  msg: ChatMessage,
  type: T,
): Extract<ChatMessage, { type: T }> {
  expect(msg.type).toBe(type)
  return msg as Extract<ChatMessage, { type: T }>
}

/* ------------------------------------------------------------------ */
/*  Mock WebSocket                                                     */
/* ------------------------------------------------------------------ */

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  url: string
  onopen: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) { this.sent.push(data) }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent)
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  simulateMessage(msg: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent)
  }

  static reset() { MockWebSocket.instances = [] }
  static latest(): MockWebSocket { return MockWebSocket.instances[MockWebSocket.instances.length - 1] }
}

/* ------------------------------------------------------------------ */
/*  Minimal renderHook                                                 */
/* ------------------------------------------------------------------ */

function renderHook<T>(hookFn: () => T): {
  result: { current: T }
  unmount: () => void
} {
  const result = { current: undefined as T }
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot>

  function TestComponent() {
    result.current = hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    result,
    unmount: () => act(() => root.unmount()),
  }
}

/* ------------------------------------------------------------------ */
/*  Setup / Teardown                                                   */
/* ------------------------------------------------------------------ */

const origWebSocket = globalThis.WebSocket
const origRAF = globalThis.requestAnimationFrame
const origCAF = globalThis.cancelAnimationFrame

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.reset()

  // @ts-expect-error mock WebSocket
  globalThis.WebSocket = MockWebSocket
  // Also set the OPEN constant that the hook checks against (WebSocket.OPEN)
  // @ts-expect-error mock constant
  globalThis.WebSocket.OPEN = MockWebSocket.OPEN
  // @ts-expect-error mock constant
  globalThis.WebSocket.CONNECTING = MockWebSocket.CONNECTING

  // Mock requestAnimationFrame — run callback via setTimeout(0) so fake timers control it
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number
  }
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  globalThis.WebSocket = origWebSocket
  globalThis.requestAnimationFrame = origRAF
  globalThis.cancelAnimationFrame = origCAF
})

/* ------------------------------------------------------------------ */
/*  Import hook (must be after mock setup for correct module load)      */
/* ------------------------------------------------------------------ */

// Dynamic import so mocks are in place; we use a top-level import since
// the hook reads WebSocket at call-time, not import-time.
import { useChatSocket } from './useChatSocket'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function setup(overrides: Partial<Parameters<typeof useChatSocket>[0]> = {}) {
  const callbacks = {
    token: 'test-token',
    onSessionCreated: vi.fn(),
    onSessionJoined: vi.fn(),
    onSessionRenamed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
  const { result, unmount } = renderHook(() => useChatSocket(callbacks))
  return { result, unmount, callbacks }
}

function setupConnected(overrides: Partial<Parameters<typeof useChatSocket>[0]> = {}) {
  const ctx = setup(overrides)
  act(() => MockWebSocket.latest().simulateOpen())
  return ctx
}

function sentMessages(ws: MockWebSocket) {
  return ws.sent.map(s => JSON.parse(s))
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('useChatSocket hook', () => {
  describe('connection lifecycle', () => {
    it('connects on mount when token is provided', () => {
      const { unmount } = setup()
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.latest().url).not.toContain('token=')  // token sent via message, not URL
      unmount()
    })

    it('does not connect when token is empty', () => {
      const { unmount } = setup({ token: '' })
      expect(MockWebSocket.instances).toHaveLength(0)
      unmount()
    })

    it('transitions to connecting then connected', () => {
      const { result, unmount } = setup()
      expect(result.current.connState).toBe('connecting')
      act(() => MockWebSocket.latest().simulateOpen())
      expect(result.current.connState).toBe('connected')
      unmount()
    })

    it('transitions to disconnected on close', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateClose())
      expect(result.current.connState).toBe('disconnected')
      unmount()
    })

    it('reconnects with exponential backoff on unintentional close', async () => {
      const { unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateClose())
      // Flush the checkAuthSession() promise so the reconnect timer gets scheduled
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(MockWebSocket.instances).toHaveLength(1)

      // After 1s (initial backoff), should reconnect
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(MockWebSocket.instances).toHaveLength(2)

      // Close again without opening — backoff doubles inside the timer callback
      // The timer fires at backoff.current (was 1000), then sets backoff *= 2 = 2000
      // So the *next* reconnect scheduled at 2000ms
      act(() => MockWebSocket.latest().simulateClose())
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(MockWebSocket.instances).toHaveLength(2) // not yet (needs 2000ms)
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(MockWebSocket.instances).toHaveLength(3)
      unmount()
    })

    it('does not reconnect on intentional disconnect', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.disconnect())
      expect(result.current.connState).toBe('disconnected')
      act(() => { vi.advanceTimersByTime(60000) })
      expect(MockWebSocket.instances).toHaveLength(1) // no new connections
      unmount()
    })

    it('starts ping interval on open', () => {
      const { unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      // First message is the auth token sent on open
      expect(sentMessages(ws)).toEqual([{ type: 'auth', token: 'test-token' }])
      act(() => { vi.advanceTimersByTime(30000) })
      expect(sentMessages(ws)[1].type).toBe('ping')
      unmount()
    })

    it('resets backoff on successful connection', async () => {
      const { unmount } = setupConnected()
      // Close and reconnect twice to increase backoff
      act(() => MockWebSocket.latest().simulateClose())
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      act(() => MockWebSocket.latest().simulateOpen())
      act(() => MockWebSocket.latest().simulateClose())
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      // Now open successfully — backoff should reset
      act(() => MockWebSocket.latest().simulateOpen())
      act(() => MockWebSocket.latest().simulateClose())
      // Should reconnect after 1s again (reset backoff)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(MockWebSocket.instances).toHaveLength(4)
      unmount()
    })

    it('disconnects cleanly on unmount', () => {
      const { unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      unmount()
      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    })
  })

  describe('session lifecycle', () => {
    it('session_created resets state and calls callback', () => {
      const { result, callbacks, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      expect(callbacks.onSessionCreated).toHaveBeenCalledWith('s1')
      expect(result.current.messages).toEqual([])
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.tasks).toEqual([])
      unmount()
    })

    it('session_joined rebuilds from outputBuffer', () => {
      const { result, callbacks, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_joined',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
        active: true,
        outputBuffer: [
          { type: 'user_echo', text: 'Hi' },
          { type: 'output', data: 'Hello' },
          { type: 'result' },
        ],
      } as WsServerMessage))
      expect(callbacks.onSessionJoined).toHaveBeenCalledWith('s1')
      expect(result.current.messages).toHaveLength(2) // user + assistant
      expect(result.current.messages[0].type).toBe('user')
      expect(result.current.messages[1].type).toBe('assistant')
      unmount()
    })

    it('session_joined with empty outputBuffer', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_joined',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
        active: true,
        outputBuffer: [],
      } as WsServerMessage))
      expect(result.current.messages).toEqual([])
      unmount()
    })

    it('session_joined restores planning mode and tasks from buffer', () => {
      const { result, unmount } = setupConnected()
      const tasks = [{ id: '1', subject: 'Fix bug', status: 'in_progress' as const }]
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_joined',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
        active: true,
        outputBuffer: [
          { type: 'planning_mode', active: true },
          { type: 'todo_update', tasks },
        ],
      } as WsServerMessage))
      expect(result.current.planningMode).toBe(true)
      expect(result.current.tasks).toEqual(tasks)
      unmount()
    })

    it('joinSession sends join_session message', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.joinSession('s1'))
      expect(sentMessages(MockWebSocket.latest()).pop()).toEqual({
        type: 'join_session',
        sessionId: 's1',
      })
      unmount()
    })

    it('createSession sends create_session message', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.createSession('My Session', '/home/dev'))
      expect(sentMessages(MockWebSocket.latest()).pop()).toEqual({
        type: 'create_session',
        name: 'My Session',
        workingDir: '/home/dev',
      })
      unmount()
    })

    it('leaveSession sends leave_session and clears processing', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.leaveSession())
      expect(sentMessages(MockWebSocket.latest()).pop()).toEqual({
        type: 'leave_session',
      })
      expect(result.current.isProcessing).toBe(false)
      unmount()
    })

    it('session_deleted appends system error message', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_deleted',
        message: 'Session was deleted',
      } as WsServerMessage))
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('system')
      expect(msgAs(result.current.messages[0], 'system').subtype).toBe('error')
      unmount()
    })
  })

  describe('message handling', () => {
    it('output batches text via requestAnimationFrame', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'output', data: 'Hello',
      } as WsServerMessage))
      // Flush rAF mock (setTimeout 0)
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages).toHaveLength(1)
      expect(msgAs(result.current.messages[0], 'assistant').text).toBe('Hello')
      expect(msgAs(result.current.messages[0], 'assistant').complete).toBe(false)
      unmount()
    })

    it('consecutive outputs are batched together', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => {
        ws.simulateMessage({ type: 'output', data: 'Hello' } as WsServerMessage)
        ws.simulateMessage({ type: 'output', data: ' world' } as WsServerMessage)
      })
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages).toHaveLength(1)
      expect(msgAs(result.current.messages[0], 'assistant').text).toBe('Hello world')
      unmount()
    })

    it('result flushes pending text and marks complete', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => {
        ws.simulateMessage({ type: 'output', data: 'Done' } as WsServerMessage)
      })
      act(() => { vi.advanceTimersByTime(1) })
      act(() => {
        ws.simulateMessage({ type: 'result' } as WsServerMessage)
      })
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.thinkingSummary).toBeNull()
      expect(msgAs(result.current.messages[0], 'assistant').complete).toBe(true)
      unmount()
    })

    it('result with unflushed pending text flushes synchronously', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      // Send output + result without flushing rAF in between
      act(() => {
        ws.simulateMessage({ type: 'output', data: 'Quick' } as WsServerMessage)
        ws.simulateMessage({ type: 'result' } as WsServerMessage)
      })
      // The result handler flushes pending text synchronously
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages.length).toBeGreaterThanOrEqual(1)
      const assistantMsg = result.current.messages.find(m => m.type === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(msgAs(assistantMsg!, 'assistant').text).toBe('Quick')
      unmount()
    })

    it('thinking sets thinkingSummary', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'thinking', summary: 'analyzing code',
      } as WsServerMessage))
      expect(result.current.thinkingSummary).toBe('analyzing code')
      unmount()
    })

    it('output clears thinkingSummary', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({ type: 'thinking', summary: 'thinking' } as WsServerMessage))
      expect(result.current.thinkingSummary).toBe('thinking')
      act(() => ws.simulateMessage({ type: 'output', data: 'x' } as WsServerMessage))
      expect(result.current.thinkingSummary).toBeNull()
      unmount()
    })

    it('tool_active clears thinkingSummary and flushes text', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({ type: 'thinking', summary: 'thinking' } as WsServerMessage))
      act(() => ws.simulateMessage({ type: 'output', data: 'text' } as WsServerMessage))
      act(() => ws.simulateMessage({ type: 'tool_active', toolName: 'Bash' } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.thinkingSummary).toBeNull()
      // Should have assistant message + tool_group
      const types = result.current.messages.map(m => m.type)
      expect(types).toContain('assistant')
      expect(types).toContain('tool_group')
      unmount()
    })

    it('tool_done flushes text before processing', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({ type: 'tool_active', toolName: 'Read' } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      act(() => ws.simulateMessage({ type: 'tool_done', toolName: 'Read', summary: 'file.ts' } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      const tg = msgAs(result.current.messages.find(m => m.type === 'tool_group')!, 'tool_group')
      expect(tg).toBeDefined()
      expect(tg.tools[0].active).toBe(false)
      expect(tg.tools[0].summary).toBe('file.ts')
      unmount()
    })

    it('tool_output flushes text and appends output', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'tool_output', content: 'file contents', isError: false,
      } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('tool_output')
      unmount()
    })

    it('system_message flushes text before appending', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'system_message', subtype: 'init', text: 'Ready', model: 'opus',
      } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('system')
      unmount()
    })

    it('user_echo flushes text before appending', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({ type: 'output', data: 'partial' } as WsServerMessage))
      act(() => ws.simulateMessage({ type: 'user_echo', text: 'Hi' } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      // Should have assistant (flushed) + user
      expect(result.current.messages.length).toBeGreaterThanOrEqual(2)
      expect(result.current.messages[result.current.messages.length - 1].type).toBe('user')
      unmount()
    })

    it('planning_mode updates state and appends message', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'planning_mode', active: true,
      } as WsServerMessage))
      expect(result.current.planningMode).toBe(true)
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('planning_mode')
      unmount()
    })

    it('todo_update sets tasks', () => {
      const { result, unmount } = setupConnected()
      const tasks = [{ id: '1', subject: 'Test', status: 'pending' as const }]
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'todo_update', tasks,
      } as WsServerMessage))
      expect(result.current.tasks).toEqual(tasks)
      unmount()
    })

    it('claude_started shows Session started message', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'claude_started', sessionId: 's1',
      } as WsServerMessage))
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('system')
      expect((result.current.messages[0] as any).text).toBe('Session started')
      unmount()
    })

    it('error calls onError callback', () => {
      const { callbacks, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'error', message: 'Something broke',
      } as WsServerMessage))
      expect(callbacks.onError).toHaveBeenCalledWith('Something broke')
      unmount()
    })

    it('session_name_update calls onSessionRenamed', () => {
      const { callbacks, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_name_update', sessionId: 's1', name: 'New Name',
      } as WsServerMessage))
      expect(callbacks.onSessionRenamed).toHaveBeenCalledWith('s1', 'New Name')
      unmount()
    })

    it('ignores malformed JSON messages', () => {
      const { result, unmount } = setupConnected()
      // Send invalid JSON — should not throw or change state
      act(() => {
        MockWebSocket.latest().onmessage?.({ data: 'not-json{{{' })
      })
      expect(result.current.messages).toEqual([])
      unmount()
    })

    it('connected message is no-op', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'connected',
        connectionId: 'c1',
        claudeAvailable: true,
        claudeVersion: '1.0',
        apiKeySet: true,
      } as WsServerMessage))
      expect(result.current.messages).toEqual([])
      unmount()
    })

    it('info is a no-op', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => {
        ws.simulateMessage({ type: 'info', message: 'hi' } as WsServerMessage)
      })
      expect(result.current.messages).toEqual([])
      unmount()
    })
  })

  describe('prompt handling', () => {
    it('prompt sets prompt state', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      // Join a session first so currentSessionId is set
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => ws.simulateMessage({
        type: 'prompt',
        promptType: 'permission',
        question: 'Allow Bash?',
        options: [{ label: 'Yes', value: 'yes' }],
        multiSelect: false,
        requestId: 'r1',
      } as WsServerMessage))
      expect(result.current.activePrompt).not.toBeNull()
      expect(result.current.activePrompt!.options).toEqual([{ label: 'Yes', value: 'yes' }])
      expect(result.current.activePrompt!.question).toBe('Allow Bash?')
      expect(result.current.activePrompt!.promptType).toBe('permission')
      expect(result.current.activePrompt!.multiSelect).toBe(false)
      unmount()
    })

    it('prompt marks session as waiting', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => ws.simulateMessage({
        type: 'prompt',
        promptType: 'question',
        question: 'Choose:',
        options: [{ label: 'A', value: 'a' }],
      } as WsServerMessage))
      expect(result.current.waitingSessions).toEqual({ s1: true })
      unmount()
    })

    it('sendPromptResponse sends response and clears prompt state', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => ws.simulateMessage({
        type: 'prompt',
        promptType: 'permission',
        question: 'Allow?',
        options: [{ label: 'Yes', value: 'yes' }],
        requestId: 'r1',
      } as WsServerMessage))
      act(() => result.current.sendPromptResponse('yes'))
      const sent = sentMessages(ws).pop()
      expect(sent.type).toBe('prompt_response')
      expect(sent.value).toBe('yes')
      expect(sent.requestId).toBe('r1')
      expect(result.current.activePrompt).toBeNull()
      unmount()
    })
  })

  describe('sendInput', () => {
    it('sends input message and sets processing', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.sendInput('Hello'))
      const sent = sentMessages(MockWebSocket.latest()).pop()
      expect(sent.type).toBe('input')
      expect(sent.data).toBe('Hello')
      expect(result.current.isProcessing).toBe(true)
      unmount()
    })

    it('sends input with displayText', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.sendInput('/validate-gemini', 'Validate with Gemini'))
      const sent = sentMessages(MockWebSocket.latest()).pop()
      expect(sent.data).toBe('/validate-gemini')
      expect(sent.displayText).toBe('Validate with Gemini')
      unmount()
    })

    it('clears prompt state and marks session not waiting', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => ws.simulateMessage({
        type: 'prompt',
        promptType: 'question',
        question: 'Choose:',
        options: [{ label: 'A', value: 'a' }],
      } as WsServerMessage))
      expect(result.current.waitingSessions).toEqual({ s1: true })
      act(() => result.current.sendInput('response'))
      expect(result.current.activePrompt).toBeNull()
      expect(result.current.waitingSessions).toEqual({})
      unmount()
    })
  })

  describe('clearMessages', () => {
    it('empties the message list', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'user_echo', text: 'Hi',
      } as WsServerMessage))
      act(() => { vi.advanceTimersByTime(1) })
      expect(result.current.messages.length).toBeGreaterThan(0)
      act(() => result.current.clearMessages())
      expect(result.current.messages).toEqual([])
      unmount()
    })
  })

  describe('claude_stopped and exit', () => {
    it('claude_stopped resets processing state', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.sendInput('test'))
      expect(result.current.isProcessing).toBe(true)
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'claude_stopped',
      } as WsServerMessage))
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.thinkingSummary).toBeNull()
      unmount()
    })

    it('exit resets processing and clears prompt state', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => ws.simulateMessage({
        type: 'prompt',
        promptType: 'permission',
        question: 'Allow?',
        options: [{ label: 'Yes', value: 'yes' }],
      } as WsServerMessage))
      expect(result.current.activePrompt).not.toBeNull()
      act(() => ws.simulateMessage({
        type: 'exit', code: 0, signal: null,
      } as WsServerMessage))
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.activePrompt).toBeNull()
      unmount()
    })
  })

  describe('restoreSession', () => {
    it('sends ping when WS is open and rejoins on pong', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      // Create a session first
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => result.current.restoreSession())
      const sent = sentMessages(ws)
      expect(sent[sent.length - 1].type).toBe('ping')

      // Simulate pong — should rejoin session
      act(() => ws.simulateMessage({ type: 'pong' } as WsServerMessage))
      const sentAfter = sentMessages(ws)
      expect(sentAfter[sentAfter.length - 1]).toEqual({
        type: 'join_session',
        sessionId: 's1',
      })
      unmount()
    })

    it('force-closes zombie connection on pong timeout', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => result.current.restoreSession())
      // First ping sent immediately; retries at 2s and 4s; zombie close at 6s
      act(() => { vi.advanceTimersByTime(2000) })
      expect(ws.readyState).toBe(MockWebSocket.OPEN) // still alive after first timeout
      act(() => { vi.advanceTimersByTime(2000) })
      expect(ws.readyState).toBe(MockWebSocket.OPEN) // still alive after second timeout
      act(() => { vi.advanceTimersByTime(2000) })
      expect(ws.readyState).toBe(MockWebSocket.CLOSED) // closed after all 3 retries exhausted
      unmount()
    })

    it('reconnects immediately when WS is closed', async () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      // Force WS closed without triggering onclose (simulate stale ref)
      ws.readyState = MockWebSocket.CLOSED
      ws.onclose = null
      // @ts-expect-error clear ref to simulate closed state
      act(() => {
        // Close the ws manually to simulate it being null/closed
        ws.readyState = MockWebSocket.CLOSED
      })
      // restoreSession should trigger reconnect (checkAuthSession promise must resolve)
      await act(async () => {
        result.current.restoreSession()
        await vi.advanceTimersByTimeAsync(0)
      })
      // Since WS readyState isn't OPEN or CONNECTING, it should call connect()
      // This creates a new WebSocket instance
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)
      unmount()
    })

    it('is a no-op when WS is in CONNECTING state', () => {
      const { result, unmount } = setup() // not opened yet — still CONNECTING
      const instanceCount = MockWebSocket.instances.length
      act(() => result.current.restoreSession())
      expect(MockWebSocket.instances.length).toBe(instanceCount) // no new connections
      unmount()
    })

    it('guards against rapid concurrent restore attempts', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => ws.simulateMessage({
        type: 'session_created',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
      } as WsServerMessage))
      act(() => result.current.restoreSession())
      const sentCount = ws.sent.length
      // Second call within 3s guard should be ignored
      act(() => result.current.restoreSession())
      expect(ws.sent.length).toBe(sentCount) // no extra ping
      unmount()
    })
  })

  describe('reconnect', () => {
    it('reconnect() creates new connection', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.disconnect())
      expect(result.current.connState).toBe('disconnected')
      act(() => result.current.reconnect())
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)
      unmount()
    })
  })

  describe('send', () => {
    it('sends message when connected', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.send({ type: 'ping' }))
      const ws = MockWebSocket.latest()
      expect(sentMessages(ws).pop()).toEqual({ type: 'ping' })
      unmount()
    })

    it('does not send when disconnected', () => {
      const { result, unmount } = setup({ token: '' })
      act(() => result.current.send({ type: 'ping' }))
      // No WebSocket created, so nothing sent
      expect(MockWebSocket.instances).toHaveLength(0)
      unmount()
    })
  })

  describe('permission mode', () => {
    it('setPermissionMode sends message and updates local state', () => {
      const { result, unmount } = setupConnected()
      const ws = MockWebSocket.latest()
      act(() => result.current.setPermissionMode('plan'))
      expect(result.current.currentPermissionMode).toBe('plan')
      expect(sentMessages(ws).pop()).toEqual({ type: 'set_permission_mode', permissionMode: 'plan' })
      unmount()
    })

    it('setPermissionMode persists to localStorage', () => {
      const { result, unmount } = setupConnected()
      act(() => result.current.setPermissionMode('bypassPermissions'))
      expect(localStorage.getItem('claude-permission-mode')).toBe('bypassPermissions')
      unmount()
    })

    it('session_joined syncs permissionMode from server', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_joined',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
        active: true,
        outputBuffer: [],
        permissionMode: 'plan',
      } as WsServerMessage))
      expect(result.current.currentPermissionMode).toBe('plan')
      expect(localStorage.getItem('claude-permission-mode')).toBe('plan')
      unmount()
    })

    it('session_joined syncs model from server', () => {
      const { result, unmount } = setupConnected()
      act(() => MockWebSocket.latest().simulateMessage({
        type: 'session_joined',
        sessionId: 's1',
        sessionName: 'Test',
        workingDir: '/tmp',
        active: true,
        outputBuffer: [],
        model: 'claude-opus-4-6',
      } as WsServerMessage))
      expect(result.current.currentModel).toBe('claude-opus-4-6')
      expect(localStorage.getItem('claude-model')).toBe('claude-opus-4-6')
      unmount()
    })

    it('defaults to acceptEdits when no localStorage value', () => {
      localStorage.removeItem('claude-permission-mode')
      const { result, unmount } = setupConnected()
      expect(result.current.currentPermissionMode).toBe('acceptEdits')
      unmount()
    })
  })
})
