import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ClaudeProcess } from './claude-process.js'

// Access private methods/fields for testing via any-cast
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CP = any

function makeCP(): CP {
  return new ClaudeProcess('/tmp') as CP
}

function makeCPWithStdin() {
  const cp = makeCP() as CP
  const stdinData: string[] = []
  cp.proc = {
    stdin: {
      writable: true,
      write: vi.fn((data: string) => { stdinData.push(data); return true }),
      once: vi.fn(),
    },
    kill: vi.fn(),
  }
  return { cp, stdinData }
}

describe('summarizeToolInput', () => {
  const cp = makeCP()

  it('Bash: prepends $ and truncates multiline', () => {
    expect(cp.summarizeToolInput('Bash', { command: 'echo hello\necho world' }))
      .toBe('$ echo hello...')
  })

  it('Bash: single-line stays as-is', () => {
    expect(cp.summarizeToolInput('Bash', { command: 'ls -la' }))
      .toBe('$ ls -la')
  })

  it('Read: returns file_path', () => {
    expect(cp.summarizeToolInput('Read', { file_path: '/src/foo.ts' }))
      .toBe('/src/foo.ts')
  })

  it('Write: returns file_path', () => {
    expect(cp.summarizeToolInput('Write', { file_path: '/src/bar.ts' }))
      .toBe('/src/bar.ts')
  })

  it('Edit: returns file_path', () => {
    expect(cp.summarizeToolInput('Edit', { file_path: '/src/baz.ts' }))
      .toBe('/src/baz.ts')
  })

  it('Glob: returns pattern', () => {
    expect(cp.summarizeToolInput('Glob', { pattern: '**/*.ts' }))
      .toBe('**/*.ts')
  })

  it('Grep: returns pattern', () => {
    expect(cp.summarizeToolInput('Grep', { pattern: 'TODO' }))
      .toBe('TODO')
  })

  it('TaskCreate: returns subject', () => {
    expect(cp.summarizeToolInput('TaskCreate', { subject: 'Fix bug' }))
      .toBe('Fix bug')
  })

  it('TaskUpdate: returns #id → status', () => {
    expect(cp.summarizeToolInput('TaskUpdate', { taskId: '3', status: 'completed' }))
      .toBe('#3 → completed')
  })

  it('TodoWrite: returns N tasks', () => {
    expect(cp.summarizeToolInput('TodoWrite', { todos: [{}, {}, {}] }))
      .toBe('3 tasks')
  })

  it('unknown tool: returns empty string', () => {
    expect(cp.summarizeToolInput('SomeFutureTool', {}))
      .toBe('')
  })
})

