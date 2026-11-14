/** Tests for Canvas table parsing (CSV/TSV/JSON), numeric detection and sorting. */
import { describe, it, expect } from 'vitest'
import { isNumericColumn, parseCsv, parseTable, sortRows, TABLE_LIMITS } from './canvasTable'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines in fields, and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n')).toEqual([
      ['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3'],
    ])
  })
  it('keeps empty fields and drops blank lines', () => {
    expect(parseCsv('a,,c\n\n,b,\n')).toEqual([['a', '', 'c'], ['', 'b', '']])
  })
})

describe('parseTable', () => {
  it('uses the first CSV row as the header and pads ragged rows', () => {
    expect(parseTable('id,ms\na,10\nb', 'text/csv')).toEqual({ columns: ['id', 'ms'], rows: [['a', '10'], ['b', '']] })
    expect(parseTable('id\na,1,extra', 'text/csv').columns).toEqual(['id', 'Column 2', 'Column 3'])
  })
  it('reads TSV', () => {
    expect(parseTable('a\tb\n1\t2\n', 'text/tab-separated-values')).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] })
  })
  it('reads JSON rows, uniting their keys in first-seen order', () => {
    expect(parseTable('[{"a":1,"b":null},{"c":{"x":1},"a":"y"}]', 'application/json')).toEqual({
      columns: ['a', 'b', 'c'], rows: [['1', '', ''], ['y', '', '{"x":1}']],
    })
  })
})

describe('numeric columns and sorting', () => {
  const rows = [['b', '1,200', ''], ['a', '15%', 'x'], ['c', '3.5', 'y'], ['d', '', 'z']]
  it('detects numbers with separators and units, ignoring empty cells', () => {
    expect(isNumericColumn(rows, 1)).toBe(true)
    expect(isNumericColumn(rows, 0)).toBe(false)
    expect(isNumericColumn([['']], 0)).toBe(false)
  })
  it('sorts numerically or naturally, with empty cells last either way', () => {
    expect(sortRows(rows, 1, 'asc', true).map(r => r[0])).toEqual(['c', 'a', 'b', 'd'])
    expect(sortRows(rows, 1, 'desc', true).map(r => r[0])).toEqual(['b', 'a', 'c', 'd'])
    expect(sortRows([['run-10'], ['run-9'], ['run-100']], 0, 'asc', false).map(r => r[0])).toEqual(['run-9', 'run-10', 'run-100'])
    expect(sortRows(rows, 2, 'asc', false).map(r => r[0])).toEqual(['a', 'c', 'd', 'b'])
  })
})

describe('parseTable on large inputs', () => {
  it('handles very many rows and columns without overflowing or slowing down', () => {
    const csv = 'a,b\n' + '1,2\n'.repeat(250_000)
    const start = performance.now()
    expect(parseTable(csv, 'text/csv').rows).toHaveLength(250_000)
    const wide = JSON.stringify([Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i]))])
    expect(parseTable(wide, 'application/json').columns).toHaveLength(TABLE_LIMITS.maxColumns)
    expect(performance.now() - start).toBeLessThan(3000)
  })
})

describe('parseTable limits', () => {
  const cells = (t: { rows: string[][] }) => t.rows.reduce((n, r) => n + r.length, 0)

  it('caps a small JSON input that names many distinct keys (2,000 × 2,000 grid)', () => {
    const content = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ [`k${i}`]: i })))
    expect(content.length).toBeLessThan(30_000)
    const t = parseTable(content, 'application/json')
    expect(t.columns).toHaveLength(TABLE_LIMITS.maxColumns)
    expect(cells(t)).toBeLessThanOrEqual(TABLE_LIMITS.maxCells)
    expect(t.truncated).toEqual({ rows: 2000, columns: 2000 })
  })

  it('caps ragged CSV padding and TSV width', () => {
    const csv = ['a', ...Array.from({ length: 5000 }, (_, i) => (i === 0 ? ','.repeat(4999) : 'x'))].join('\n')
    const t = parseTable(csv, 'text/csv')
    expect(t.columns).toHaveLength(TABLE_LIMITS.maxColumns)
    expect(cells(t)).toBeLessThanOrEqual(TABLE_LIMITS.maxCells)
    expect(t.truncated).toEqual({ rows: 5000, columns: 5000 })
    const tsv = parseTable(['h', '\t'.repeat(999)].join('\n'), 'text/tab-separated-values')
    expect(tsv.columns).toHaveLength(TABLE_LIMITS.maxColumns)
  })

  it('caps the row count, and the rows times columns product', () => {
    const tall = parseTable('n\n' + '1\n'.repeat(TABLE_LIMITS.maxRows + 10), 'text/csv')
    expect(tall.rows).toHaveLength(TABLE_LIMITS.maxRows)
    expect(tall.truncated).toEqual({ rows: TABLE_LIMITS.maxRows + 10, columns: 1 })
    const wide = Array.from({ length: 100 }, (_, i) => `c${i}`).join(',')
    const t = parseTable([wide, ...Array.from({ length: 6000 }, () => '1')].join('\n'), 'text/csv')
    expect(t.rows).toHaveLength(TABLE_LIMITS.maxCells / 100)
    expect(cells(t)).toBeLessThanOrEqual(TABLE_LIMITS.maxCells)
  })

  it('leaves tables within the limits untouched', () => {
    expect(parseTable('a,b\n1,2', 'text/csv')).toEqual({ columns: ['a', 'b'], rows: [['1', '2']] })
    expect(() => parseTable('{"a":1}', 'application/json')).toThrow(/JSON array/)
  })
})
