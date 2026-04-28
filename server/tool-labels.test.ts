import { describe, expect, it } from 'vitest'
import { summarizeToolInput } from './tool-labels.js'

describe('summarizeToolInput', () => {
  describe('bash', () => {
    it('prefixes single-line commands with $', () => {
      expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('$ ls -la')
    })

    it('truncates multi-line commands with ellipsis', () => {
      expect(summarizeToolInput('Bash', { command: 'echo a\necho b' })).toBe('$ echo a...')
    })

    it('handles missing command as empty string', () => {
      expect(summarizeToolInput('bash', {})).toBe('$ ')
    })

    it('is case-insensitive on tool name', () => {
      expect(summarizeToolInput('BASH', { command: 'pwd' })).toBe('$ pwd')
    })
  })

  describe('file-path tools', () => {
    it.each(['Read', 'View', 'Write', 'Edit', 'MultiEdit'])(
      'returns file_path for %s',
      (tool) => {
        expect(summarizeToolInput(tool, { file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts')
      },
    )

    it('falls back to filePath (camelCase)', () => {
      expect(summarizeToolInput('read', { filePath: '/tmp/y.ts' })).toBe('/tmp/y.ts')
    })

    it('returns empty string when neither key present', () => {
      expect(summarizeToolInput('write', {})).toBe('')
    })
  })

  describe('search tools', () => {
    it('returns pattern for Glob', () => {
      expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    })

    it('returns pattern for Grep', () => {
      expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('foo')
    })
  })

  describe('task tools', () => {
    it('returns description for Task', () => {
      expect(summarizeToolInput('Task', { description: 'Investigate' })).toBe('Investigate')
    })

    it('returns subject for TaskCreate', () => {
      expect(summarizeToolInput('TaskCreate', { subject: 'Add feature' })).toBe('Add feature')
    })

    it('formats TaskUpdate as #id → status', () => {
      expect(summarizeToolInput('TaskUpdate', { taskId: 42, status: 'done' })).toBe('#42 → done')
    })

    it('handles missing TaskUpdate fields', () => {
      expect(summarizeToolInput('TaskUpdate', {})).toBe('# → ')
    })

    it('returns static label for TaskList', () => {
      expect(summarizeToolInput('TaskList', {})).toBe('Listing tasks')
    })

    it('formats TaskGet with id prefix', () => {
      expect(summarizeToolInput('TaskGet', { taskId: 7 })).toBe('#7')
    })
  })

  describe('plan-mode tools', () => {
    it('labels EnterPlanMode', () => {
      expect(summarizeToolInput('EnterPlanMode', {})).toBe('Entering plan mode')
    })

    it('labels ExitPlanMode', () => {
      expect(summarizeToolInput('ExitPlanMode', {})).toBe('Exiting plan mode')
    })
  })

  describe('todo tools', () => {
    it('returns task count for TodoWrite', () => {
      expect(summarizeToolInput('TodoWrite', { todos: [{}, {}, {}] })).toBe('3 tasks')
    })

    it('handles missing todos', () => {
      expect(summarizeToolInput('TodoWrite', {})).toBe('')
    })

    it('labels TodoRead', () => {
      expect(summarizeToolInput('TodoRead', {})).toBe('Reading tasks')
    })
  })

  it('returns empty string for unknown tools', () => {
    expect(summarizeToolInput('UnknownTool', { foo: 'bar' })).toBe('')
  })
})