describe('handleTaskTool', () => {
  let cp: CP

  beforeEach(() => {
    cp = makeCP()
  })

  describe('TodoWrite', () => {
    it('replaces all tasks with auto-generated IDs', () => {
      cp.handleTaskTool('TodoWrite', {
        todos: [
          { content: 'Task A', status: 'pending' },
          { content: 'Task B', status: 'completed' },
        ],
      })
      expect(cp.tasks.size).toBe(2)
      expect(cp.tasks.get('1')!.subject).toBe('Task A')
      expect(cp.tasks.get('2')!.status).toBe('completed')
    })

    it('uses explicit IDs when present', () => {
      cp.handleTaskTool('TodoWrite', {
        todos: [
          { id: 'a', content: 'Task A', status: 'pending' },
          { id: 'b', content: 'Task B', status: 'completed' },
        ],
      })
      expect(cp.tasks.size).toBe(2)
      expect(cp.tasks.get('a')!.subject).toBe('Task A')
      expect(cp.tasks.get('b')!.status).toBe('completed')
    })

    it('reads subject field as fallback for content', () => {
      cp.handleTaskTool('TodoWrite', {
        todos: [
          { subject: 'Via subject', status: 'pending' },
        ],
      })
      expect(cp.tasks.get('1')!.subject).toBe('Via subject')
    })

    it('filters invalid statuses', () => {
      cp.handleTaskTool('TodoWrite', {
        todos: [
          { content: 'Good', status: 'pending' },
          { content: 'Bad', status: 'invalid' },
        ],
      })
      expect(cp.tasks.size).toBe(1)
    })

    it('clears existing tasks and resets ID sequence', () => {
      cp.handleTaskTool('TaskCreate', { subject: 'Old task' })
      expect(cp.tasks.size).toBe(1)
      cp.handleTaskTool('TodoWrite', {
        todos: [{ content: 'New', status: 'in_progress' }],
      })
      expect(cp.tasks.size).toBe(1)
      expect(cp.tasks.get('1')!.subject).toBe('New')
    })

    it('returns false for non-array todos', () => {
      expect(cp.handleTaskTool('TodoWrite', { todos: 'not-array' })).toBe(false)
    })
  })

  describe('TaskCreate', () => {
    it('creates with sequential IDs', () => {
      cp.handleTaskTool('TaskCreate', { subject: 'First' })
      cp.handleTaskTool('TaskCreate', { subject: 'Second' })
      expect(cp.tasks.get('1')!.subject).toBe('First')
      expect(cp.tasks.get('2')!.subject).toBe('Second')
    })

    it('defaults to pending status', () => {
      cp.handleTaskTool('TaskCreate', { subject: 'New' })
      expect(cp.tasks.get('1')!.status).toBe('pending')
    })

    it('stores activeForm', () => {
      cp.handleTaskTool('TaskCreate', { subject: 'Do it', activeForm: 'Doing it' })
      expect(cp.tasks.get('1')!.activeForm).toBe('Doing it')
    })
  })

  describe('TaskUpdate', () => {
    beforeEach(() => {
      cp.handleTaskTool('TaskCreate', { subject: 'Task 1' })
    })

    it('updates status', () => {
      cp.handleTaskTool('TaskUpdate', { taskId: '1', status: 'in_progress' })
      expect(cp.tasks.get('1')!.status).toBe('in_progress')
    })

    it('deletes task when status is deleted', () => {
      cp.handleTaskTool('TaskUpdate', { taskId: '1', status: 'deleted' })
      expect(cp.tasks.has('1')).toBe(false)
    })

    it('returns false for nonexistent task', () => {
      expect(cp.handleTaskTool('TaskUpdate', { taskId: '999', status: 'completed' })).toBe(false)
    })

    it('updates subject and activeForm', () => {
      cp.handleTaskTool('TaskUpdate', { taskId: '1', subject: 'Updated', activeForm: 'Updating' })
      expect(cp.tasks.get('1')!.subject).toBe('Updated')
      expect(cp.tasks.get('1')!.activeForm).toBe('Updating')
    })
  })

  it('returns false for unknown tool', () => {
    expect(cp.handleTaskTool('UnknownTool', {})).toBe(false)
  })
})

