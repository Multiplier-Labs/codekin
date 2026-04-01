/** Tests for useSendMessage — verifies send pipeline, slash command processing, tentative queue, and file management. */
// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/ccApi', () => ({
  uploadAndBuildMessage: vi.fn(() => Promise.resolve('[Attached files: /uploads/test.txt]\nhello')),
}))

vi.mock('./useSessionOrchestration', () => ({
  groupKey: (s: any) => s.groupDir ?? s.workingDir,
}))

vi.mock('../lib/slashCommands', () => ({
  resolveBuiltinAlias: vi.fn((cmd: string) => {
    const builtins: Record<string, string> = {
      '/clear': '/clear',
      '/reset': '/clear',
      '/compact': '/compact',
      '/help': '/help',
    }
    return builtins[cmd]
  }),
  BUNDLED_SKILLS: [
    { command: '/commit', name: 'Commit', description: 'Create a git commit', category: 'bundled' },
    { command: '/simplify', name: 'Simplify', description: 'Simplify code', category: 'bundled' },
  ],
}))

import { useSendMessage } from './useSendMessage'

/* Minimal renderHook using React 19's act + createRoot */
function renderHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void; rerender: (hookFn: () => T) => void } {
  const result = { current: undefined as T }
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot>
  let currentHookFn = hookFn

  function TestComponent() {
    result.current = currentHookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    result,
    unmount: () => act(() => root.unmount()),
    rerender: (fn) => {
      currentHookFn = fn
      act(() => root.render(createElement(TestComponent)))
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeOptions(overrides: Partial<any> = {}) {
  return {
    token: 'tok',
    activeSessionId: 'sess-1',
    activeWorkingDir: '/repo',
    sessions: [{ id: 'sess-1', workingDir: '/repo', groupDir: null, isProcessing: false }],
    allSkills: [] as any[],
    sendInput: vi.fn(),
    onBuiltinCommand: vi.fn(),
    tentativeQueues: {} as Record<string, any[]>,
    addToQueue: vi.fn(),
    clearQueue: vi.fn(),
    docsContext: { isOpen: false, selectedFile: null, repoWorkingDir: null },
    queueEnabled: false,
    ...overrides,
  }
}

describe('useSendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // handleSend
  // ---------------------------------------------------------------------------

  describe('handleSend', () => {
    it('sends plain text via sendInput', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('hello world')
      })

      expect(opts.sendInput).toHaveBeenCalledWith('hello world', undefined)
    })

    it('returns early when no token', async () => {
      const opts = makeOptions({ token: '' })
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('hello')
      })

      expect(opts.sendInput).not.toHaveBeenCalled()
    })

    it('handles built-in command (/clear) via onBuiltinCommand without sending', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/clear')
      })

      expect(opts.onBuiltinCommand).toHaveBeenCalledWith('/clear', '')
      expect(opts.sendInput).not.toHaveBeenCalled()
    })

    it('handles built-in alias (/reset) the same as canonical', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/reset')
      })

      expect(opts.onBuiltinCommand).toHaveBeenCalledWith('/clear', '')
      expect(opts.sendInput).not.toHaveBeenCalled()
    })

    it('sends bundled skill (/commit) as-is with displayText', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/commit fix typo')
      })

      expect(opts.sendInput).toHaveBeenCalledWith('/commit fix typo', '/commit fix typo')
    })

    it('expands filesystem skill content with $ARGUMENTS replacement', async () => {
      const opts = makeOptions({
        allSkills: [
          {
            id: 'sk-1',
            name: 'Validate',
            description: 'Run validation',
            command: '/validate',
            content: 'Please validate $ARGUMENTS in the codebase.',
          },
        ],
      })
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/validate all tests')
      })

      const sentText = opts.sendInput.mock.calls[0][0] as string
      expect(sentText).toContain('[Skill: Validate]')
      expect(sentText).toContain('Please validate all tests in the codebase.')
      expect(sentText).toContain('User instructions: all tests')
      // displayText should be the original slash command
      expect(opts.sendInput.mock.calls[0][1]).toBe('/validate all tests')
    })

    it('replaces $ARGUMENTS with default when no args given', async () => {
      const opts = makeOptions({
        allSkills: [
          {
            id: 'sk-1',
            name: 'Validate',
            description: 'Run validation',
            command: '/validate',
            content: 'Please validate $ARGUMENTS.',
          },
        ],
      })
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/validate')
      })

      const sentText = opts.sendInput.mock.calls[0][0] as string
      expect(sentText).toContain('Please validate (no arguments provided).')
      // No "User instructions:" section when args are empty
      expect(sentText).not.toContain('User instructions:')
    })

    it('prepends docs context when docs are open', async () => {
      const opts = makeOptions({
        docsContext: { isOpen: true, selectedFile: 'README.md', repoWorkingDir: '/repo' },
      })
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('explain this')
      })

      expect(opts.sendInput).toHaveBeenCalledWith(
        '[Viewing doc: README.md in /repo]\n\nexplain this',
        undefined,
      )
    })

    it('does not prepend docs context when docs are closed', async () => {
      const opts = makeOptions({
        docsContext: { isOpen: false, selectedFile: 'README.md', repoWorkingDir: '/repo' },
      })
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('explain this')
      })

      expect(opts.sendInput).toHaveBeenCalledWith('explain this', undefined)
    })
  })

  // ---------------------------------------------------------------------------
  // processSlashCommand (tested via handleSend)
  // ---------------------------------------------------------------------------

  describe('processSlashCommand (via handleSend)', () => {
    it('passes non-slash text through unchanged', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('just regular text')
      })

      expect(opts.sendInput).toHaveBeenCalledWith('just regular text', undefined)
      expect(opts.onBuiltinCommand).not.toHaveBeenCalled()
    })

    it('passes unknown slash command through as regular text', async () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      await act(async () => {
        await result.current.handleSend('/unknown-command arg1')
      })

      expect(opts.sendInput).toHaveBeenCalledWith('/unknown-command arg1', undefined)
      expect(opts.onBuiltinCommand).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // handleDiscardTentative
  // ---------------------------------------------------------------------------

  describe('handleDiscardTentative', () => {
    it('calls clearQueue with the given session ID', () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      act(() => {
        result.current.handleDiscardTentative('sess-1')
      })

      expect(opts.clearQueue).toHaveBeenCalledWith('sess-1')
    })
  })

  // ---------------------------------------------------------------------------
  // tentativeMessages
  // ---------------------------------------------------------------------------

  describe('tentativeMessages', () => {
    it('is empty when no queued messages', () => {
      const opts = makeOptions({ tentativeQueues: {} })
      const { result } = renderHook(() => useSendMessage(opts))

      expect(result.current.tentativeMessages).toEqual([])
      expect(result.current.activeTentativeCount).toBe(0)
    })

    it('returns mapped ChatMessage array when queue has entries', () => {
      const opts = makeOptions({
        tentativeQueues: {
          'sess-1': [
            { text: 'queued msg 1', files: [] },
            { text: 'queued msg 2', files: [new File(['x'], 'file.txt')] },
          ],
        },
      })
      const { result } = renderHook(() => useSendMessage(opts))

      expect(result.current.tentativeMessages).toHaveLength(2)
      expect(result.current.activeTentativeCount).toBe(2)

      expect(result.current.tentativeMessages[0]).toEqual({
        type: 'tentative',
        text: 'queued msg 1',
        index: 0,
        key: 'tentative-0',
      })

      // Second entry has a file, so text should include attachment note
      expect(result.current.tentativeMessages[1].text).toContain('queued msg 2')
      expect(result.current.tentativeMessages[1].text).toContain('1 file attached')
    })

    it('returns empty for a different session', () => {
      const opts = makeOptions({
        activeSessionId: 'sess-2',
        tentativeQueues: {
          'sess-1': [{ text: 'queued msg', files: [] }],
        },
      })
      const { result } = renderHook(() => useSendMessage(opts))

      expect(result.current.tentativeMessages).toEqual([])
      expect(result.current.activeTentativeCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // pendingFiles / addFiles / removeFile
  // ---------------------------------------------------------------------------

  describe('pendingFiles / addFiles / removeFile', () => {
    it('starts with empty pendingFiles', () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      expect(result.current.pendingFiles).toEqual([])
    })

    it('addFiles appends to pending for the active session', () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      const file1 = new File(['a'], 'a.txt')
      const file2 = new File(['b'], 'b.txt')

      act(() => {
        result.current.addFiles([file1])
      })
      expect(result.current.pendingFiles).toHaveLength(1)
      expect(result.current.pendingFiles[0].name).toBe('a.txt')

      act(() => {
        result.current.addFiles([file2])
      })
      expect(result.current.pendingFiles).toHaveLength(2)
      expect(result.current.pendingFiles[1].name).toBe('b.txt')
    })

    it('removeFile removes by index', () => {
      const opts = makeOptions()
      const { result } = renderHook(() => useSendMessage(opts))

      const file1 = new File(['a'], 'a.txt')
      const file2 = new File(['b'], 'b.txt')
      const file3 = new File(['c'], 'c.txt')

      act(() => {
        result.current.addFiles([file1, file2, file3])
      })
      expect(result.current.pendingFiles).toHaveLength(3)

      act(() => {
        result.current.removeFile(1) // remove b.txt
      })
      expect(result.current.pendingFiles).toHaveLength(2)
      expect(result.current.pendingFiles[0].name).toBe('a.txt')
      expect(result.current.pendingFiles[1].name).toBe('c.txt')
    })

    it('pendingFiles scoped to active session', () => {
      const opts = makeOptions({ activeSessionId: 'sess-1' })
      const { result, rerender } = renderHook(() => useSendMessage(opts))

      act(() => {
        result.current.addFiles([new File(['x'], 'sess1-file.txt')])
      })
      expect(result.current.pendingFiles).toHaveLength(1)

      // Switch active session
      const opts2 = makeOptions({ activeSessionId: 'sess-2' })
      rerender(() => useSendMessage(opts2))

      // New session has no files
      expect(result.current.pendingFiles).toEqual([])
    })
  })
})
