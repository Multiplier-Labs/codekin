/**
 * Tests for the pure Grok ACP mappers. Inputs mirror messages captured from
 * grok 1.0.44 (`grok agent --no-leader stdio`), trimmed to the fields read.
 */
import { describe, it, expect } from 'vitest'
import {
  grokModeIdFor,
  isYoloMode,
  modelsFromState,
  normalizeGrokTool,
  pickPermissionOption,
  planEntriesToTasks,
  resultForStopReason,
  sessionMetaForMode,
  toolContentPaths,
  toolContentText,
  usageFromPromptResult,
} from './grok-acp.js'

const shellOptions = [
  { optionId: 'always-allow', name: "Yes, and don't ask again for bash commands", kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
  { optionId: 'reject-always', name: "No, and don't ask again for this command", kind: 'reject_always' },
]
const editOptions = [
  { optionId: 'allow-edits-session', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
]

describe('normalizeGrokTool', () => {
  it('classifies the first shell tool_call from _meta only', () => {
    expect(normalizeGrokTool({
      toolCallId: 'call-1',
      title: 'run_terminal_command',
      rawInput: { command: 'echo hi > shell.txt', description: 'Write hi into shell.txt' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', read_only: false } },
    })).toEqual({ name: 'Bash', input: { command: 'echo hi > shell.txt', description: 'Write hi into shell.txt' } })
  })

  it('classifies a permission request by rawInput.variant', () => {
    expect(normalizeGrokTool({
      kind: 'execute',
      title: 'Execute `rm -f after.txt`',
      rawInput: { variant: 'Bash', command: 'rm -f after.txt', is_background: false },
    })).toEqual({ name: 'Bash', input: { command: 'rm -f after.txt' } })
  })

  it('maps write, search_replace and read_file to Write, Edit and Read', () => {
    expect(normalizeGrokTool({
      title: 'write',
      rawInput: { file_path: '/r/edit.txt', content: 'x\n' },
      _meta: { 'x.ai/tool': { name: 'write', kind: 'write' } },
    })).toEqual({ name: 'Write', input: { file_path: '/r/edit.txt' } })
    expect(normalizeGrokTool({
      kind: 'edit',
      rawInput: { variant: 'SearchReplace', file_path: '/r/f.txt', old_string: 'beta', new_string: 'gamma', replace_all: false },
    })).toEqual({ name: 'Edit', input: { file_path: '/r/f.txt', old_string: 'beta', new_string: 'gamma' } })
    expect(normalizeGrokTool({
      title: 'read_file',
      rawInput: { target_file: '/r/f.txt' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', read_only: true } },
    })).toEqual({ name: 'Read', input: { file_path: '/r/f.txt' } })
  })

  it('keeps Grok’s own name for unclassified tools', () => {
    expect(normalizeGrokTool({
      title: 'bookgraph__search',
      rawInput: { variant: 'Mcp', query: 'x' },
      _meta: { 'x.ai/tool': { name: 'bookgraph__search', kind: 'other' } },
    })).toEqual({ name: 'bookgraph__search', input: { query: 'x' } })
  })
})

describe('tool content', () => {
  it('extracts text blocks and diff paths', () => {
    const content = [
      { type: 'content', content: { type: 'text', text: 'line 1\n' } },
      { type: 'diff', path: '/r/f.txt', oldText: 'beta', newText: 'gamma' },
      { type: 'content', content: { type: 'text', text: 'line 2' } },
    ]
    expect(toolContentText(content)).toBe('line 1\nline 2')
    expect(toolContentPaths(content)).toEqual(['/r/f.txt'])
    expect(toolContentText(undefined)).toBe('')
  })
})

describe('pickPermissionOption', () => {
  it('answers allow with allow-once and deny with reject-once', () => {
    expect(pickPermissionOption(shellOptions, 'allow')).toBe('allow-once')
    expect(pickPermissionOption(shellOptions, 'deny')).toBe('reject-once')
  })

  it('never selects Grok’s broad allow_always — Codekin remembers the pattern itself', () => {
    expect(pickPermissionOption(shellOptions, 'allow_always')).toBe('allow-once')
    expect(pickPermissionOption(editOptions, 'allow_always')).toBe('allow-once')
  })

  it('falls back to any reject when rejecting, but never widens an allow', () => {
    const onlyBroad = [
      { optionId: 'always-allow', kind: 'allow_always' },
      { optionId: 'reject-always', kind: 'reject_always' },
    ]
    expect(pickPermissionOption(onlyBroad, 'deny')).toBe('reject-always')
    expect(pickPermissionOption(onlyBroad, 'allow')).toBeNull()
  })
})

describe('permission modes', () => {
  it('maps only the bypass modes to yoloMode', () => {
    expect(isYoloMode('bypassPermissions')).toBe(true)
    expect(isYoloMode('dangerouslySkipPermissions')).toBe(true)
    expect(isYoloMode('acceptEdits')).toBe(false)
    expect(sessionMetaForMode('bypassPermissions')).toEqual({ yoloMode: true })
    expect(sessionMetaForMode('default')).toBeUndefined()
    expect(sessionMetaForMode(undefined)).toBeUndefined()
  })

  it('uses Grok’s plan mode only for Codekin plan', () => {
    expect(grokModeIdFor('plan')).toBe('plan')
    expect(grokModeIdFor('acceptEdits')).toBe('default')
    expect(grokModeIdFor(undefined)).toBe('default')
  })
})

describe('resultForStopReason', () => {
  it('treats end_turn and cancelled (including a denied tool) as a normal end', () => {
    expect(resultForStopReason('end_turn')).toEqual({ text: '', isError: false })
    expect(resultForStopReason('cancelled')).toEqual({ text: '', isError: false })
  })

  it('surfaces limit and refusal stops as errors', () => {
    expect(resultForStopReason('max_tokens').isError).toBe(true)
    expect(resultForStopReason('max_turn_requests').isError).toBe(true)
    expect(resultForStopReason('refusal').isError).toBe(true)
    expect(resultForStopReason('something_new')).toEqual({ text: 'Grok stopped: something_new', isError: true })
  })
})

describe('usageFromPromptResult', () => {
  it('converts cost ticks to USD', () => {
    expect(usageFromPromptResult({
      stopReason: 'end_turn',
      _meta: { usage: { inputTokens: 20435, outputTokens: 61, costUsdTicks: 131716000 } },
    })).toEqual({ inputTokens: 20435, outputTokens: 61, costUsd: 0.0131716 })
  })

  it('omits cost when Grok does not report it, and returns null without usage', () => {
    expect(usageFromPromptResult({ _meta: { usage: { inputTokens: 1, outputTokens: 2 } } }))
      .toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(usageFromPromptResult({ stopReason: 'end_turn', _meta: { totalTokens: 0 } })).toBeNull()
    expect(usageFromPromptResult(undefined)).toBeNull()
  })
})

describe('planEntriesToTasks', () => {
  it('maps ACP plan entries to tasks', () => {
    expect(planEntriesToTasks([
      { content: 'Read the code', status: 'completed', priority: 'high' },
      { content: 'Fix the bug', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
      { status: 'pending' },
    ])).toEqual([
      { id: '1', subject: 'Read the code', status: 'completed' },
      { id: '2', subject: 'Fix the bug', status: 'in_progress' },
      { id: '3', subject: 'Test', status: 'pending' },
    ])
    expect(planEntriesToTasks('nope')).toBeNull()
  })
})

describe('modelsFromState', () => {
  it('reads the ACP model state and marks the current model default', () => {
    expect(modelsFromState({
      currentModelId: 'grok-4.7',
      availableModels: [
        { modelId: 'grok-4.7', name: 'Grok 4.7', description: "SpaceXAI's latest frontier model", _meta: { totalContextTokens: 256000 } },
        { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 500000 } },
        { name: 'no id' },
      ],
    })).toEqual([
      { id: 'grok-4.7', name: 'Grok 4.7', description: "SpaceXAI's latest frontier model", isDefault: true, contextTokens: 256000 },
      { id: 'grok-4.6', name: 'Grok 4.6', description: '', isDefault: false, contextTokens: 500000 },
    ])
    expect(modelsFromState(null)).toEqual([])
  })
})