describe('handleStreamEvent (via handleLine)', () => {
  let cp: CP
  const events: Array<[string, ...unknown[]]> = []

  beforeEach(() => {
    cp = makeCP()
    events.length = 0
    cp.on('tool_active', (name: string, input: string) => events.push(['tool_active', name, input]))
    cp.on('tool_done', (name: string, summary: string) => events.push(['tool_done', name, summary]))
    cp.on('text', (text: string) => events.push(['text', text]))
    cp.on('planning_mode', (active: boolean) => events.push(['planning_mode', active]))
    cp.on('todo_update', (tasks: unknown[]) => events.push(['todo_update', tasks]))
  })

  it('content_block_start with tool_use emits tool_active', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash' },
      },
    }))
    expect(events).toEqual([['tool_active', 'Bash', undefined]])
  })

  it('content_block_delta with text_delta emits text', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }))
    expect(events).toEqual([['text', 'Hello']])
  })

  it('input_json_delta accumulates tool input', () => {
    // Start a tool
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash' },
      },
    }))
    // Send partial JSON
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"com' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: 'mand":"ls"}' },
      },
    }))
    // Stop → tool_done with summary
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))
    const donePair = events.find(e => e[0] === 'tool_done')
    expect(donePair).toEqual(['tool_done', 'Bash', '$ ls'])
  })

  it('content_block_stop emits tool_done and resets state', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Read' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/foo.ts"}' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))
    expect(cp.currentToolName).toBeNull()
    expect(cp.currentToolInput).toBe('')
  })

  it('EnterPlanMode emits planning_mode true', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'EnterPlanMode' },
      },
    }))
    expect(events).toEqual([['planning_mode', true]])
  })

  it('ExitPlanMode defers planning_mode false until tool_result', () => {
    // content_block_start should NOT immediately emit planning_mode false
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_exit1', name: 'ExitPlanMode' },
      },
    }))
    expect(events).toEqual([])

    // Successful tool_result should emit planning_mode false
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_exit1', content: '', is_error: false }],
      },
    }))
    expect(events).toEqual([['planning_mode', false]])
  })

  it('ExitPlanMode denied does not emit planning_mode false', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_exit2', name: 'ExitPlanMode' },
      },
    }))
    expect(events).toEqual([])

    // Error tool_result (denied by hook) should NOT emit planning_mode false
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_exit2', content: 'Denied by user', is_error: true }],
      },
    }))
    expect(events).toEqual([])

    // Result event should clear the flag without emitting planning_mode:false
    // (plan mode stays active because the exit was denied)
    cp.handleLine(JSON.stringify({
      type: 'result',
      result: 'Plan mode exit was denied',
      is_error: true,
    }))
    const planEvents = events.filter(e => e[0] === 'planning_mode')
    expect(planEvents).toEqual([])
  })

  it('ExitPlanMode with no tool_result emits planning_mode false on result (control tool)', () => {
    // ExitPlanMode is a control tool that may not produce a tool_result.
    // If approved (no denial seen), the result handler should emit planning_mode:false.
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_exit3', name: 'ExitPlanMode' },
      },
    }))
    expect(events).toEqual([])

    // Result arrives without a matching tool_result — tool was approved but
    // no tool_result was emitted (normal for control tools).
    cp.handleLine(JSON.stringify({
      type: 'result',
      result: '',
      is_error: false,
    }))
    const planEvents = events.filter(e => e[0] === 'planning_mode')
    expect(planEvents).toEqual([['planning_mode', false]])
  })

  it('ExitPlanMode via control_request emits planning_mode false', () => {
    const { cp: cpWithStdin } = makeCPWithStdin()
    const ctrlEvents: Array<[string, boolean]> = []
    cpWithStdin.on('planning_mode', (active: boolean) => ctrlEvents.push(['planning_mode', active]))

    // content_block_start sets pendingExitPlanModeId
    cpWithStdin.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_exit_ctrl', name: 'ExitPlanMode' },
      },
    }))

    // control_request for ExitPlanMode should auto-approve AND emit planning_mode:false
    cpWithStdin.handleLine(JSON.stringify({
      type: 'control_request',
      request_id: 'req_exit1',
      request: { type: 'tool', tool_name: 'ExitPlanMode', input: {} },
    }))

    expect(ctrlEvents).toEqual([['planning_mode', false]])
  })

  it('malformed JSON in tool input emits graceful tool_done', () => {
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{broken' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))
    // Should still emit tool_done (summary will be undefined due to parse error)
    const donePair = events.find(e => e[0] === 'tool_done')
    expect(donePair).toBeDefined()
    expect(donePair![1]).toBe('Bash')
    expect(donePair![2]).toBeUndefined()
  })

  it('malformed line is silently ignored', () => {
    cp.handleLine('not valid json at all')
    expect(events).toEqual([])
  })

  it('TaskCreate via stream emits todo_update', () => {
    // Simulate a TaskCreate tool call through the stream
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'TaskCreate' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"subject":"Do stuff"}' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))
    const todoEvt = events.find(e => e[0] === 'todo_update')
    expect(todoEvt).toBeDefined()
    const tasks = todoEvt![1] as Array<{ subject: string }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0].subject).toBe('Do stuff')
  })
})

describe('extractThinkingSummary', () => {
  it('returns null for short text', () => {
    const cp = makeCP()
    expect(cp.extractThinkingSummary('hi')).toBeNull()
  })

  it('extracts first sentence', () => {
    const cp = makeCP()
    expect(cp.extractThinkingSummary('Let me analyze the code. Then I will fix it.'))
      .toBe('Let me analyze the code.')
  })

  it('truncates to word boundary for long text without sentence end', () => {
    const cp = makeCP()
    const longText = 'I need to understand how the streaming protocol works and what messages are sent during the thinking phase'
    const result = cp.extractThinkingSummary(longText)
    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(80)
    expect(result!.endsWith(' ')).toBe(false) // shouldn't end with space
  })
})

describe('thinking block streaming', () => {
  it('emits thinking event with summary from thinking deltas', () => {
    const cp = makeCP()
    const summaries: string[] = []
    cp.on('thinking', (s: string) => summaries.push(s))

    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      },
    }))

    // Send enough thinking text
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me look at the streaming protocol. Then I will check the server.' },
      },
    }))

    expect(summaries.length).toBe(1)
    expect(summaries[0]).toBe('Let me look at the streaming protocol.')

    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))
  })

  it('does not emit text for thinking deltas', () => {
    const cp = makeCP()
    const texts: string[] = []
    cp.on('text', (t: string) => texts.push(t))

    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'some thinking text here' },
      },
    }))
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))

    expect(texts).toHaveLength(0)
  })
})

