import { describe, it, expect } from 'vitest'
import { processMessage, rebuildFromHistory, trimMessages } from './useChatSocket'
import type { ChatMessage, WsServerMessage } from '../types'

function empty(): ChatMessage[] {
  return []
}

describe('processMessage', () => {
  describe('output', () => {
    it('creates new assistant message on empty state', () => {
      const result = processMessage(empty(), { type: 'output', data: 'Hello' } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('assistant')
      expect((result[0] as any).text).toBe('Hello')
      expect((result[0] as any).complete).toBe(false)
    })

    it('appends to incomplete assistant message', () => {
      const msgs: ChatMessage[] = [
        { type: 'assistant', text: 'Hello', complete: false, ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'output', data: ' world' } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect((result[0] as any).text).toBe('Hello world')
    })

    it('creates new assistant if last is complete', () => {
      const msgs: ChatMessage[] = [
        { type: 'assistant', text: 'Done', complete: true, ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'output', data: 'New' } as WsServerMessage)
      expect(result).toHaveLength(2)
      expect((result[1] as any).text).toBe('New')
      expect((result[1] as any).complete).toBe(false)
    })

    it('creates new assistant if last is not assistant', () => {
      const msgs: ChatMessage[] = [
        { type: 'user', text: 'Hi', ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'output', data: 'Reply' } as WsServerMessage)
      expect(result).toHaveLength(2)
      expect(result[1].type).toBe('assistant')
    })
  })

  describe('result', () => {
    it('marks incomplete assistant as complete', () => {
      const msgs: ChatMessage[] = [
        { type: 'assistant', text: 'Hello', complete: false, ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'result' } as WsServerMessage)
      expect((result[0] as any).complete).toBe(true)
    })

    it('no-op if no incomplete assistant', () => {
      const msgs: ChatMessage[] = [
        { type: 'user', text: 'Hi', ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'result' } as WsServerMessage)
      expect(result).toBe(msgs)
    })

    it('no-op if assistant already complete', () => {
      const msgs: ChatMessage[] = [
        { type: 'assistant', text: 'Done', complete: true, ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'result' } as WsServerMessage)
      expect(result).toBe(msgs)
    })
  })

  describe('tool_active', () => {
    it('creates new tool_group', () => {
      const result = processMessage(empty(), { type: 'tool_active', toolName: 'Bash' } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('tool_group')
      const tg = result[0] as ChatMessage & { type: 'tool_group' }
      expect(tg.tools).toEqual([{ name: 'Bash', active: true }])
    })

    it('appends to existing tool_group', () => {
      const msgs: ChatMessage[] = [
        { type: 'tool_group', tools: [{ name: 'Read', active: false }] },
      ]
      const result = processMessage(msgs, { type: 'tool_active', toolName: 'Write' } as WsServerMessage)
      expect(result).toHaveLength(1)
      const tg = result[0] as ChatMessage & { type: 'tool_group' }
      expect(tg.tools).toHaveLength(2)
      expect(tg.tools[1]).toEqual({ name: 'Write', active: true })
    })
  })

  describe('tool_done', () => {
    it('marks matching active tool as inactive with summary (LIFO)', () => {
      const msgs: ChatMessage[] = [
        {
          type: 'tool_group',
          tools: [
            { name: 'Bash', active: true },
            { name: 'Bash', active: true },
          ],
        },
      ]
      const result = processMessage(msgs, { type: 'tool_done', toolName: 'Bash', summary: '$ ls' } as WsServerMessage)
      const tg = result[0] as ChatMessage & { type: 'tool_group' }
      // LIFO: last active Bash gets deactivated
      expect(tg.tools[0].active).toBe(true)
      expect(tg.tools[1].active).toBe(false)
      expect(tg.tools[1].summary).toBe('$ ls')
    })

    it('no-op without tool_group as last message', () => {
      const msgs: ChatMessage[] = [
        { type: 'user', text: 'Hi', ts: 1 },
      ]
      const result = processMessage(msgs, { type: 'tool_done', toolName: 'Bash' } as WsServerMessage)
      expect(result).toBe(msgs)
    })
  })

  describe('planning_mode', () => {
    it('appends planning_mode message', () => {
      const result = processMessage(empty(), { type: 'planning_mode', active: true } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('planning_mode')
      expect((result[0] as any).active).toBe(true)
    })
  })

  describe('todo_update', () => {
    it('returns messages unchanged (handled separately)', () => {
      const msgs = empty()
      const result = processMessage(msgs, { type: 'todo_update', tasks: [] } as WsServerMessage)
      expect(result).toBe(msgs)
    })
  })

  describe('system/user messages', () => {
    it('user_echo creates user message', () => {
      const result = processMessage(empty(), { type: 'user_echo', text: 'Hello' } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('user')
      expect((result[0] as any).text).toBe('Hello')
    })

    it('system_message creates system message', () => {
      const result = processMessage(empty(), {
        type: 'system_message',
        subtype: 'init',
        text: 'Started',
        model: 'claude-opus-4-6',
      } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('system')
      expect((result[0] as any).model).toBe('claude-opus-4-6')
    })

    it('claude_started creates system init message', () => {
      const result = processMessage(empty(), { type: 'claude_started', sessionId: '123' } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('system')
      expect((result[0] as any).subtype).toBe('init')
    })
  })

  describe('tool_output', () => {
    it('appends tool_output message', () => {
      const result = processMessage(empty(), {
        type: 'tool_output',
        content: 'file contents here',
        isError: false,
      } as WsServerMessage)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('tool_output')
      expect((result[0] as any).content).toBe('file contents here')
      expect((result[0] as any).isError).toBe(false)
    })

    it('preserves isError flag', () => {
      const result = processMessage(empty(), {
        type: 'tool_output',
        content: 'Error: not found',
        isError: true,
      } as WsServerMessage)
      expect((result[0] as any).isError).toBe(true)
    })
  })

  describe('tool_done edge cases', () => {
    it('no change when tool name does not match any active tool', () => {
      const msgs: ChatMessage[] = [
        {
          type: 'tool_group',
          tools: [{ name: 'Read', active: true }],
        },
      ]
      const result = processMessage(msgs, {
        type: 'tool_done',
        toolName: 'Write',
        summary: 'done',
      } as WsServerMessage)
      const tg = result[0] as ChatMessage & { type: 'tool_group' }
      expect(tg.tools[0].active).toBe(true)
      expect(tg.tools[0].name).toBe('Read')
    })
  })

  describe('unknown type', () => {
    it('returns messages unchanged', () => {
      const msgs = empty()
      const result = processMessage(msgs, { type: 'pong' } as WsServerMessage)
      expect(result).toBe(msgs)
    })
  })
})

describe('trimMessages', () => {
  it('returns messages unchanged when below limit', () => {
    const msgs: ChatMessage[] = [
      { type: 'user', text: 'Hi', ts: 1 },
    ]
    expect(trimMessages(msgs)).toBe(msgs)
  })

  it('returns messages unchanged when exactly at limit', () => {
    const msgs: ChatMessage[] = Array.from({ length: 500 }, (_, i) => ({
      type: 'user' as const,
      text: `msg-${i}`,
      ts: i,
    }))
    expect(trimMessages(msgs)).toBe(msgs)
  })

  it('trims and prepends notice when over limit', () => {
    const msgs: ChatMessage[] = Array.from({ length: 501 }, (_, i) => ({
      type: 'user' as const,
      text: `msg-${i}`,
      ts: i,
    }))
    const result = trimMessages(msgs)
    expect(result).toHaveLength(500)
    expect(result[0].type).toBe('system')
    expect((result[0] as any).subtype).toBe('trim')
    expect((result[0] as any).text).toBe('Older messages trimmed')
    // Last message should be the original last
    expect((result[result.length - 1] as any).text).toBe('msg-500')
  })
})

describe('processMessage stable keys', () => {
  it('assigns unique keys to new messages', () => {
    let msgs = processMessage(empty(), { type: 'user_echo', text: 'Hi' } as WsServerMessage)
    msgs = processMessage(msgs, { type: 'output', data: 'Hello' } as WsServerMessage)
    expect((msgs[0] as any).key).toBeTruthy()
    expect((msgs[1] as any).key).toBeTruthy()
    expect((msgs[0] as any).key).not.toBe((msgs[1] as any).key)
  })

  it('preserves key when appending to assistant message', () => {
    let msgs = processMessage(empty(), { type: 'output', data: 'Hello' } as WsServerMessage)
    const originalKey = (msgs[0] as any).key
    msgs = processMessage(msgs, { type: 'output', data: ' world' } as WsServerMessage)
    expect((msgs[0] as any).key).toBe(originalKey)
  })
})

describe('rebuildFromHistory', () => {
  it('returns empty array for empty buffer', () => {
    expect(rebuildFromHistory([])).toEqual([])
  })

  it('handles single output message', () => {
    const result = rebuildFromHistory([
      { type: 'output', data: 'Hello' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('assistant')
    expect((result[0] as any).text).toBe('Hello')
    expect((result[0] as any).complete).toBe(false)
  })

  it('concatenates consecutive output messages via mutation', () => {
    const result = rebuildFromHistory([
      { type: 'output', data: 'Hello' } as WsServerMessage,
      { type: 'output', data: ' world' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect((result[0] as any).text).toBe('Hello world')
  })

  it('marks assistant complete on result', () => {
    const result = rebuildFromHistory([
      { type: 'output', data: 'Done' } as WsServerMessage,
      { type: 'result' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect((result[0] as any).complete).toBe(true)
  })

  it('result is no-op without prior incomplete assistant', () => {
    const result = rebuildFromHistory([
      { type: 'result' } as WsServerMessage,
    ])
    expect(result).toEqual([])
  })

  it('result is no-op when last assistant is already complete', () => {
    const result = rebuildFromHistory([
      { type: 'output', data: 'Hi' } as WsServerMessage,
      { type: 'result' } as WsServerMessage,
      { type: 'result' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect((result[0] as any).complete).toBe(true)
  })

  it('creates new assistant after result', () => {
    const result = rebuildFromHistory([
      { type: 'output', data: 'First' } as WsServerMessage,
      { type: 'result' } as WsServerMessage,
      { type: 'output', data: 'Second' } as WsServerMessage,
    ])
    expect(result).toHaveLength(2)
    expect((result[0] as any).text).toBe('First')
    expect((result[0] as any).complete).toBe(true)
    expect((result[1] as any).text).toBe('Second')
    expect((result[1] as any).complete).toBe(false)
  })

  it('handles system_message', () => {
    const result = rebuildFromHistory([
      { type: 'system_message', subtype: 'init', text: 'Started', model: 'opus' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('system')
    expect((result[0] as any).subtype).toBe('init')
    expect((result[0] as any).model).toBe('opus')
  })

  it('handles user_echo', () => {
    const result = rebuildFromHistory([
      { type: 'user_echo', text: 'User input' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('user')
    expect((result[0] as any).text).toBe('User input')
  })

  it('handles claude_started', () => {
    const result = rebuildFromHistory([
      { type: 'claude_started', sessionId: 's1' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('system')
    expect((result[0] as any).subtype).toBe('init')
  })

  it('builds tool_group from tool_active', () => {
    const result = rebuildFromHistory([
      { type: 'tool_active', toolName: 'Bash' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('tool_group')
    const tg = result[0] as ChatMessage & { type: 'tool_group' }
    expect(tg.tools).toEqual([{ name: 'Bash', active: true }])
  })

  it('appends to existing tool_group for consecutive tool_active', () => {
    const result = rebuildFromHistory([
      { type: 'tool_active', toolName: 'Read' } as WsServerMessage,
      { type: 'tool_active', toolName: 'Write' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    const tg = result[0] as ChatMessage & { type: 'tool_group' }
    expect(tg.tools).toHaveLength(2)
    expect(tg.tools[0].name).toBe('Read')
    expect(tg.tools[1].name).toBe('Write')
  })

  it('creates new tool_group when last message is not tool_group', () => {
    const result = rebuildFromHistory([
      { type: 'user_echo', text: 'Hi' } as WsServerMessage,
      { type: 'tool_active', toolName: 'Bash' } as WsServerMessage,
    ])
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('user')
    expect(result[1].type).toBe('tool_group')
  })

  it('marks tool as done via tool_done (LIFO)', () => {
    const result = rebuildFromHistory([
      { type: 'tool_active', toolName: 'Bash' } as WsServerMessage,
      { type: 'tool_active', toolName: 'Bash' } as WsServerMessage,
      { type: 'tool_done', toolName: 'Bash', summary: 'ls' } as WsServerMessage,
    ])
    const tg = result[0] as ChatMessage & { type: 'tool_group' }
    expect(tg.tools[0].active).toBe(true)
    expect(tg.tools[1].active).toBe(false)
    expect(tg.tools[1].summary).toBe('ls')
  })

  it('tool_done is no-op when last message is not tool_group', () => {
    const result = rebuildFromHistory([
      { type: 'user_echo', text: 'Hi' } as WsServerMessage,
      { type: 'tool_done', toolName: 'Bash' } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('user')
  })

  it('handles tool_output', () => {
    const result = rebuildFromHistory([
      { type: 'tool_output', content: 'file contents', isError: false } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('tool_output')
    expect((result[0] as any).content).toBe('file contents')
    expect((result[0] as any).isError).toBe(false)
  })

  it('handles planning_mode', () => {
    const result = rebuildFromHistory([
      { type: 'planning_mode', active: true } as WsServerMessage,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('planning_mode')
    expect((result[0] as any).active).toBe(true)
  })

  it('skips unknown message types', () => {
    const result = rebuildFromHistory([
      { type: 'todo_update', tasks: [] } as WsServerMessage,
      { type: 'pong' } as WsServerMessage,
    ])
    expect(result).toEqual([])
  })

  it('rebuilds a full conversation sequence', () => {
    const buffer: WsServerMessage[] = [
      { type: 'claude_started', sessionId: 's1' } as WsServerMessage,
      { type: 'system_message', subtype: 'init', text: 'Ready', model: 'opus' } as WsServerMessage,
      { type: 'user_echo', text: 'Help me' } as WsServerMessage,
      { type: 'output', data: 'Sure' } as WsServerMessage,
      { type: 'output', data: ', I can help.' } as WsServerMessage,
      { type: 'tool_active', toolName: 'Read' } as WsServerMessage,
      { type: 'tool_done', toolName: 'Read', summary: 'file.ts' } as WsServerMessage,
      { type: 'output', data: 'Here it is.' } as WsServerMessage,
      { type: 'result' } as WsServerMessage,
    ]
    const result = rebuildFromHistory(buffer)
    expect(result).toHaveLength(6)
    expect(result[0].type).toBe('system')       // claude_started
    expect(result[1].type).toBe('system')       // system_message
    expect(result[2].type).toBe('user')          // user_echo
    expect(result[3].type).toBe('assistant')     // "Sure, I can help." (incomplete — tool_active broke the chain)
    expect((result[3] as any).text).toBe('Sure, I can help.')
    expect((result[3] as any).complete).toBe(false)
    expect(result[4].type).toBe('tool_group')    // Read tool
    expect(result[5].type).toBe('assistant')     // "Here it is." — marked complete by result
    expect((result[5] as any).text).toBe('Here it is.')
    expect((result[5] as any).complete).toBe(true)
  })
})
