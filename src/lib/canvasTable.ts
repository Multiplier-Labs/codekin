/**
 * Table items (docs/CANVAS-SPEC.md §2): parse CSV (RFC 4180 quoting), TSV
 * or a JSON array of objects into columns and string rows, and sort them.
 */

export interface ParsedTable {
  columns: string[]
  rows: string[][]
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function parseTable(content: string, mediaType: string): ParsedTable {
  if (mediaType === 'application/json') {
    const data = JSON.parse(content) as Array<Record<string, unknown>>
    const columns: string[] = []
    for (const record of data) for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key)
    return { columns, rows: data.map(record => columns.map(c => cell(record[c]))) }
  }
  const lines = mediaType === 'text/tab-separated-values'
    ? content.split(/\r?\n/).filter(l => l !== '').map(l => l.split('\t'))
    : parseCsv(content)
  const [header = [], ...rows] = lines
  const width = Math.max(header.length, ...rows.map(r => r.length))
  const columns = Array.from({ length: width }, (_, i) => header[i] ?? `Column ${i + 1}`)
  return { columns, rows: rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? '')) }
}

const NUMERIC = /^\s*[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?\s*(%|ms|s|kb|mb|gb)?\s*$/i

/** A column is numeric when every non-empty cell looks like a number. */
export function isNumericColumn(rows: string[][], index: number): boolean {
  let seen = false
  for (const r of rows) {
    const v = r[index]
    if (v === '') continue
    if (!NUMERIC.test(v)) return false
    seen = true
  }
  return seen
}

function numberOf(v: string): number {
  return parseFloat(v.replace(/,/g, ''))
}

/** Sort rows by a column: numerically when the column is numeric, else by locale; empty cells last. */
export function sortRows(rows: string[][], index: number, dir: 'asc' | 'desc', numeric: boolean): string[][] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[index]
    const y = b[index]
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1
    return sign * (numeric ? numberOf(x) - numberOf(y) : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }))
  })
}

/** Selected rows as a Markdown table the agent can read. */
export function rowsExcerpt(columns: string[], rows: string[][]): string {
  const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `| ${columns.map(esc).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n')
}