describe('user events (tool results via handleLine)', () => {
  let cp: CP
  const events: Array<[string, ...unknown[]]> = []

  beforeEach(() => {
    cp = makeCP()
    events.length = 0
    cp.on('tool_output', (content: string, isError: boolean) => events.push(['tool_output', content, isError]))
  })

  it('emits tool_result content as tool_output', () => {
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_123',
          content: 'On branch main\nnothing to commit',
        }],
      },
    }))
    expect(events).toHaveLength(1)
    expect(events[0][0]).toBe('tool_output')
    expect(events[0][1]).toContain('On branch main')
    expect(events[0][2]).toBe(false) // not an error
  })

  it('emits isError=true for error tool results', () => {
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_err',
          content: 'command not found',
          is_error: true,
        }],
      },
    }))
    expect(events).toHaveLength(1)
    expect(events[0][2]).toBe(true)
  })

  it('skips empty tool_result content', () => {
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_456',
          content: '   ',
        }],
      },
    }))
    expect(events).toHaveLength(0)
  })

  it('handles non-string content by JSON-stringifying', () => {
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_789',
          content: [{ type: 'text', text: 'result data' }],
        }],
      },
    }))
    expect(events).toHaveLength(1)
    expect(events[0][1]).toContain('result data')
  })

  it('ignores user events without content', () => {
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: { role: 'user' },
    }))
    expect(events).toHaveLength(0)
  })
})

describe('system and result events (via handleLine)', () => {
  it('system init emits system_init with model', () => {
    const cp = makeCP()
    const models: string[] = []
    cp.on('system_init', (m: string) => models.push(m))
    cp.handleLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-6',
      session_id: 'abc',
    }))
    expect(models).toEqual(['claude-opus-4-6'])
  })

  it('result event emits result', () => {
    const cp = makeCP()
    const results: [string, boolean][] = []
    cp.on('result', (text: string, err: boolean) => results.push([text, err]))
    cp.handleLine(JSON.stringify({
      type: 'result',
      result: 'done',
      is_error: false,
    }))
    expect(results).toEqual([['done', false]])
  })
})

// ============================================================
// NEW TESTS — coverage improvements
// ============================================================

