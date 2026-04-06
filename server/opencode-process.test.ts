/** Tests for OpenCodeProcess — verifies SSE event mapping, lifecycle, and provider interface compliance. */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock fetch globally for HTTP calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock child_process.spawn for the server process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => {
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

    it('returns the session ID', () => {
      expect(ocp.getSessionId()).toBe('test-session-id')
    })

    it('generates a session ID if not provided', () => {
      const ocp2 = new OpenCodeProcess('/tmp/test-repo')
      expect(ocp2.getSessionId()).toBeTruthy()
      expect(ocp2.getSessionId()).toHaveLength(36) // UUID format
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

  describe('SSE event mapping', () => {
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

    it('maps text part updates to text events', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      // First text delta
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', content: 'Hello' },
        },
      })
      expect(textHandler).toHaveBeenCalledWith('Hello')

      // Incremental update — should only emit the delta
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', content: 'Hello world' },
        },
      })
      expect(textHandler).toHaveBeenCalledWith(' world')
      expect(textHandler).toHaveBeenCalledTimes(2)
    })

    it('resets text accumulator when time.end is set', () => {
      const textHandler = vi.fn()
      ocp.on('text', textHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', content: 'First block', time: { end: 123 } },
        },
      })

      // New text block starts fresh after time.end reset
      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'text', content: 'Second block' },
        },
      })
      expect(textHandler).toHaveBeenCalledWith('Second block')
    })

    it('maps reasoning parts to thinking events', () => {
      const thinkingHandler = vi.fn()
      ocp.on('thinking', thinkingHandler)
      setSessionId(ocp, 'oc-session-1')

      callHandleSSE(ocp, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'oc-session-1',
          part: { type: 'reasoning', content: 'Let me think about this carefully and consider all the options.' },
        },
      })
      expect(thinkingHandler).toHaveBeenCalledTimes(1)
      // Should extract a summary
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
          part: { type: 'reasoning', content: 'Short' },
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
            state: 'running',
            input: { command: 'ls -la' },
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
            state: 'completed',
            output: 'file contents here',
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
            state: 'error',
            error: 'command not found',
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

      callHandleSSE(ocp, {
        type: 'session.error',
        properties: { error: { message: 'Rate limit exceeded' } },
      })
      expect(errorHandler).toHaveBeenCalledWith('Rate limit exceeded')
    })

    it('maps permission.asked to control_request event', () => {
      const controlHandler = vi.fn()
      ocp.on('control_request', controlHandler)

      callHandleSSE(ocp, {
        type: 'permission.asked',
        properties: {
          id: 'perm-123',
          name: 'bash',
          input: { command: 'rm -rf /' },
          description: 'Allow bash?',
        },
      })
      expect(controlHandler).toHaveBeenCalledWith('perm-123', 'bash', { command: 'rm -rf /' })
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
            state: 'completed',
            output: longOutput,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summarize = (tool: string, input: Record<string, unknown>) => (ocp as any).summarizeToolInput(tool, input)

    it('summarizes bash commands', () => {
      expect(summarize('bash', { command: 'npm install' })).toBe('$ npm install')
    })

    it('summarizes read/view with file path', () => {
      expect(summarize('read', { file_path: '/src/index.ts' })).toBe('/src/index.ts')
      expect(summarize('view', { filePath: '/src/main.ts' })).toBe('/src/main.ts')
    })

    it('summarizes edit/write with file path', () => {
      expect(summarize('edit', { file_path: '/README.md' })).toBe('/README.md')
    })

    it('summarizes glob/grep with pattern', () => {
      expect(summarize('glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
      expect(summarize('grep', { pattern: 'TODO' })).toBe('TODO')
    })

    it('returns empty string for unknown tools', () => {
      expect(summarize('unknown_tool', {})).toBe('')
    })
  })
})
