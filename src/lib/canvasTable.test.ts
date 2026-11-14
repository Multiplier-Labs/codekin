/** Tests for Canvas table parsing (CSV/TSV/JSON), numeric detection and sorting. */
import { describe, it, expect } from 'vitest'
import { isNumericColumn, parseCsv, parseTable, sortRows } from './canvasTable'

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
