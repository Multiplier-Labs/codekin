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

import { OpenCodeProcess, stopOpenCodeServer } from './opencode-process.js'
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
})