describe('handleControlRequest', () => {
  let cp: CP

  beforeEach(() => {
    cp = makeCP()
    cp.sendControlResponse = vi.fn()
  })

  describe('AskUserQuestion', () => {
    it('should emit prompt with requestId for a question', () => {
      const prompts: unknown[][] = []
      cp.on('prompt', (...args: unknown[]) => prompts.push(args))

      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which file?',
                options: [
                  { label: 'foo.ts', description: 'The foo file' },
                  { label: 'bar.ts', description: 'The bar file' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      }))

      expect(prompts).toHaveLength(1)
      expect(prompts[0][0]).toBe('question')
      expect(prompts[0][1]).toBe('Which file?')
      // options should be mapped with value = label
      const options = prompts[0][2] as Array<{ label: string; value: string; description?: string }>
      expect(options).toHaveLength(2)
      expect(options[0].label).toBe('foo.ts')
      expect(options[0].value).toBe('foo.ts')
      expect(options[0].description).toBe('The foo file')
      // multiSelect
      expect(prompts[0][3]).toBe(false)
      // requestId is the last argument
      expect(prompts[0][6]).toBe('req-1')
      // sendControlResponse should NOT be called (not auto-approved)
      expect(cp.sendControlResponse).not.toHaveBeenCalled()
    })

    it('should emit prompts for multiple questions', () => {
      const prompts: unknown[][] = []
      cp.on('prompt', (...args: unknown[]) => prompts.push(args))

      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-multi',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              { question: 'Q1', options: [] },
              { question: 'Q2', options: [{ label: 'Yes' }] },
            ],
          },
        },
      }))

      expect(prompts).toHaveLength(1)
      // Single prompt emitted with first question's text, all questions bundled in last arg
      expect(prompts[0][1]).toBe('Q1')
      const structuredQuestions = prompts[0][7] as Array<{ question: string }>
      expect(structuredQuestions).toHaveLength(2)
      expect(structuredQuestions[0].question).toBe('Q1')
      expect(structuredQuestions[1].question).toBe('Q2')



    })

    it('should do nothing when questions array is empty', () => {
      const prompts: unknown[][] = []
      cp.on('prompt', (...args: unknown[]) => prompts.push(args))

      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-empty',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [] },
        },
      }))

      expect(prompts).toHaveLength(0)
      expect(cp.sendControlResponse).not.toHaveBeenCalled()
    })

    it('should do nothing when questions is not an array', () => {
      const prompts: unknown[][] = []
      cp.on('prompt', (...args: unknown[]) => prompts.push(args))

      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-bad',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'AskUserQuestion',
          input: { questions: 'not-an-array' },
        },
      }))

      expect(prompts).toHaveLength(0)
    })
  })

  describe('Bash', () => {
    it('should emit control_request for forwarding to session manager', () => {
      const controlRequests: unknown[][] = []
      cp.on('control_request', (...args: unknown[]) => controlRequests.push(args))

      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-bash-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/test' },
        },
      }))

      expect(controlRequests).toHaveLength(1)
      expect(controlRequests[0][0]).toBe('req-bash-1')
      expect(controlRequests[0][1]).toBe('Bash')
      expect(controlRequests[0][2]).toEqual({ command: 'rm -rf /tmp/test' })
      // Should NOT auto-approve
      expect(cp.sendControlResponse).not.toHaveBeenCalled()
    })
  })

  describe('other tools (auto-approve)', () => {
    it('should auto-approve Write tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-write-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Write',
          input: { file_path: '/tmp/foo.ts', content: 'hello' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-write-1', 'allow')
    })

    it('should auto-approve Edit tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-edit-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Edit',
          input: { file_path: '/tmp/bar.ts' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-edit-1', 'allow')
    })

    it('should auto-approve Read tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-read-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Read',
          input: { file_path: '/tmp/baz.ts' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-read-1', 'allow')
    })

    it('should auto-approve Glob tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-glob-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Glob',
          input: { pattern: '**/*.ts' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-glob-1', 'allow')
    })

    it('should auto-approve Grep tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-grep-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Grep',
          input: { pattern: 'TODO' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-grep-1', 'allow')
    })

    it('should auto-approve Task tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-task-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'Task',
          input: { description: 'some task' },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-task-1', 'allow')
    })

    it('should auto-approve TodoWrite tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-todo-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'TodoWrite',
          input: { todos: [] },
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-todo-1', 'allow')
    })

    it('should auto-approve EnterPlanMode tool', () => {
      cp.handleLine(JSON.stringify({
        type: 'control_request',
        request_id: 'req-plan-1',
        session_id: 'sess-1',
        request: {
          type: 'tool',
          tool_name: 'EnterPlanMode',
          input: {},
        },
      }))

      expect(cp.sendControlResponse).toHaveBeenCalledWith('req-plan-1', 'allow')
    })
  })
})

describe('sendControlResponse', () => {
  it('should format correct JSON with type, request_id, behavior', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendControlResponse('req-42', 'allow')

    expect(stdinData).toHaveLength(1)
    const parsed = JSON.parse(stdinData[0].replace(/\n$/, ''))
    expect(parsed.type).toBe('control_response')
    expect(parsed.request_id).toBe('req-42')
    expect(parsed.behavior).toBe('allow')
    expect(parsed.updatedInput).toBeUndefined()
    expect(parsed.message).toBeUndefined()
  })

  it('should include updatedInput when provided', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendControlResponse('req-43', 'allow', { command: 'echo safe' })

    const parsed = JSON.parse(stdinData[0].replace(/\n$/, ''))
    expect(parsed.updatedInput).toEqual({ command: 'echo safe' })
  })

  it('should include message when provided', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendControlResponse('req-44', 'deny', undefined, 'Not allowed')

    const parsed = JSON.parse(stdinData[0].replace(/\n$/, ''))
    expect(parsed.behavior).toBe('deny')
    expect(parsed.message).toBe('Not allowed')
    expect(parsed.updatedInput).toBeUndefined()
  })

  it('should include both updatedInput and message when provided', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendControlResponse('req-45', 'allow', { file_path: '/new' }, 'Modified input')

    const parsed = JSON.parse(stdinData[0].replace(/\n$/, ''))
    expect(parsed.updatedInput).toEqual({ file_path: '/new' })
    expect(parsed.message).toBe('Modified input')
  })
})

