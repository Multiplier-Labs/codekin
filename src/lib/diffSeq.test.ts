/** Tests for diffSequences — the LCS diff behind Canvas compare. */
import { describe, it, expect } from 'vitest'
import { diffSequences, foldUnchanged } from './diffSeq'

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

describe('foldUnchanged', () => {
  const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  const shape = (rows: ReturnType<typeof foldUnchanged<string>>) => rows.map(r => (r.kind === 'gap' ? `…${r.count}` : `${r.op.op[0]}${r.op.value}`))

  it('keeps context around a change and folds the rest', () => {
    const a = lines(20)
    const b = [...a]; b[10] = 'X'
    expect(shape(foldUnchanged(diffSequences(a, b), 2))).toEqual(['…8', 'sl8', 'sl9', 'dl10', 'aX', 'sl11', 'sl12', '…7'])
  })
  it('folds between two changes, keeping context on both sides', () => {
    const a = lines(20)
    const b = [...a]; b[2] = 'X'; b[17] = 'Y'
    const rows = foldUnchanged(diffSequences(a, b), 1)
    expect(shape(rows)).toEqual(['sl0', 'sl1', 'dl2', 'aX', 'sl3', '…12', 'sl16', 'dl17', 'aY', 'sl18', 'sl19'])
  })
  it('opens a run named in expanded', () => {
    const a = lines(20)
    const b = [...a]; b[10] = 'X'
    const ops = diffSequences(a, b)
    const gap = foldUnchanged(ops, 2).find(r => r.kind === 'gap')!
    const rows = foldUnchanged(ops, 2, new Set([gap.key]))
    expect(rows.filter(r => r.kind === 'gap')).toHaveLength(1)
    // The head run is open; only the tail run (7) is still folded.
    expect(rows.length).toBe(21 - 7 + 1)
  })
  it('never folds a run of one', () => {
    expect(shape(foldUnchanged(diffSequences(['a', 'b', 'c'], ['a', 'x', 'c']), 0))).toEqual(['sa', 'db', 'ax', 'sc'])
  })
})
