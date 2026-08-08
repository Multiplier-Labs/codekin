import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _findCodexRollout, claudeProjectSlug, readCondensed } from './transcript-readers.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-transcripts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(dir, name)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('claudeProjectSlug', () => {
  it('replaces non-alphanumerics with dashes like the Claude CLI', () => {
    expect(claudeProjectSlug('/srv/repos/Multiplier-Labs/codekin')).toBe('-srv-repos-Multiplier-Labs-codekin')
    expect(claudeProjectSlug('/home/dev/.codekin/workspaces/abc')).toBe('-home-dev--codekin-workspaces-abc')
  })
})

describe('_findCodexRollout', () => {
  it('finds a rollout by thread id suffix, scanning newest day first', () => {
    const day1 = join(dir, '2026', '07', '21')
    const day2 = join(dir, '2026', '08', '05')
    mkdirSync(day1, { recursive: true })
    mkdirSync(day2, { recursive: true })
    writeFileSync(join(day1, 'rollout-2026-07-21T19-32-10-aaa.jsonl'), '')
    writeFileSync(join(day2, 'rollout-2026-08-05T15-32-07-bbb.jsonl'), '')
    expect(_findCodexRollout('bbb', dir)).toBe(join(day2, 'rollout-2026-08-05T15-32-07-bbb.jsonl'))
    expect(_findCodexRollout('aaa', dir)).toBe(join(day1, 'rollout-2026-07-21T19-32-10-aaa.jsonl'))
    expect(_findCodexRollout('missing', dir)).toBeNull()
  })

  it('returns null when the sessions root does not exist', () => {
    expect(_findCodexRollout('x', join(dir, 'nope'))).toBeNull()
  })
})

describe('readCondensed (codex)', () => {
  const rollout = [
    { type: 'session_meta', payload: { id: 'abc', cwd: '/repo' } },
    { type: 'turn_context', payload: {} },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/repo</cwd></environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Research the session storage format' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg --files"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'file-a.ts\nfile-b.ts' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sessions are stored as JSONL rollouts.' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Sessions are stored as JSONL rollouts.' } },
  ]

  it('extracts conversation and tool lines, skipping wrappers and event_msg duplicates', () => {
    const path = writeJsonl('rollout.jsonl', rollout)
    const text = readCondensed(path, 'codex', 100_000)!
    expect(text).toContain('User: Research the session storage format')
    expect(text).toContain('[Tool: exec_command')
    expect(text).toContain('[Tool result: file-a.ts')
    expect(text).toContain('Assistant: Sessions are stored as JSONL rollouts.')
    expect(text).not.toContain('environment_context')
    expect(text).not.toContain('permissions instructions')
    // event_msg duplicate must not double the assistant line
    expect(text.match(/Sessions are stored as JSONL rollouts/g)).toHaveLength(1)
  })

  it('keeps the first user entry and drops middle entries under a tight budget', () => {
    const lines: unknown[] = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'GOAL: build the thing' }] } },
    ]
    for (let i = 0; i < 50; i++) {
      lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `step ${i} ${'x'.repeat(100)}` }] } })
    }
    const path = writeJsonl('big.jsonl', lines)
    const text = readCondensed(path, 'codex', 600)!
    expect(text).toContain('GOAL: build the thing')
    expect(text).toContain('earlier entries omitted')
    expect(text).toContain('step 49')
    expect(text).not.toContain('step 5 ')
  })

  it('returns null for unreadable or empty transcripts', () => {
    expect(readCondensed(join(dir, 'missing.jsonl'), 'codex', 1000)).toBeNull()
    const path = writeJsonl('meta-only.jsonl', [{ type: 'session_meta', payload: {} }])
    expect(readCondensed(path, 'codex', 1000)).toBeNull()
  })
})

describe('readCondensed (claude)', () => {
  const session = [
    { type: 'user', message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '2 tests failed' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The auth check inverts the flag.' }] } },
    { type: 'attachment' },
    { type: 'last-prompt' },
  ]

  it('extracts messages and tool lines, excluding thinking blocks', () => {
    const path = writeJsonl('claude.jsonl', session)
    const text = readCondensed(path, 'claude', 100_000)!
    expect(text).toContain('User: Fix the login bug')
    expect(text).toContain('[Tool: Bash npm test]')
    expect(text).toContain('[Tool result: 2 tests failed]')
    expect(text).toContain('Assistant: The auth check inverts the flag.')
    expect(text).not.toContain('private reasoning')
  })

  it('handles tool_result content given as block arrays', () => {
    const path = writeJsonl('blocks.jsonl', [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'block text result' }] }] } },
    ])
    expect(readCondensed(path, 'claude', 100_000)).toContain('[Tool result: block text result]')
  })

  it('survives malformed lines', () => {
    const path = join(dir, 'bad.jsonl')
    writeFileSync(path, 'not json\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n{broken')
    expect(readCondensed(path, 'claude', 1000)).toContain('User: hello')
  })
})