describe('sendMessage', () => {
  it('should write JSON message to stdin', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendMessage('Hello Claude')

    expect(stdinData).toHaveLength(1)
    const parsed = JSON.parse(stdinData[0].replace(/\n$/, ''))
    expect(parsed.type).toBe('user')
    expect(parsed.message.role).toBe('user')
    expect(parsed.message.content).toBe('Hello Claude')
  })

  it('should append newline to the written data', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendMessage('test')

    expect(stdinData[0].endsWith('\n')).toBe(true)
  })

  it('should emit error when stdin is not writable', () => {
    const cp = makeCP()
    const errors: string[] = []
    cp.on('error', (e: string) => errors.push(e))

    // proc is null by default, so stdin is not writable
    cp.sendMessage('test')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Claude process stdin is not writable')
  })

  it('should emit error when stdin.writable is false', () => {
    const cp = makeCP()
    cp.proc = {
      stdin: { writable: false, write: vi.fn(), once: vi.fn() },
      kill: vi.fn(),
    }
    const errors: string[] = []
    cp.on('error', (e: string) => errors.push(e))

    cp.sendMessage('test')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Claude process stdin is not writable')
  })

  it('should call stdin.once drain when write returns false', () => {
    const cp = makeCP()
    const onceFn = vi.fn()
    cp.proc = {
      stdin: {
        writable: true,
        write: vi.fn(() => false),
        once: onceFn,
      },
      kill: vi.fn(),
    }

    cp.sendMessage('backpressure test')

    expect(onceFn).toHaveBeenCalledWith('drain', expect.any(Function))
  })
})

describe('sendRaw', () => {
  it('should write raw string to stdin with newline', () => {
    const { cp, stdinData } = makeCPWithStdin()

    cp.sendRaw('{"type":"custom"}')

    expect(stdinData).toHaveLength(1)
    expect(stdinData[0]).toBe('{"type":"custom"}\n')
  })

  it('should do nothing when proc is null', () => {
    const cp = makeCP()
    // proc is null by default; should not throw
    expect(() => cp.sendRaw('test')).not.toThrow()
  })

  it('should do nothing when stdin is not writable', () => {
    const cp = makeCP()
    cp.proc = {
      stdin: { writable: false, write: vi.fn(), once: vi.fn() },
      kill: vi.fn(),
    }

    cp.sendRaw('test')

    expect(cp.proc.stdin.write).not.toHaveBeenCalled()
  })

  it('should call stdin.once drain when write returns false', () => {
    const cp = makeCP()
    const onceFn = vi.fn()
    cp.proc = {
      stdin: {
        writable: true,
        write: vi.fn(() => false),
        once: onceFn,
      },
      kill: vi.fn(),
    }

    cp.sendRaw('backpressure')

    expect(onceFn).toHaveBeenCalledWith('drain', expect.any(Function))
  })
})

describe('summarizeToolInput — additional tool cases', () => {
  const cp = makeCP()

  it('Task: returns description', () => {
    expect(cp.summarizeToolInput('Task', { description: 'Investigate the bug' }))
      .toBe('Investigate the bug')
  })

  it('Task: returns empty string when no description', () => {
    expect(cp.summarizeToolInput('Task', {}))
      .toBe('')
  })

  it('EnterPlanMode: returns "Entering plan mode"', () => {
    expect(cp.summarizeToolInput('EnterPlanMode', {}))
      .toBe('Entering plan mode')
  })

  it('ExitPlanMode: returns "Exiting plan mode"', () => {
    expect(cp.summarizeToolInput('ExitPlanMode', {}))
      .toBe('Exiting plan mode')
  })

  it('TaskList: returns "Listing tasks"', () => {
    expect(cp.summarizeToolInput('TaskList', {}))
      .toBe('Listing tasks')
  })

  it('TaskGet: returns #taskId', () => {
    expect(cp.summarizeToolInput('TaskGet', { taskId: '7' }))
      .toBe('#7')
  })

  it('TaskGet: returns # when taskId is missing', () => {
    expect(cp.summarizeToolInput('TaskGet', {}))
      .toBe('#')
  })

  it('TodoRead: returns "Reading tasks"', () => {
    expect(cp.summarizeToolInput('TodoRead', {}))
      .toBe('Reading tasks')
  })

  it('TodoWrite: returns empty string when todos is undefined', () => {
    expect(cp.summarizeToolInput('TodoWrite', {}))
      .toBe('')
  })
})

