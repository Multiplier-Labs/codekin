import { describe, it, expect } from 'vitest'
import { deriveActivityLabel } from './deriveActivityLabel'
import type { ChatMessage } from '../types'

describe('deriveActivityLabel', () => {
  it('returns "Writing..." for incomplete assistant', () => {
    const msgs: ChatMessage[] = [
      { type: 'assistant', text: 'Hello', complete: false, ts: 1 },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Writing...')
  })

  it('returns "Running Bash..." for active tool', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Bash', active: true }] },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Running Bash...')
  })

  it('returns "Thinking..." as fallback when processing', () => {
    const msgs: ChatMessage[] = [
      { type: 'assistant', text: 'Done', complete: true, ts: 1 },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Thinking...')
  })

  it('returns undefined when not processing', () => {
    const msgs: ChatMessage[] = [
      { type: 'assistant', text: 'Done', complete: true, ts: 1 },
    ]
    expect(deriveActivityLabel(msgs, false)).toBeUndefined()
  })

  it('returns undefined for empty messages when not processing', () => {
    expect(deriveActivityLabel([], false)).toBeUndefined()
  })

  it('skips planning_mode when searching for active tool', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Read', active: true }] },
      { type: 'planning_mode', active: true },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Running Read...')
  })

  it('stops searching at non-planning_mode, non-tool_group message', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Read', active: true }] },
      { type: 'assistant', text: 'text', complete: true, ts: 1 },
    ]
    // The assistant message (complete) is the last message, so we fall through
    // to isProcessing check. The tool_group before it won't be found because
    // the loop breaks on the non-planning_mode assistant message.
    expect(deriveActivityLabel(msgs, true)).toBe('Thinking...')
  })

  it('finds active tool when all tools in group are done', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Bash', active: false }] },
    ]
    // No active tool found → falls to isProcessing
    expect(deriveActivityLabel(msgs, true)).toBe('Thinking...')
  })

  it('shows thinking summary when available', () => {
    const msgs: ChatMessage[] = [
      { type: 'assistant', text: 'Done', complete: true, ts: 1 },
    ]
    expect(deriveActivityLabel(msgs, true, 'analyzing the streaming protocol')).toBe(
      'Thinking: analyzing the streaming protocol',
    )
  })

  it('falls back to generic Thinking when summary is null', () => {
    const msgs: ChatMessage[] = []
    expect(deriveActivityLabel(msgs, true, null)).toBe('Thinking...')
  })

  it('scans past tool_output to find active tool_group', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Bash', active: true }] },
      { type: 'tool_output', content: 'some output' },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Running Bash...')
  })

  it('scans past multiple tool_outputs to find active tool', () => {
    const msgs: ChatMessage[] = [
      { type: 'tool_group', tools: [{ name: 'Read', active: true }] },
      { type: 'tool_output', content: 'output 1' },
      { type: 'tool_output', content: 'output 2' },
    ]
    expect(deriveActivityLabel(msgs, true)).toBe('Running Read...')
  })
})
