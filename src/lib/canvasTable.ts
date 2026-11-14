/**
 * Table items (docs/CANVAS-SPEC.md §2): parse CSV (RFC 4180 quoting), TSV
 * or a JSON array of objects into columns and string rows, and sort them.
 */

export interface ParsedTable {
  columns: string[]
  rows: string[][]
  /** Set when the table was cut to TABLE_LIMITS: the full size it had. */
  truncated?: { rows: number; columns: number }
}

/**
 * Every row is padded to every column, so a small input can describe a huge
 * grid (2,000 objects with distinct keys: 4 million cells from 23 KB). The
 * grid is capped before it is built; anything beyond is cut, with a notice.
 */
export const TABLE_LIMITS = { maxColumns: 200, maxRows: 250_000, maxCells: 500_000 }

/** How many rows fit in the limits at a given width. */
function rowBudget(width: number): number {
  return Math.min(TABLE_LIMITS.maxRows, Math.floor(TABLE_LIMITS.maxCells / Math.max(width, 1)))
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
    if (!Array.isArray(data)) throw new Error('expected a JSON array of objects')
    // A Set keeps this linear: a record may have very many keys.
    const seen = new Set<string>()
    for (const record of data) for (const key of Object.keys(record ?? {})) seen.add(key)
    const columns = [...seen].slice(0, TABLE_LIMITS.maxColumns)
    const kept = data.slice(0, rowBudget(columns.length))
    const rows = kept.map(record => columns.map(c => cell(record?.[c])))
    return withNotice({ columns, rows }, data.length, seen.size)
  }
  const lines = mediaType === 'text/tab-separated-values'
    ? content.split(/\r?\n/).filter(l => l !== '').map(l => l.split('\t'))
    : parseCsv(content)
  const [header = [], ...rows] = lines
  // A loop, not Math.max(...rows): a spread of very many rows overflows the stack.
  let fullWidth = header.length
  for (const r of rows) if (r.length > fullWidth) fullWidth = r.length
  const width = Math.min(fullWidth, TABLE_LIMITS.maxColumns)
  const columns = Array.from({ length: width }, (_, i) => header[i] ?? `Column ${i + 1}`)
  const kept = rows.slice(0, rowBudget(width))
  return withNotice({ columns, rows: kept.map(r => Array.from({ length: width }, (_, i) => r[i] ?? '')) }, rows.length, fullWidth)
}

function withNotice(table: ParsedTable, rows: number, columns: number): ParsedTable {
  return table.rows.length < rows || table.columns.length < columns ? { ...table, truncated: { rows, columns } } : table
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
