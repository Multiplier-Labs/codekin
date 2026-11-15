/**
 * Compare two revisions of an item (design handoff C15·5). Markdown compares
 * rendered blocks in one column; tables compare rows; diagrams and source
 * compare lines; images sit side by side. Added content is tinted success
 * with "+", removed content tinted error, struck through and marked "−", so
 * colour is never the only signal.
 */

import { useMemo, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import type { CanvasContent } from '../../hooks/useCanvas'
import { diffSequences, foldUnchanged, type DiffOp, type DiffRow } from '../../lib/diffSeq'
import { parseTable } from '../../lib/canvasTable'
import { markdownBlocks } from '../../lib/canvasItems'
import { MarkdownRenderer } from '../MarkdownRenderer'

type Loaded = CanvasContent | 'loading' | { error: string }

interface Props {
  item: CanvasItem
  from: number
  to: number
  a: Loaded
  b: Loaded
  /** Compare the source text instead of the rendered item. */
  source: boolean
}

/** Rows drawn at a time, as in the table view: a big comparison must not build every row at once. */
const PAGE = 500

const ADD = 'border-l-2 border-success-5 bg-success-11'
const DEL = 'border-l-2 border-error-5 bg-error-11 line-through decoration-error-5/60'

function plural(n: number, unit: string): string {
  return `${n.toLocaleString()} unchanged ${unit}${n === 1 ? '' : 's'}`
}

function GapButton({ count, unit, onOpen }: { count: number; unit: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-control px-2 py-1 text-left text-meta text-ink-muted hover:bg-surface hover:text-ink">
      ⋯ {plural(count, unit)} · show
    </button>
  )
}

function Mark({ op }: { op: DiffOp<unknown>['op'] }) {
  if (op === 'same') return <span className="w-4 shrink-0" />
  return <span className={`w-4 shrink-0 font-mono font-bold ${op === 'add' ? 'text-success-5' : 'text-error-5'}`} aria-label={op === 'add' ? 'added' : 'removed'}>{op === 'add' ? '+' : '−'}</span>
}

export function CompareView({ item, from, to, a, b, source }: Props) {
  const ready = typeof a === 'object' && typeof b === 'object' && !('error' in a) && !('error' in b)
  const ops = useMemo(() => {
    if (!ready) return null
    const ca = a
    const cb = b
    if (item.kind === 'image') return null
    if (item.kind === 'markdown' && !source) return { kind: 'blocks' as const, ops: diffSequences(markdownBlocks(ca.content), markdownBlocks(cb.content)) }
    if (item.kind === 'table' && !source) {
      try {
        const ta = parseTable(ca.content, ca.mediaType)
        const tb = parseTable(cb.content, cb.mediaType)
        return { kind: 'rows' as const, columns: tb.columns, ops: diffSequences(ta.rows, tb.rows, r => JSON.stringify(r)) }
      } catch { /* unreadable table: fall back to lines */ }
    }
    return { kind: 'lines' as const, ops: diffSequences(ca.content.split('\n'), cb.content.split('\n')) }
  }, [ready, a, b, item.kind, source])

  // Which folded runs are open and how many rows are drawn; both start over for a new comparison.
  const [view, setView] = useState({ ops, expanded: new Set<number>() as ReadonlySet<number>, shown: PAGE })
  if (view.ops !== ops) setView({ ops, expanded: new Set(), shown: PAGE })
  const rows = useMemo(() => (ops ? foldUnchanged<unknown>(ops.ops, 3, view.expanded) : []), [ops, view.expanded])
  const visible = rows.slice(0, view.shown)
  const open = (start: number) => { setView(v => ({ ...v, expanded: new Set([...v.expanded, start]) })) }
  const more = rows.length > view.shown && (
    <div className="flex items-center gap-3 py-3 text-meta text-ink-muted">
      Showing {view.shown.toLocaleString()} of {rows.length.toLocaleString()} rows
      <button type="button" onClick={() => { setView(v => ({ ...v, shown: v.shown + PAGE })) }} className="font-medium text-primary-5 hover:underline">
        Show {Math.min(PAGE, rows.length - view.shown).toLocaleString()} more
      </button>
    </div>
  )

  if (!ready) {
    const err = [a, b].find((x): x is { error: string } => typeof x === 'object' && 'error' in x)
    return err
      ? <p className="m-8 text-body text-error-5" role="alert">Couldn't load a revision to compare: {err.error}</p>
      : <div className="flex flex-1 items-center justify-center gap-2 text-meta text-ink-muted" role="status"><IconLoader2 size={18} className="animate-spin" /> Loading revisions…</div>
  }

  const summary = ops ? `${ops.ops.filter(o => o.op === 'add').length} added · ${ops.ops.filter(o => o.op === 'del').length} removed` : null
  const heading = (
    <div className="mb-4 flex items-center gap-3 text-meta text-ink-muted">
      <span className="font-bold text-ink">rev {from} → rev {to}</span>
      {summary && <span>{summary}</span>}
    </div>
  )

  if (item.kind === 'image' || !ops) {
    const ca = a
    const cb = b
    return (
      <div className="px-8 py-6">
        {heading}
        <div className="grid grid-cols-2 gap-4">
          {[[from, ca], [to, cb] as const].map(([n, c]) => (
            <figure key={String(n)} className="min-w-0">
              <figcaption className="mb-1 text-meta text-ink-muted">rev {String(n)}</figcaption>
              <img src={`data:${(c as CanvasContent).mediaType};base64,${(c as CanvasContent).content}`} alt={`${item.title}, revision ${String(n)}`} className="max-w-full rounded-control border border-edge" />
            </figure>
          ))}
        </div>
      </div>
    )
  }

  if (ops.kind === 'blocks') {
    return (
      <div className="mx-auto w-full max-w-[720px] px-8 py-6">
        {heading}
        <div className="flex flex-col gap-1">
          {(visible as DiffRow<string>[]).map(r => r.kind === 'gap'
            ? <GapButton key={`g${r.key}`} count={r.count} unit="block" onOpen={() => { open(r.key) }} />
            : (
              <div key={`o${r.key}`} className={`flex gap-2 rounded-control px-2 ${r.op.op === 'add' ? ADD : r.op.op === 'del' ? DEL : ''}`}>
                <Mark op={r.op.op} />
                <div className="min-w-0 flex-1"><MarkdownRenderer content={r.op.value} /></div>
              </div>
            ))}
        </div>
        {more}
      </div>
    )
  }

  if (ops.kind === 'rows') {
    return (
      <div className="px-6 py-6">
        {heading}
        <table className="min-w-full border-separate border-spacing-0 text-meta">
          <thead>
            <tr><th className="w-6 border-b border-edge-strong bg-surface" />{ops.columns.map((c, i) => <th key={i} className="border-b border-edge-strong bg-surface px-3 py-2 text-left font-bold text-ink">{c}</th>)}</tr>
          </thead>
          <tbody>
            {(visible as DiffRow<string[]>[]).map(r => r.kind === 'gap'
              ? <tr key={`g${r.key}`}><td colSpan={ops.columns.length + 1} className="border-b border-edge"><GapButton count={r.count} unit="row" onOpen={() => { open(r.key) }} /></td></tr>
              : (
                <tr key={`o${r.key}`} className={r.op.op === 'add' ? 'bg-success-11' : r.op.op === 'del' ? 'bg-error-11 line-through decoration-error-5/60' : ''}>
                  <td className="border-b border-edge px-1 text-center"><Mark op={r.op.op} /></td>
                  {r.op.value.map((v, ci) => <td key={ci} className="border-b border-edge px-3 py-1.5 text-ink">{v}</td>)}
                </tr>
              ))}
          </tbody>
        </table>
        {more}
      </div>
    )
  }

  return (
    <div className="px-6 py-6">
      {heading}
      <pre className="font-mono text-meta text-ink">
        {(visible as DiffRow<string>[]).map(r => r.kind === 'gap'
          ? <GapButton key={`g${r.key}`} count={r.count} unit="line" onOpen={() => { open(r.key) }} />
          : (
            <div key={`o${r.key}`} className={`flex gap-2 px-2 ${r.op.op === 'add' ? ADD : r.op.op === 'del' ? DEL : ''}`}>
              <Mark op={r.op.op} />
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{r.op.value || ' '}</span>
            </div>
          ))}
      </pre>
      {more}
    </div>
  )
}