describe('tool output truncation in handleUserEvent', () => {
  it('should truncate content longer than 2000 chars', () => {
    const cp = makeCP()
    const outputs: [string, boolean][] = []
    cp.on('tool_output', (content: string, isError: boolean) => outputs.push([content, isError]))

    const longContent = 'x'.repeat(3000)
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_long',
          content: longContent,
        }],
      },
    }))

    expect(outputs).toHaveLength(1)
    const [emitted] = outputs[0]
    // Should be truncated to 2000 chars + truncation message
    expect(emitted.length).toBeLessThan(longContent.length)
    expect(emitted).toContain('truncated')
    expect(emitted).toContain('3000 chars total')
    // First 2000 chars should be intact
    expect(emitted.startsWith('x'.repeat(2000))).toBe(true)
  })

  it('should not truncate content at exactly 2000 chars', () => {
    const cp = makeCP()
    const outputs: [string, boolean][] = []
    cp.on('tool_output', (content: string, isError: boolean) => outputs.push([content, isError]))

    const exactContent = 'y'.repeat(2000)
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_exact',
          content: exactContent,
        }],
      },
    }))

    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBe(exactContent)
    expect(outputs[0][0]).not.toContain('truncated')
  })

  it('should not truncate content shorter than 2000 chars', () => {
    const cp = makeCP()
    const outputs: [string, boolean][] = []
    cp.on('tool_output', (content: string, isError: boolean) => outputs.push([content, isError]))

    const shortContent = 'z'.repeat(500)
    cp.handleLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_short',
          content: shortContent,
        }],
      },
    }))

    expect(outputs).toHaveLength(1)
    expect(outputs[0][0]).toBe(shortContent)
  })
})

describe('extractThinkingSummary — edge cases', () => {
  const cp = makeCP()

  it('extracts sentence ending with newline', () => {
    const result = cp.extractThinkingSummary('Let me think about this\nThen do something else')
    expect(result).toBe('Let me think about this')
  })

  it('extracts sentence ending with exclamation mark', () => {
    const result = cp.extractThinkingSummary('This is interesting! Let me investigate further.')
    expect(result).toBe('This is interesting!')
  })

  it('extracts sentence ending with question mark', () => {
    const result = cp.extractThinkingSummary('What should I do here? Maybe check the logs.')
    expect(result).toBe('What should I do here?')
  })

  it('returns null for text between 20-60 chars with no sentence boundary', () => {
    // 25 chars, no period/newline/!/? and under 60 chars
    const text = 'just some words flowing on'
    expect(text.length).toBeGreaterThanOrEqual(20)
    expect(text.length).toBeLessThan(60)
    const result = cp.extractThinkingSummary(text)
    expect(result).toBeNull()
  })

  it('returns null for exactly 19 chars', () => {
    const text = '1234567890123456789'
    expect(text.length).toBe(19)
    expect(cp.extractThinkingSummary(text)).toBeNull()
  })

  it('handles sentence at exactly 120 chars', () => {
    // Create a sentence that ends with period at exactly 120 chars
    const sentence = 'a'.repeat(119) + '.'
    expect(sentence.length).toBe(120)
    const result = cp.extractThinkingSummary(sentence)
    expect(result).toBe(sentence)
  })

  it('falls back to truncation when first sentence exceeds 120 chars', () => {
    // A single sentence >120 chars with no intermediate sentence boundary
    const longSentence = 'I need to ' + 'a'.repeat(200) + '.'
    const result = cp.extractThinkingSummary(longSentence)
    // Should fall through to the >=60 truncation branch
    expect(result).toBeDefined()
    expect(result!.length).toBeLessThanOrEqual(80)
  })

  it('emits fallback summary on content_block_stop when no sentence was found', () => {
    const cp = makeCP()
    const summaries: string[] = []
    cp.on('thinking', (s: string) => summaries.push(s))

    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      },
    }))

    // Send thinking text that has no sentence boundary and is short (< 60 chars),
    // so extractThinkingSummary returns null during the delta
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hmm let me think about this carefully' },
      },
    }))

    // No summary emitted yet (text is 20+ chars but < 60 without sentence end)
    expect(summaries).toHaveLength(0)

    // On content_block_stop, should emit fallback summary
    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }))

    expect(summaries).toHaveLength(1)
    expect(summaries[0].length).toBeGreaterThan(0)
    expect(summaries[0].length).toBeLessThanOrEqual(80)
  })
})

