/**
 * Table items (design handoff C17): a sticky header, click-to-sort columns
 * (numeric columns sort as numbers and align right), a filter over all
 * cells, and a row count. Large tables render in pages of 500 rows.
 */

import { useMemo, useRef, useState } from 'react'
import { IconArrowDown, IconArrowUp, IconMessageQuestion, IconSearch } from '@tabler/icons-react'
import { isNumericColumn, parseTable, rowsExcerpt, sortRows } from '../../lib/canvasTable'

const PAGE = 500

interface Props {
  content: string
  mediaType: string
  /** Attach the selected rows to the next message (ask: also bring the composer up). */
  onAttachRows?: (excerpt: string, count: number, ask: boolean) => void
}

export function TableView({ content, mediaType, onAttachRows }: Props) {
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
  /** Selected rows, by their index in the parsed table. */
  const [picked, setPicked] = useState(new Set<number>())
  const lastPick = useRef<number | null>(null)

  const numeric = useMemo(
    () => (parsed.ok ? parsed.table.columns.map((_, i) => isNumericColumn(parsed.table.rows, i)) : []),
    [parsed],
  )
  // Rows as shown (filtered, sorted), each with its index in the parsed table.
  const rows = useMemo(() => {
    if (!parsed.ok) return []
    const indexed = parsed.table.rows.map((r, i) => [String(i), ...r])
    const needle = filter.trim().toLowerCase()
    const matching = needle ? indexed.filter(r => r.slice(1).some(c => c.toLowerCase().includes(needle))) : indexed
    return sort ? sortRows(matching, sort.col + 1, sort.dir, numeric[sort.col]) : matching
  }, [parsed, filter, sort, numeric])

  if (!parsed.ok) {
    return <p className="m-8 text-body text-error-5" role="alert">This table could not be read: {parsed.message}</p>
  }
  const { columns } = parsed.table
  const total = parsed.table.rows.length
  const toggleSort = (col: number) => {
    setSort(s => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))
  }
  /** Toggle a row; shift extends from the last one toggled, in display order. */
  const pick = (position: number, shift: boolean) => {
    const index = Number(rows[position][0])
    setPicked(prev => {
      const next = new Set(prev)
      const last = lastPick.current
      if (shift && last !== null) {
        const [from, to] = last < position ? [last, position] : [position, last]
        for (let p = from; p <= to; p++) next.add(Number(rows[p][0]))
      } else if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
    lastPick.current = position
  }
  const attach = (ask: boolean) => {
    const chosen = [...picked].sort((a, b) => a - b).map(i => parsed.table.rows[i])
    onAttachRows?.(rowsExcerpt(columns, chosen), chosen.length, ask)
    setPicked(new Set())
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
              {onAttachRows && <th scope="col" className="sticky top-0 z-10 w-8 border-b border-edge-strong bg-surface"><span className="sr-only">Select</span></th>}
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
            {rows.slice(0, shown).map((row, ri) => {
              const selected = picked.has(Number(row[0]))
              return (
              <tr key={row[0]} className={selected ? 'bg-primary-11' : 'hover:bg-surface'}>
                {onAttachRows && (
                  <td className="border-b border-edge px-2 text-center">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {}}
                      onClick={(e) => { pick(ri, e.shiftKey) }}
                      aria-label={`Select row ${ri + 1}`}
                      className="h-3.5 w-3.5 cursor-pointer accent-primary-7"
                    />
                  </td>
                )}
                {row.slice(1).map((v, ci) => (
                  <td
                    key={ci}
                    className={`max-w-[480px] truncate border-b border-edge px-3 py-1.5 text-ink ${numeric[ci] ? 'text-right font-mono tabular-nums' : ''}`}
                    title={v.length > 60 ? v : undefined}
                  >
                    {v}
                  </td>
                ))}
              </tr>
              )
            })}
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
      {picked.size > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-edge bg-surface px-4 py-2 text-meta" role="toolbar" aria-label="Selected rows">
          <span className="font-bold text-ink">{picked.size} row{picked.size === 1 ? '' : 's'} selected</span>
          <span className="flex-1" />
          <button type="button" onClick={() => { attach(true) }} className="flex items-center gap-1.5 rounded-control bg-primary-fill px-3 py-1 font-medium text-on-primary-fill hover:opacity-90">
            <IconMessageQuestion size={15} aria-hidden /> Ask about this
          </button>
          <button type="button" onClick={() => { attach(false) }} className="rounded-control border border-edge-strong bg-page px-3 py-1 text-ink hover:border-focus">Add to prompt</button>
          <button type="button" onClick={() => { setPicked(new Set()) }} className="px-1 text-ink-muted hover:text-ink">Clear</button>
        </div>
      )}
    </div>
  )
}
