/**
 * Table items (design handoff C17): a sticky header, click-to-sort columns
 * (numeric columns sort as numbers and align right), a filter over all
 * cells, and a row count. Large tables render in pages of 500 rows.
 */

import { useMemo, useState } from 'react'
import { IconArrowDown, IconArrowUp, IconSearch } from '@tabler/icons-react'
import { isNumericColumn, parseTable, sortRows } from '../../lib/canvasTable'

const PAGE = 500

export function TableView({ content, mediaType }: { content: string; mediaType: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, table: parseTable(content, mediaType) }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  }, [content, mediaType])
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(PAGE)

  const numeric = useMemo(
    () => (parsed.ok ? parsed.table.columns.map((_, i) => isNumericColumn(parsed.table.rows, i)) : []),
    [parsed],
  )
  const rows = useMemo(() => {
    if (!parsed.ok) return []
    const needle = filter.trim().toLowerCase()
    const matching = needle ? parsed.table.rows.filter(r => r.some(c => c.toLowerCase().includes(needle))) : parsed.table.rows
    return sort ? sortRows(matching, sort.col, sort.dir, numeric[sort.col]) : matching
  }, [parsed, filter, sort, numeric])

  if (!parsed.ok) {
    return <p className="m-8 text-body text-error-5" role="alert">This table could not be read: {parsed.message}</p>
  }
  const { columns } = parsed.table
  const total = parsed.table.rows.length
  const toggleSort = (col: number) => {
    setSort(s => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-edge px-6 py-2.5">
        <label className="flex min-w-0 max-w-[320px] flex-1 items-center gap-2 rounded-control border border-edge bg-page px-2.5 py-1 focus-within:border-focus">
          <IconSearch size={15} className="shrink-0 text-ink-muted" aria-hidden />
          <input
            value={filter}
            onChange={e => { setFilter(e.target.value); setShown(PAGE) }}
            placeholder="Filter rows"
            aria-label="Filter rows"
            className="min-w-0 flex-1 bg-transparent text-meta text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        <span className="text-meta tabular-nums text-ink-muted">
          {filter.trim() ? `${rows.length.toLocaleString()} of ${total.toLocaleString()} rows` : `${total.toLocaleString()} row${total === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-meta">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  aria-sort={sort?.col === i ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10 border-b border-edge-strong bg-surface p-0 text-left font-bold text-ink"
                >
                  <button
                    type="button"
                    onClick={() => { toggleSort(i) }}
                    className={`flex w-full items-center gap-1 whitespace-nowrap px-3 py-2 hover:bg-surface-raised ${numeric[i] ? 'justify-end' : ''}`}
                  >
                    {c}
                    {sort?.col === i && (sort.dir === 'asc' ? <IconArrowUp size={13} aria-hidden /> : <IconArrowDown size={13} aria-hidden />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r, ri) => (
              <tr key={ri} className="hover:bg-surface">
                {r.map((v, ci) => (
                  <td
                    key={ci}
                    className={`max-w-[480px] truncate border-b border-edge px-3 py-1.5 text-ink ${numeric[ci] ? 'text-right font-mono tabular-nums' : ''}`}
                    title={v.length > 60 ? v : undefined}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > shown && (
          <div className="flex items-center gap-3 px-6 py-3 text-meta text-ink-muted">
            Showing {shown.toLocaleString()} of {rows.length.toLocaleString()} rows
            <button type="button" onClick={() => { setShown(n => n + PAGE) }} className="font-medium text-primary-5 hover:underline">
              Show {Math.min(PAGE, rows.length - shown).toLocaleString()} more
            </button>
          </div>
        )}
        {rows.length === 0 && <p className="px-6 py-4 text-meta text-ink-muted">{total === 0 ? 'This table has no rows.' : 'No rows match the filter.'}</p>}
      </div>
    </div>
  )
}