describe('stop', () => {
  it('should call proc.kill with SIGTERM', () => {
    const { cp } = makeCPWithStdin()

    cp.stop()

    expect(cp.proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('should not throw when proc is null', () => {
    const cp = makeCP()
    // proc is null by default
    expect(() => cp.stop()).not.toThrow()
  })
})

describe('isAlive and getSessionId', () => {
  it('isAlive returns false by default', () => {
    const cp = makeCP()
    expect(cp.isAlive()).toBe(false)
  })

  it('getSessionId returns the session ID', () => {
    const cp = new ClaudeProcess('/tmp', 'my-session-id') as CP
    expect(cp.getSessionId()).toBe('my-session-id')
  })

  it('getSessionId returns a UUID when no sessionId provided', () => {
    const cp = makeCP()
    const id = cp.getSessionId()
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('constructor extraEnv', () => {
  it('stores extraEnv when provided', () => {
    const cp = new ClaudeProcess('/tmp', undefined, { CUSTOM_VAR: 'value' }) as CP
    expect(cp.extraEnv).toEqual({ CUSTOM_VAR: 'value' })
  })

  it('defaults extraEnv to empty object', () => {
    const cp = makeCP()
    expect(cp.extraEnv).toEqual({})
  })
})

describe('handleUserEvent — message with no content field', () => {
  it('ignores user events where message is missing', () => {
    const cp = makeCP()
    const outputs: unknown[] = []
    cp.on('tool_output', (...args: unknown[]) => outputs.push(args))

    // No message at all
    cp.handleLine(JSON.stringify({ type: 'user' }))
    expect(outputs).toHaveLength(0)
  })

  it('ignores user events where message.content is not an array', () => {
    const cp = makeCP()
    const outputs: unknown[] = []
    cp.on('tool_output', (...args: unknown[]) => outputs.push(args))

    cp.handleLine(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'just a string' },
    }))
    // content is a string, not an array, so blocks will be empty array
    // The for loop won't execute
    expect(outputs).toHaveLength(0)
  })
})

describe('system init — edge cases', () => {
  it('updates sessionId from system init event', () => {
    const cp = makeCP()
    const originalId = cp.getSessionId()

    cp.handleLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'new-session-from-server',
      model: 'test-model',
    }))

    expect(cp.getSessionId()).toBe('new-session-from-server')
    expect(cp.getSessionId()).not.toBe(originalId)
  })

  it('defaults model to unknown when not provided', () => {
    const cp = makeCP()
    const models: string[] = []
    cp.on('system_init', (m: string) => models.push(m))

    cp.handleLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
    }))

    expect(models).toEqual(['unknown'])
  })

  it('ignores system events with non-init subtype', () => {
    const cp = makeCP()
    const models: string[] = []
    cp.on('system_init', (m: string) => models.push(m))

    cp.handleLine(JSON.stringify({
      type: 'system',
      subtype: 'something_else',
      model: 'should-not-appear',
    }))

    expect(models).toHaveLength(0)
  })
})

describe('handleStreamEvent — stream_event without inner event', () => {
  it('ignores stream_event with no event field', () => {
    const cp = makeCP()
    const events: unknown[] = []
    cp.on('text', (t: string) => events.push(t))
    cp.on('tool_active', (n: string) => events.push(n))

    cp.handleLine(JSON.stringify({
      type: 'stream_event',
      // no event field
    }))

    expect(events).toHaveLength(0)
  })
})

describe('stop — force kill timeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends SIGKILL after 5 seconds if proc is still set', () => {
    const { cp } = makeCPWithStdin()
    cp.stop()

    expect(cp.proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(cp.proc.kill).not.toHaveBeenCalledWith('SIGKILL')

    vi.advanceTimersByTime(5000)

    expect(cp.proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('does not SIGKILL if proc becomes null before the timeout fires', () => {
    const { cp } = makeCPWithStdin()
    const killMock = cp.proc.kill

    cp.stop()
    // Simulate process exiting naturally before the 5s timeout
    cp.proc = null

    vi.advanceTimersByTime(5000)

    // kill should have been called once (SIGTERM) but NOT SIGKILL
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledWith('SIGTERM')
  })
})
