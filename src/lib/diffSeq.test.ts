/** Tests for diffSequences — the LCS diff behind Canvas compare. */
import { describe, it, expect } from 'vitest'
import { diffSequences } from './diffSeq'

const render = (ops: ReturnType<typeof diffSequences<string>>) => ops.map(o => `${o.op === 'same' ? ' ' : o.op === 'add' ? '+' : '-'}${o.value}`)

describe('diffSequences', () => {
  it('keeps unchanged entries and marks edits in the middle', () => {
    expect(render(diffSequences(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']))).toEqual([' a', '-b', '+x', ' c', ' d', '+e'])
  })
  it('handles empty sides and identical input', () => {
    expect(render(diffSequences([], ['a']))).toEqual(['+a'])
    expect(render(diffSequences(['a'], []))).toEqual(['-a'])
    expect(render(diffSequences(['a', 'b'], ['a', 'b']))).toEqual([' a', ' b'])
  })
  it('compares by key', () => {
    const ops = diffSequences([['1', 'x']], [['1', 'x'], ['2', 'y']], r => r.join(','))
    expect(ops.map(o => o.op)).toEqual(['same', 'add'])
  })
  it('falls back to remove-then-add past the work limit, still correct', () => {
    expect(render(diffSequences(['a', 'b', 'z'], ['c', 'd', 'z'], String, 1))).toEqual(['-a', '-b', '+c', '+d', ' z'])
  })
})
