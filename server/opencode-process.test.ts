/** Tests for OpenCodeProcess — verifies SSE event mapping, lifecycle, and provider interface compliance. */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { summarizeToolInput } from './tool-labels.js'

// Mock fetch globally for HTTP calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock child_process.spawn for the server process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const EventEmitter = require('events').EventEmitter
      const proc = Object.assign(new EventEmitter(), {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: Object.assign(new EventEmitter(), { on: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { on: vi.fn() }),
        kill: vi.fn(),
        killed: false,
      })
      return proc
    }),
  }
})

import { OpenCodeProcess, stopOpenCodeServer, permissionRulesetFor, OPENCODE_SYSTEM_CONTEXT, isVersionOlder, MIN_TESTED_OPENCODE_VERSION } from './opencode-process.js'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OPENCODE_CAPABILITIES } from './coding-process.js'

describe('OpenCodeProcess', () => {
  let ocp: OpenCodeProcess

  beforeEach(() => {
    vi.clearAllMocks()
    ocp = new OpenCodeProcess('/tmp/test-repo', {
      sessionId: 'test-session-id',
      model: 'anthropic/claude-sonnet-4',
    })
  })

  afterEach(() => {
    ocp.stop()
    stopOpenCodeServer()
  })

  // ---------------------------------------------------------------------------
  // Interface compliance
  // ---------------------------------------------------------------------------

  describe('provider interface', () => {
    it('reports provider as opencode', () => {
      expect(ocp.provider).toBe('opencode')
    })

    it('has opencode capabilities', () => {
      expect(ocp.capabilities).toBe(OPENCODE_CAPABILITIES)
      expect(ocp.capabilities.multiProvider).toBe(true)
    })

    it('starts as not alive', () => {
      expect(ocp.isAlive()).toBe(false)
    })

    it('returns codekin session ID when no opencode session exists', () => {
      expect(ocp.getSessionId()).toBe('test-session-id')
    })

    it('returns opencode session ID when available (for resume)', () => {
      const ocp2 = new OpenCodeProcess('/tmp/test-repo', {
        sessionId: 'codekin-id',
        opencodeSessionId: 'opencode-abc-123',
      })
      expect(ocp2.getSessionId()).toBe('opencode-abc-123')
      ocp2.stop()
    })

    it('generates a session ID if not provided', () => {
      const ocp2 = new OpenCodeProcess('/tmp/test-repo')
      expect(ocp2.getSessionId()).toBeTruthy()
      expect(ocp2.getSessionId()).toHaveLength(36) // UUID format
      ocp2.stop()
    })

    it('accepts opencodeSessionId for resume via constructor', () => {
      const ocp2 = new OpenCodeProcess('/tmp/test-repo', {
        opencodeSessionId: 'oc-resume-id',
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ocp2 as any).opencodeSessionId).toBe('oc-resume-id')
      ocp2.stop()
    })

    it('sendRaw is a no-op', () => {
      // Should not throw
      ocp.sendRaw('anything')
    })

    it('waitForExit resolves immediately when not alive', async () => {
      await expect(ocp.waitForExit()).resolves.toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // SSE event mapping
  // ---------------------------------------------------------------------------

  // Access the private handleSSEEvent method for testing event mapping
  const callHandleSSE = (ocp: OpenCodeProcess, event: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ocp as any).handleSSEEvent(event)
  }

  // Set the opencodeSessionId so session filtering works
  const setSessionId = (ocp: OpenCodeProcess, id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ocp as any).opencodeSessionId = id
  }

  describe('SSE event mapping', () => {

    it('maps text delta events to text events', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: {
          sessionID: 'oc-session-1',
          field: 'text',
          delta: 'Hello',
        },
      })
      expect(textHandler).toHaveBeenCalledWith('Hello')

      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: {
          sessionID: 'oc-session-1',
          field: 'text',
          delta: ' world',
        },
      })
      expect(textHandler).toHaveBeenCalledWith(' world')
      expect(textHandler).toHaveBeenCalledTimes(2)
    })

    it('ignores non-text delta events', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: {
          sessionID: 'oc-session-1',
          field: 'reasoning',
          delta: 'some reasoning',
        },
      })
      expect(textHandler).not.toHaveBeenCalled()
    })

    it('ignores delta events from other sessions', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: {
          sessionID: 'other-session',
          field: 'text',
          delta: 'Hello',
        },
      })
      expect(textHandler).not.toHaveBeenCalled()
    })

    it('strips user echo prefix from text deltas', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // Simulate sendMessage storing lastUserInput
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).lastUserInput = 'hello'

      // First delta — matches user input, should be buffered
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'text', delta: 'hello' },
      })
      expect(textHandler).not.toHaveBeenCalled()

      // Second delta — flushes buffer, strips user echo, emits remainder
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'text', delta: 'Hello there!' },
      })
      // Buffer was "helloHello there!" which starts with "hello", so emits "Hello there!"
      expect(textHandler).toHaveBeenCalledWith('Hello there!')
    })

    it('emits full buffer when no user echo match', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).lastUserInput = 'hello'

      // Delta that doesn't match user input once it reaches the threshold
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'text', delta: 'Sure, I can help!' },
      })
      expect(textHandler).toHaveBeenCalledWith('Sure, I can help!')
    })

    it('emits reasoning deltas as thinking events', () => {
      const thinkingHandler = vi.fn()
      ocp.on('thinking', thinkingHandler)
      setSessionId(ocp, 'oc-session-1')

      // Short reasoning — not enough for summary
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'reasoning', delta: 'Let me ' },
      })
      expect(thinkingHandler).not.toHaveBeenCalled()

      // More reasoning — exceeds threshold, emits thinking summary
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'reasoning', delta: 'think about this carefully.' },
      })
      expect(thinkingHandler).toHaveBeenCalledTimes(1)
      expect(thinkingHandler.mock.calls[0][0]).toContain('Let me think about this carefully.')
    })

    it('strips user echo from full text in message.part.updated', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).lastUserInput = 'hello'

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', text: 'helloHere is my response.' },
        },
      })
      expect(textHandler).toHaveBeenCalledWith('Here is my response.')
    })

    it('ignores text part updates (content arrives via deltas)', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', content: 'Hello' },
        },
      })
      expect(textHandler).not.toHaveBeenCalled()
    })

    it('maps reasoning parts to thinking events', () => {
      const thinkingHandler = vi.fn()
      ocp.on('thinking', thinkingHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'reasoning', text: 'Let me think about this carefully and consider all the options.' },
        },
      })
      expect(thinkingHandler).toHaveBeenCalledTimes(1)
      expect(thinkingHandler.mock.calls[0][0]).toBeTruthy()
    })

    it('ignores short reasoning content', () => {
      const thinkingHandler = vi.fn()
      ocp.on('thinking', thinkingHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'reasoning', text: 'Short' },
        },
      })
      expect(thinkingHandler).not.toHaveBeenCalled()
    })

    it('routes Kimi-style field=text deltas by partID (reasoning hidden, answer shown)', async () => {
      // Kimi via OpenCode streams BOTH reasoning and the answer as field=text
      // deltas, distinguished only by partID, and never sends
      // message.part.updated — so the part kind is resolved via a REST lookup.
      const textHandler = vi.fn()
      const thinkingHandler = vi.fn()
      ocp.on('text', textHandler)
      ocp.on('thinking', thinkingHandler)
      setSessionId(ocp, 'oc-session-1')

      // Classify 'prt_reason' as reasoning, everything else as text.
      mockFetch.mockImplementation((url: string) => {
        const type = url.includes('prt_reason') ? 'reasoning' : 'text'
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ type }) })
      })

      for (const d of ['The user ', 'is greeting me. ', 'I should respond.']) {
        callHandleSSE(ocp, {
          type: 'message.part.delta',
          properties: { sessionID: 'oc-session-1', messageID: 'msg_1', partID: 'prt_reason', field: 'text', delta: d },
        })
      }
      // Deltas are buffered pending classification — nothing emitted yet.
      expect(textHandler).not.toHaveBeenCalled()
      expect(thinkingHandler).not.toHaveBeenCalled()

      // Once the lookup resolves, reasoning becomes a thinking summary, never text.
      await vi.waitFor(() => expect(thinkingHandler).toHaveBeenCalledTimes(1))
      expect(textHandler).not.toHaveBeenCalled()

      for (const d of ['Hello', '! How can I help?']) {
        callHandleSSE(ocp, {
          type: 'message.part.delta',
          properties: { sessionID: 'oc-session-1', messageID: 'msg_1', partID: 'prt_answer', field: 'text', delta: d },
        })
      }
      await vi.waitFor(() => expect(textHandler).toHaveBeenCalled())
      const shown = textHandler.mock.calls.map(c => c[0] as string).join('')
      expect(shown).toBe('Hello! How can I help?')
      expect(shown).not.toContain('greeting')
    })

    it('maps running tool parts to tool_active events', () => {
      const toolActiveHandler = vi.fn()
      ocp.on('tool_active', toolActiveHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'ls -la' } },
          },
        },
      })
      expect(toolActiveHandler).toHaveBeenCalledWith('bash', '$ ls -la')
    })

    it('maps completed tool parts to tool_done and tool_output events', () => {
      const toolDoneHandler = vi.fn()
      const toolOutputHandler = vi.fn()
      ocp.on('tool_done', toolDoneHandler)
      ocp.on('tool_output', toolOutputHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'read',
            state: { status: 'completed', output: 'file contents here' },
          },
        },
      })
      expect(toolDoneHandler).toHaveBeenCalledWith('read', 'file contents here')
      expect(toolOutputHandler).toHaveBeenCalledWith('file contents here', false)
    })

    it('maps error tool parts to tool_done and error tool_output', () => {
      const toolDoneHandler = vi.fn()
      const toolOutputHandler = vi.fn()
      ocp.on('tool_done', toolDoneHandler)
      ocp.on('tool_output', toolOutputHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'error', error: 'command not found' },
          },
        },
      })
      expect(toolDoneHandler).toHaveBeenCalledWith('bash', 'Error: command not found')
      expect(toolOutputHandler).toHaveBeenCalledWith('command not found', true)
    })

    it('maps session.status idle to result event', () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.status',
        properties: {
          sessionID: 'oc-session-1',
          status: { type: 'idle' },
        },
      })
      expect(resultHandler).toHaveBeenCalledWith('', false)
    })

    it('maps session.error to error event', () => {
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.error',
        properties: { sessionID: 'oc-session-1', error: { message: 'Rate limit exceeded' } },
      })
      expect(errorHandler).toHaveBeenCalledWith('Rate limit exceeded')
    })

    it('filters session.error from other sessions', () => {
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)
      setSessionId(ocp, 'my-session')

      callHandleSSE(ocp, {
        type: 'session.error',
        properties: { sessionID: 'other-session', error: { message: 'Should be ignored' } },
      })
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it('maps permission.asked to control_request event', () => {
      const controlHandler = vi.fn()
      ocp.on('control_request', controlHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'permission.asked',
        properties: {
          sessionID: 'oc-session-1',
          id: 'perm-123',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
          metadata: { filepath: '/tmp', parentDir: '/tmp' },
          tool: { messageID: 'msg-1', callID: 'call-1' },
        },
      })
      expect(controlHandler).toHaveBeenCalledWith('perm-123', 'external_directory', {
        permission: 'external_directory',
        filepath: '/tmp',
        parentDir: '/tmp',
        patterns: ['/tmp/*'],
      })
    })

    it('filters permission.asked from other sessions', () => {
      const controlHandler = vi.fn()
      ocp.on('control_request', controlHandler)
      setSessionId(ocp, 'my-session')

      callHandleSSE(ocp, {
        type: 'permission.asked',
        properties: {
          sessionID: 'other-session',
          id: 'perm-456',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
        },
      })
      expect(controlHandler).not.toHaveBeenCalled()
    })

    it('filters events from other sessions', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'my-session')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'other-session',
          part: { type: 'text', content: 'Should be ignored' },
        },
      })
      expect(textHandler).not.toHaveBeenCalled()
    })

    it('truncates long tool output', () => {
      const toolOutputHandler = vi.fn()
      ocp.on('tool_output', toolOutputHandler)
      setSessionId(ocp, 'oc-session-1')

      const longOutput = 'x'.repeat(3000)
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'read',
            state: { status: 'completed', output: longOutput },
          },
        },
      })

      const emitted = toolOutputHandler.mock.calls[0][0] as string
      expect(emitted.length).toBeLessThan(longOutput.length)
      expect(emitted).toContain('truncated')
    })
  })

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('stop() sets alive to false and emits exit', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true
      expect(ocp.isAlive()).toBe(true)

      const exitHandler = vi.fn()
      ocp.on('exit', exitHandler)
      ocp.stop()

      expect(ocp.isAlive()).toBe(false)
      expect(exitHandler).toHaveBeenCalledWith(0, null)
    })

    it('waitForExit resolves after stop', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true

      const exitPromise = ocp.waitForExit(5000)
      ocp.stop()
      await expect(exitPromise).resolves.toBeUndefined()
    })

    it('sendMessage emits error when not connected', () => {
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)

      ocp.sendMessage('hello')
      expect(errorHandler).toHaveBeenCalledWith('OpenCode process is not connected')
    })

    it('sendControlResponse calls replyToPermission', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyFn = vi.spyOn(ocp as any, 'replyToPermission').mockResolvedValue(undefined)
      ocp.sendControlResponse('req-1', 'allow')
      expect(replyFn).toHaveBeenCalledWith('req-1', 'once')
    })

    it('sendControlResponse maps deny to reject', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyFn = vi.spyOn(ocp as any, 'replyToPermission').mockResolvedValue(undefined)
      ocp.sendControlResponse('req-2', 'deny')
      expect(replyFn).toHaveBeenCalledWith('req-2', 'reject')
    })

    it('sendControlResponse maps allow_always to always', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyFn = vi.spyOn(ocp as any, 'replyToPermission').mockResolvedValue(undefined)
      ocp.sendControlResponse('req-3', 'allow_always')
      expect(replyFn).toHaveBeenCalledWith('req-3', 'always')
    })
  })

  // ---------------------------------------------------------------------------
  // Turn lifecycle hardening
  // ---------------------------------------------------------------------------

  describe('turn lifecycle', () => {
    it('emits result only once even when multiple idle events arrive', () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.idle',
        properties: { sessionID: 'oc-session-1' },
      })
      callHandleSSE(ocp, {
        type: 'message.completed',
        properties: { sessionID: 'oc-session-1' },
      })
      callHandleSSE(ocp, {
        type: 'session.status',
        properties: { sessionID: 'oc-session-1', status: { type: 'idle' } },
      })
      expect(resultHandler).toHaveBeenCalledTimes(1)
    })

    it('clears the turn watchdog when the turn completes', () => {
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).startTurnWatchdog()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ocp as any).turnWatchdog).not.toBeNull()

      callHandleSSE(ocp, {
        type: 'session.idle',
        properties: { sessionID: 'oc-session-1' },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ocp as any).turnWatchdog).toBeNull()
    })

    it('recovers a missed completion event via message poll', async () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).turnComplete = false

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { info: { role: 'user', time: { created: 1 } } },
          { info: { role: 'assistant', time: { created: 2, completed: 3 } } },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)
      expect(resultHandler).toHaveBeenCalledWith('', false)
    })

    it('does not force-complete when the assistant message is still running', async () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { info: { role: 'assistant', time: { created: 2 } } },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)
      expect(resultHandler).not.toHaveBeenCalled()
    })

    it('handles flat message objects (no info wrapper) in poll response', async () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { role: 'assistant', time: { created: 2, completed: 3 } },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)
      expect(resultHandler).toHaveBeenCalledWith('', false)
    })
  })

  // ---------------------------------------------------------------------------
  // Permission mode → OpenCode permission ruleset
  // ---------------------------------------------------------------------------

  describe('permissionRulesetFor', () => {
    it('maps bypassPermissions to an all-allow ruleset', () => {
      expect(permissionRulesetFor('bypassPermissions')).toEqual([
        { permission: '*', pattern: '*', action: 'allow' },
      ])
    })

    it('maps dangerouslySkipPermissions to an all-allow ruleset', () => {
      expect(permissionRulesetFor('dangerouslySkipPermissions')).toEqual([
        { permission: '*', pattern: '*', action: 'allow' },
      ])
    })

    it('maps acceptEdits to an edit-allow ruleset', () => {
      expect(permissionRulesetFor('acceptEdits')).toEqual([
        { permission: 'edit', pattern: '*', action: 'allow' },
      ])
    })

    it('returns undefined for default, plan, and unset modes', () => {
      expect(permissionRulesetFor('default')).toBeUndefined()
      expect(permissionRulesetFor('plan')).toBeUndefined()
      expect(permissionRulesetFor(undefined)).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // sendMessage request body (agent, system, model, command routing)
  // ---------------------------------------------------------------------------

  describe('sendMessage request body', () => {
    /** Prepare a connected process and capture the next outgoing request. */
    const connect = (proc: OpenCodeProcess) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proc as any).alive = true
      setSessionId(proc, 'oc-session-1')
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    }

    const lastRequest = () => {
      const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, { body: string }]
      return { url, body: JSON.parse(init.body) as Record<string, unknown> }
    }

    it('selects the build agent and appends Codekin system context by default', () => {
      connect(ocp)
      ocp.sendMessage('hello')
      const { url, body } = lastRequest()
      expect(url).toContain('/session/oc-session-1/prompt_async')
      expect(body.agent).toBe('build')
      expect(body.system).toBe(OPENCODE_SYSTEM_CONTEXT)
      expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    })

    it('selects the plan agent in plan mode', () => {
      const planProc = new OpenCodeProcess('/tmp/test-repo', {
        sessionId: 'plan-session',
        model: 'anthropic/claude-sonnet-4',
        permissionMode: 'plan',
      })
      connect(planProc)
      planProc.sendMessage('propose a refactor')
      const { body } = lastRequest()
      expect(body.agent).toBe('plan')
      planProc.stop()
    })

    it('splits OpenRouter-style model IDs at the first slash only', () => {
      const orProc = new OpenCodeProcess('/tmp/test-repo', {
        sessionId: 'or-session',
        model: 'openrouter/meta-llama/llama-3.1-8b',
      })
      connect(orProc)
      orProc.sendMessage('hi')
      const { body } = lastRequest()
      expect(body.model).toEqual({ providerID: 'openrouter', modelID: 'meta-llama/llama-3.1-8b' })
      orProc.stop()
    })

    it('routes known slash commands to the command endpoint', () => {
      connect(ocp)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).commands = new Map([['review', { name: 'review', source: 'command' }]])
      ocp.sendMessage('/review src/index.ts')
      const { url, body } = lastRequest()
      expect(url).toContain('/session/oc-session-1/command')
      expect(body.command).toBe('review')
      expect(body.arguments).toBe('src/index.ts')
      expect(body.agent).toBe('build')
      expect(body.model).toBe('anthropic/claude-sonnet-4')
    })

    it('routes a known slash command without arguments', () => {
      connect(ocp)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).commands = new Map([['init', { name: 'init' }]])
      ocp.sendMessage('/init')
      const { url, body } = lastRequest()
      expect(url).toContain('/command')
      expect(body.command).toBe('init')
      expect(body.arguments).toBeUndefined()
    })

    it('sends unknown slash commands as a regular prompt', () => {
      connect(ocp)
      ocp.sendMessage('/not-a-command do things')
      const { url, body } = lastRequest()
      expect(url).toContain('/prompt_async')
      expect((body.parts as Array<{ text: string }>)[0].text).toBe('/not-a-command do things')
    })

    it('does not route commands when attachments are present', () => {
      connect(ocp)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).commands = new Map([['review', { name: 'review' }]])
      // Attached file does not exist — attachment is skipped, but the message
      // had an attachment prefix, so it must go through the prompt path.
      ocp.sendMessage('[Attached files: /nonexistent/file.png]\n/review this')
      const { url } = lastRequest()
      expect(url).toContain('/prompt_async')
    })
  })

  // ---------------------------------------------------------------------------
  // step-finish flushing
  // ---------------------------------------------------------------------------

  describe('step-finish', () => {
    it('flushes buffered text deltas on step-finish', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).lastUserInput = 'a long user message that exceeds the delta'

      // Short delta — buffered awaiting the echo check
      callHandleSSE(ocp, {
        type: 'message.part.delta',
        properties: { sessionID: 'oc-session-1', field: 'text', delta: 'Done.' },
      })
      expect(textHandler).not.toHaveBeenCalled()

      // Step boundary — buffer must flush
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: { sessionID: 'oc-session-1', part: { type: 'step-finish' } },
      })
      expect(textHandler).toHaveBeenCalledWith('Done.')
    })
  })

  // ---------------------------------------------------------------------------
  // Permission reply retries
  // ---------------------------------------------------------------------------

  describe('permission reply retries', () => {
    it('emits error when all permission reply attempts fail', async () => {
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).permissionRetryDelayMs = 0
      mockFetch.mockRejectedValue(new Error('connection refused'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).replyToPermission('perm-1', 'once')

      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(errorHandler).toHaveBeenCalledTimes(1)
      expect(errorHandler.mock.calls[0][0]).toContain('permission response')
    })

    it('does not emit error when a retry succeeds', async () => {
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).permissionRetryDelayMs = 0
      mockFetch
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce({ ok: true })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).replyToPermission('perm-2', 'once')

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(errorHandler).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Tool input summarization
  // ---------------------------------------------------------------------------

  describe('summarizeToolInput', () => {
    it('summarizes bash commands', () => {
      expect(summarizeToolInput('bash', { command: 'npm install' })).toBe('$ npm install')
    })

    it('summarizes read/view with file path', () => {
      expect(summarizeToolInput('read', { file_path: '/src/index.ts' })).toBe('/src/index.ts')
      expect(summarizeToolInput('view', { filePath: '/src/main.ts' })).toBe('/src/main.ts')
    })

    it('summarizes edit/write with file path', () => {
      expect(summarizeToolInput('edit', { file_path: '/README.md' })).toBe('/README.md')
    })

    it('summarizes glob/grep with pattern', () => {
      expect(summarizeToolInput('glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
      expect(summarizeToolInput('grep', { pattern: 'TODO' })).toBe('TODO')
    })

    it('returns empty string for unknown tools', () => {
      expect(summarizeToolInput('unknown_tool', {})).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Task/Todo support
  // ---------------------------------------------------------------------------

  describe('task tracking', () => {
    it('emits todo_update for TodoWrite tool calls', () => {
      const todoHandler = vi.fn()
      ocp.on('todo_update', todoHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'TodoWrite',
            state: {
              status: 'running',
              input: {
                todos: [
                  { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
                  { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
                ],
              },
            },
          },
        },
      })

      expect(todoHandler).toHaveBeenCalledTimes(1)
      const tasks = todoHandler.mock.calls[0][0]
      expect(tasks).toHaveLength(2)
      expect(tasks[0].subject).toBe('Fix bug')
      expect(tasks[0].status).toBe('in_progress')
      expect(tasks[1].subject).toBe('Write tests')
      expect(tasks[1].status).toBe('pending')
    })

    it('does not emit todo_update for non-task tools', () => {
      const todoHandler = vi.fn()
      ocp.on('todo_update', todoHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'ls' } },
          },
        },
      })

      expect(todoHandler).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Abort on stop (in-flight turn interrupt)
  // ---------------------------------------------------------------------------

  describe('abort on stop', () => {
    const connect = (proc: OpenCodeProcess) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proc as any).alive = true
      setSessionId(proc, 'oc-session-1')
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    }

    it('aborts an in-flight turn when stopped', () => {
      connect(ocp)
      ocp.sendMessage('do something long')
      mockFetch.mockClear()

      ocp.stop()

      const abortCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/session/oc-session-1/abort'),
      )
      expect(abortCall).toBeDefined()
      expect((abortCall![1] as { method: string }).method).toBe('POST')
    })

    it('does not abort when no turn is in flight', () => {
      connect(ocp)
      mockFetch.mockClear()

      ocp.stop()

      const abortCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/abort'),
      )
      expect(abortCall).toBeUndefined()
    })

    it('does not abort after the turn has completed', () => {
      connect(ocp)
      ocp.sendMessage('quick task')
      callHandleSSE(ocp, {
        type: 'session.idle',
        properties: { sessionID: 'oc-session-1' },
      })
      mockFetch.mockClear()

      ocp.stop()

      const abortCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/abort'),
      )
      expect(abortCall).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // /compact → native summarize endpoint
  // ---------------------------------------------------------------------------

  describe('compact command', () => {
    const connect = (proc: OpenCodeProcess) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proc as any).alive = true
      setSessionId(proc, 'oc-session-1')
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    }

    const lastRequest = () => {
      const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, { method: string; body: string }]
      return { url, method: init.method, body: JSON.parse(init.body) as Record<string, unknown> }
    }

    it('routes /compact to the summarize endpoint with the session model', () => {
      connect(ocp)
      ocp.sendMessage('/compact')
      const { url, method, body } = lastRequest()
      expect(url).toContain('/session/oc-session-1/summarize')
      expect(method).toBe('POST')
      expect(body).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' })
    })

    it('routes /summarize to the summarize endpoint', () => {
      connect(ocp)
      ocp.sendMessage('/summarize')
      const { url } = lastRequest()
      expect(url).toContain('/session/oc-session-1/summarize')
    })

    it('sends an empty body when no model is set', () => {
      const noModelProc = new OpenCodeProcess('/tmp/test-repo', { sessionId: 'no-model' })
      connect(noModelProc)
      noModelProc.sendMessage('/compact')
      const { body } = lastRequest()
      expect(body).toEqual({})
      noModelProc.stop()
    })

    it('emits error when the summarize request fails', async () => {
      connect(ocp)
      const errorHandler = vi.fn()
      ocp.on('error', errorHandler)
      mockFetch.mockResolvedValue({ ok: false, status: 500 })

      ocp.sendMessage('/compact')
      await vi.waitFor(() => {
        expect(errorHandler).toHaveBeenCalledWith('Failed to compact conversation: HTTP 500')
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Token/cost usage tracking
  // ---------------------------------------------------------------------------

  describe('usage tracking', () => {
    it('emits cumulative usage from assistant message.updated tokens', () => {
      const usageHandler = vi.fn()
      ocp.on('usage', usageHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: {
            id: 'm1',
            role: 'assistant',
            cost: 0.01,
            tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
          },
        },
      })

      expect(usageHandler).toHaveBeenCalledTimes(1)
      expect(usageHandler).toHaveBeenCalledWith({ inputTokens: 125, outputTokens: 60, costUsd: 0.01 })
    })

    it('suppresses duplicate usage emissions for unchanged totals', () => {
      const usageHandler = vi.fn()
      ocp.on('usage', usageHandler)
      setSessionId(ocp, 'oc-session-1')

      const event = {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm1', role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50 } },
        },
      }
      callHandleSSE(ocp, event)
      callHandleSSE(ocp, event)

      expect(usageHandler).toHaveBeenCalledTimes(1)
    })

    it('accumulates usage across messages and replaces same-message updates', () => {
      const usageHandler = vi.fn()
      ocp.on('usage', usageHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm1', role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50 } },
        },
      })
      // Same message grows (message.updated fires repeatedly) — replaces, not adds
      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm1', role: 'assistant', cost: 0.02, tokens: { input: 150, output: 80 } },
        },
      })
      // A second message accumulates on top
      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm2', role: 'assistant', cost: 0.01, tokens: { input: 50, output: 20 } },
        },
      })

      expect(usageHandler).toHaveBeenCalledTimes(3)
      expect(usageHandler).toHaveBeenNthCalledWith(2, { inputTokens: 150, outputTokens: 80, costUsd: 0.02 })
      expect(usageHandler).toHaveBeenNthCalledWith(3, { inputTokens: 200, outputTokens: 100, costUsd: 0.03 })
    })

    it('does not emit usage when tokens are absent or zero', () => {
      const usageHandler = vi.fn()
      ocp.on('usage', usageHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm1', role: 'assistant' },
        },
      })
      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'm2', role: 'assistant', tokens: { input: 0, output: 0 } },
        },
      })

      expect(usageHandler).not.toHaveBeenCalled()
    })

    it('ignores usage on non-assistant messages', () => {
      const usageHandler = vi.fn()
      ocp.on('usage', usageHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.updated',
        properties: {
          sessionID: 'oc-session-1',
          info: { id: 'u1', role: 'user', tokens: { input: 100, output: 0 } },
        },
      })

      expect(usageHandler).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Missed-text recovery via message poll
  // ---------------------------------------------------------------------------

  describe('missed-text recovery', () => {
    it('recovers assistant text when SSE events were lost', async () => {
      const textHandler = vi.fn()
      const resultHandler = vi.fn()
      ocp.on('text', textHandler)
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            info: { role: 'assistant', time: { created: 2, completed: 3 } },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: 'Recovered answer' },
            ],
          },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)

      expect(textHandler).toHaveBeenCalledWith('Recovered answer')
      expect(resultHandler).toHaveBeenCalledTimes(1)
    })

    it('does not re-emit text when deltas were already received', async () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).receivedDeltas = true

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            info: { role: 'assistant', time: { completed: 3 } },
            parts: [{ type: 'text', text: 'Already streamed' }],
          },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)

      expect(textHandler).not.toHaveBeenCalled()
    })

    it('strips user echo prefix from recovered text', async () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).lastUserInput = 'what is 2+2?'

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            info: { role: 'assistant', time: { completed: 3 } },
            parts: [{ type: 'text', text: 'what is 2+2?The answer is 4.' }],
          },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ocp as any).checkTurnLiveness(true)

      expect(textHandler).toHaveBeenCalledWith('The answer is 4.')
    })
  })

  // ---------------------------------------------------------------------------
  // Subagent (child session) activity
  // ---------------------------------------------------------------------------

  describe('subagent activity', () => {
    it('surfaces a new child session as Task tool activity', () => {
      const toolActiveHandler = vi.fn()
      ocp.on('tool_active', toolActiveHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.created',
        properties: {
          info: { id: 'child-1', parentID: 'oc-session-1', title: 'Investigate bug' },
        },
      })

      expect(toolActiveHandler).toHaveBeenCalledWith('Task', 'Investigate bug')
    })

    it('registers a child session only once', () => {
      const toolActiveHandler = vi.fn()
      ocp.on('tool_active', toolActiveHandler)
      setSessionId(ocp, 'oc-session-1')

      const event = {
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'oc-session-1', title: 'Subtask' } },
      }
      callHandleSSE(ocp, event)
      callHandleSSE(ocp, event)

      expect(toolActiveHandler).toHaveBeenCalledTimes(1)
    })

    it('ignores child sessions of other parents', () => {
      const toolActiveHandler = vi.fn()
      ocp.on('tool_active', toolActiveHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.created',
        properties: {
          info: { id: 'child-x', parentID: 'some-other-session', title: 'Not ours' },
        },
      })

      expect(toolActiveHandler).not.toHaveBeenCalled()
    })

    it('surfaces child session tool activity', () => {
      const toolActiveHandler = vi.fn()
      const toolDoneHandler = vi.fn()
      ocp.on('tool_active', toolActiveHandler)
      ocp.on('tool_done', toolDoneHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'oc-session-1', title: 'Research' } },
      })
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child-1',
          part: { type: 'tool', tool: 'grep', state: { status: 'running', input: { pattern: 'foo' } } },
        },
      })
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child-1',
          part: { type: 'tool', tool: 'grep', state: { status: 'completed', output: 'match found' } },
        },
      })

      expect(toolActiveHandler).toHaveBeenCalledWith('grep', 'foo')
      expect(toolDoneHandler).toHaveBeenCalledWith('grep', 'match found')
    })

    it('does not surface child session text parts', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'oc-session-1' } },
      })
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child-1',
          part: { type: 'text', text: 'internal subagent text' },
        },
      })

      expect(textHandler).not.toHaveBeenCalled()
    })

    it('does not complete the parent turn when a child session goes idle', () => {
      const resultHandler = vi.fn()
      ocp.on('result', resultHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'oc-session-1' } },
      })
      // session.updated for the child reporting idle — must NOT complete our turn
      callHandleSSE(ocp, {
        type: 'session.updated',
        properties: {
          info: { id: 'child-1', parentID: 'oc-session-1', status: { type: 'idle' } },
        },
      })

      expect(resultHandler).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Resume hydration (missed history tail)
  // ---------------------------------------------------------------------------

  describe('resume hydration', () => {
    const makeResumed = (recentOutputText: string) => {
      const proc = new OpenCodeProcess('/tmp/test-repo', {
        sessionId: 'resume-session',
        opencodeSessionId: 'oc-session-1',
        recentOutputText,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proc as any).alive = true
      return proc
    }

    const historyResponse = (entries: unknown[]) => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => entries })
    }

    it('re-emits a completed assistant message lost while detached', async () => {
      const proc = makeResumed('Earlier output that was shown.')
      const textHandler = vi.fn()
      proc.on('text', textHandler)

      historyResponse([
        { info: { role: 'user', time: { created: 1 } } },
        {
          info: { role: 'assistant', time: { created: 2, completed: 3 } },
          parts: [{ type: 'text', text: 'Answer generated during the crash' }],
        },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (proc as any).hydrateMissedTail('http://localhost:1234')

      expect(textHandler).toHaveBeenCalledWith('Answer generated during the crash')
      proc.stop()
    })

    it('does not re-emit text that was already displayed', async () => {
      const proc = makeResumed('intro... The final answer is 42. ...outro')
      const textHandler = vi.fn()
      proc.on('text', textHandler)

      historyResponse([
        {
          info: { role: 'assistant', time: { completed: 3 } },
          parts: [{ type: 'text', text: 'The final answer is 42.' }],
        },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (proc as any).hydrateMissedTail('http://localhost:1234')

      expect(textHandler).not.toHaveBeenCalled()
      proc.stop()
    })

    it('does not hydrate when the last entry is a user message', async () => {
      const proc = makeResumed('')
      const textHandler = vi.fn()
      proc.on('text', textHandler)

      historyResponse([
        {
          info: { role: 'assistant', time: { completed: 2 } },
          parts: [{ type: 'text', text: 'Old answer' }],
        },
        { info: { role: 'user', time: { created: 3 } } },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (proc as any).hydrateMissedTail('http://localhost:1234')

      expect(textHandler).not.toHaveBeenCalled()
      proc.stop()
    })

    it('does not hydrate an incomplete (in-flight) assistant message', async () => {
      const proc = makeResumed('')
      const textHandler = vi.fn()
      proc.on('text', textHandler)

      historyResponse([
        {
          info: { role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'Still streaming...' }],
        },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (proc as any).hydrateMissedTail('http://localhost:1234')

      expect(textHandler).not.toHaveBeenCalled()
      proc.stop()
    })

    it('survives a failed history fetch', async () => {
      const proc = makeResumed('')
      const textHandler = vi.fn()
      proc.on('text', textHandler)
      mockFetch.mockRejectedValueOnce(new Error('connection refused'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((proc as any).hydrateMissedTail('http://localhost:1234')).resolves.toBeUndefined()
      expect(textHandler).not.toHaveBeenCalled()
      proc.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // Mid-turn message queueing
  // ---------------------------------------------------------------------------

  describe('mid-turn message queueing', () => {
    const connect = (proc: OpenCodeProcess) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(proc as any).alive = true
      setSessionId(proc, 'oc-session-1')
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    }

    const promptCalls = () =>
      mockFetch.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/prompt_async'))

    it('queues a message sent while a turn is in flight', () => {
      connect(ocp)
      ocp.sendMessage('first')
      ocp.sendMessage('second')

      expect(promptCalls()).toHaveLength(1)
      const body = JSON.parse((promptCalls()[0][1] as { body: string }).body) as { parts: Array<{ text: string }> }
      expect(body.parts[0].text).toBe('first')
    })

    it('sends the queued message when the turn completes', async () => {
      connect(ocp)
      ocp.sendMessage('first')
      ocp.sendMessage('second')

      callHandleSSE(ocp, {
        type: 'session.idle',
        properties: { sessionID: 'oc-session-1' },
      })
      // Queued send is deferred via setImmediate
      await new Promise((r) => setImmediate(r))

      expect(promptCalls()).toHaveLength(2)
      const body = JSON.parse((promptCalls()[1][1] as { body: string }).body) as { parts: Array<{ text: string }> }
      expect(body.parts[0].text).toBe('second')
    })

    it('preserves queue order across multiple turns', async () => {
      connect(ocp)
      ocp.sendMessage('first')
      ocp.sendMessage('second')
      ocp.sendMessage('third')

      callHandleSSE(ocp, { type: 'session.idle', properties: { sessionID: 'oc-session-1' } })
      await new Promise((r) => setImmediate(r))
      callHandleSSE(ocp, { type: 'session.idle', properties: { sessionID: 'oc-session-1' } })
      await new Promise((r) => setImmediate(r))

      const texts = promptCalls().map(([, init]) =>
        (JSON.parse((init as { body: string }).body) as { parts: Array<{ text: string }> }).parts[0].text)
      expect(texts).toEqual(['first', 'second', 'third'])
    })

    it('drops queued messages on stop', async () => {
      connect(ocp)
      ocp.sendMessage('first')
      ocp.sendMessage('second')

      ocp.stop()
      await new Promise((r) => setImmediate(r))

      expect(promptCalls()).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Version comparison
  // ---------------------------------------------------------------------------

  describe('isVersionOlder', () => {
    it('compares major/minor/patch numerically', () => {
      expect(isVersionOlder('1.14.9', '1.15.0')).toBe(true)
      expect(isVersionOlder('1.15.0', '1.15.0')).toBe(false)
      expect(isVersionOlder('1.16.0', '1.15.0')).toBe(false)
      expect(isVersionOlder('0.9.9', '1.0.0')).toBe(true)
      expect(isVersionOlder('1.15', '1.15.0')).toBe(false)
      expect(isVersionOlder('2.0.0', MIN_TESTED_OPENCODE_VERSION)).toBe(false)
    })

    it('treats unparseable versions as not older', () => {
      expect(isVersionOlder('dev', '1.15.0')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  describe('attachments', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'codekin-attach-'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ocp as any).alive = true
      setSessionId(ocp, 'oc-session-1')
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    const sentParts = () => {
      const [, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, { body: string }]
      return (JSON.parse(init.body) as { parts: Array<Record<string, unknown>> }).parts
    }

    it('sends PDFs as data-URL file parts', () => {
      const pdfPath = join(dir, 'doc.pdf')
      writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'))

      ocp.sendMessage(`[Attached files: ${pdfPath}]\nsummarize this`)

      const filePart = sentParts().find((p) => p.type === 'file')
      expect(filePart).toBeDefined()
      expect(filePart!.mime).toBe('application/pdf')
      expect(String(filePart!.url)).toMatch(/^data:application\/pdf;base64,/)
    })

    it('inlines unknown text-like files (no extension allowlist)', () => {
      const tsPath = join(dir, 'snippet.tsx')
      writeFileSync(tsPath, 'export const x = 1\n')

      ocp.sendMessage(`[Attached files: ${tsPath}]\nreview`)

      const textParts = sentParts().filter((p) => p.type === 'text')
      expect(textParts.some((p) => String(p.text).includes('--- snippet.tsx ---') && String(p.text).includes('export const x = 1'))).toBe(true)
    })

    it('skips binary files with a visible note', () => {
      const binPath = join(dir, 'blob.bin')
      writeFileSync(binPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))

      ocp.sendMessage(`[Attached files: ${binPath}]\nwhat is this`)

      const parts = sentParts()
      expect(parts.some((p) => p.type === 'file')).toBe(false)
      expect(parts.some((p) => p.type === 'text' && String(p.text).includes('unsupported binary format'))).toBe(true)
    })
  })
})