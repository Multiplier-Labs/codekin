/**
 * Renders diff hunks for a single file using react-diff-view.
 * Maps our DiffHunk[]/DiffLine[] types to react-diff-view's expected format.
 *
 * With `commenting`, clicking a line number selects that line and shift-click
 * extends the selection on the same side (new lines, or removed lines). A
 * composer opens under the selection; saved comments for this file and view
 * render inline under the last line they cover.
 */

import { useMemo, useState } from 'react'
import { Diff, Hunk, getChangeKey } from 'react-diff-view'
import type { HunkData, ChangeData, ChangeEventArgs } from 'react-diff-view'
import type { DiffHunk, ReviewComment } from '../../types'
import 'react-diff-view/style/index.css'

type Side = 'new' | 'old'

export interface LineRange {
  side: Side
  startLine: number
  endLine: number
}

export interface DiffCommenting {
  /** Comments anchored to this file in the current view. */
  comments: ReviewComment[]
  onAdd: (range: LineRange, body: string) => void
  onUpdate: (id: string, body: string) => void
  onDelete: (id: string) => void
}

interface DiffHunkViewProps {
  hunks: DiffHunk[]
  commenting?: DiffCommenting
}

/** Convert our DiffHunk[] to react-diff-view's HunkData[] format. */
function toRdvHunks(hunks: DiffHunk[]): HunkData[] {
  return hunks.map(hunk => {
    const changes: ChangeData[] = hunk.lines.map(line => {
      if (line.type === 'add') {
        return {
          type: 'insert' as const,
          isInsert: true,
          lineNumber: line.newLineNo ?? 0,
          content: line.content,
        }
      } else if (line.type === 'delete') {
        return {
          type: 'delete' as const,
          isDelete: true,
          lineNumber: line.oldLineNo ?? 0,
          content: line.content,
        }
      } else {
        return {
          type: 'normal' as const,
          isNormal: true,
          oldLineNumber: line.oldLineNo ?? 0,
          newLineNumber: line.newLineNo ?? 0,
          content: line.content,
        }
      }
    })

    return {
      content: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      changes,
    }
  })
}

/** Which side and line a change is commented on: removed lines on the old side, all others on the new side. */
function lineOf(change: ChangeData): { side: Side; line: number } {
  if (change.type === 'delete') return { side: 'old', line: change.lineNumber }
  if (change.type === 'insert') return { side: 'new', line: change.lineNumber }
  return { side: 'new', line: change.newLineNumber }
}

function lineLabel(r: LineRange): string {
  const lines = r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}–${r.endLine}`
  return r.side === 'old' ? `removed ${lines}` : lines
}

function authorLabel(c: ReviewComment): string {
  return c.authorRole === 'owner' ? 'Owner' : `Shared user ${c.author.slice(0, 8)}`
}

function Composer({ range, onSave, onCancel, initial = '' }: {
  range: LineRange
  initial?: string
  onSave: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState(initial)
  const save = () => { if (body.trim()) onSave(body) }
  return (
    <div className="border-y border-edge bg-surface px-3 py-2 font-sans">
      <p className="mb-1 text-micro text-ink-faint">Comment on {lineLabel(range)}</p>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => { setBody(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        rows={3}
        placeholder="What should the agent change here?"
        className="w-full resize-y rounded-control border border-edge bg-page px-2 py-1 text-body text-ink focus:border-focus focus:outline-none"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-control px-2 py-0.5 text-meta text-ink-muted hover:bg-surface-raised hover:text-ink">Cancel</button>
        <button
          onClick={save}
          disabled={!body.trim()}
          title="Save as a draft (Ctrl/⌘+Enter)"
          className="rounded-control bg-primary-9/30 px-2 py-0.5 text-meta text-primary-3 hover:bg-primary-8/40 disabled:opacity-50"
        >
          {initial ? 'Save' : 'Add comment'}
        </button>
      </div>
    </div>
  )
}

function CommentCard({ comment, onUpdate, onDelete }: {
  comment: ReviewComment
  onUpdate: (id: string, body: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const range: LineRange = comment.anchor
  if (editing) {
    return <Composer range={range} initial={comment.body} onSave={(b) => { onUpdate(comment.id, b); setEditing(false) }} onCancel={() => { setEditing(false) }} />
  }
  return (
    <div className="border-y border-edge bg-surface px-3 py-2 font-sans" data-comment-id={comment.id}>
      <div className="mb-0.5 flex items-center gap-2 text-micro text-ink-faint">
        <span>{authorLabel(comment)} · {lineLabel(range)}</span>
        {comment.status === 'sent' && <span className="rounded-control bg-success-9/20 px-1 text-success-4">sent</span>}
        {comment.stale && (
          <span className="rounded-control bg-warning-9/20 px-1 text-warning-4" title="These lines changed after the comment was written">
            code changed
          </span>
        )}
        <span className="flex-1" />
        {comment.status === 'draft' && (
          <button onClick={() => { setEditing(true) }} className="rounded-control px-1 hover:bg-surface-raised hover:text-ink">Edit</button>
        )}
        <button onClick={() => { onDelete(comment.id) }} className="rounded-control px-1 hover:bg-surface-raised hover:text-error-5">Delete</button>
      </div>
      <p className="whitespace-pre-wrap text-body text-ink">{comment.body}</p>
    </div>
  )
}

export function DiffHunkView({ hunks, commenting }: DiffHunkViewProps) {
  const [selection, setSelection] = useState<LineRange | null>(null)
  const rdvHunks = useMemo(() => toRdvHunks(hunks), [hunks])

  // Every change with its key, for mapping lines to widget positions.
  const changes = useMemo(() => rdvHunks.flatMap(h => h.changes).map(change => ({ change, key: getChangeKey(change), ...lineOf(change) })), [rdvHunks])

  if (hunks.length === 0) return null

  const keyAt = (side: Side, line: number) => changes.find(c => c.side === side && c.line === line)?.key

  const selectedChanges = selection
    ? changes.filter(c => c.side === selection.side && c.line >= selection.startLine && c.line <= selection.endLine).map(c => c.key)
    : []

  const widgets: Record<string, React.ReactNode> = {}
  if (commenting) {
    const byKey = new Map<string, ReviewComment[]>()
    for (const comment of commenting.comments) {
      const key = keyAt(comment.anchor.side, comment.anchor.endLine)
      if (key) byKey.set(key, [...(byKey.get(key) ?? []), comment])
    }
    for (const [key, list] of byKey) {
      widgets[key] = list.map(c => <CommentCard key={c.id} comment={c} onUpdate={commenting.onUpdate} onDelete={commenting.onDelete} />)
    }
    const composerKey = selection ? keyAt(selection.side, selection.endLine) : undefined
    if (selection && composerKey) {
      const existing = widgets[composerKey]
      widgets[composerKey] = (
        <>
          {existing}
          <Composer
            key={`${selection.side}:${selection.startLine}:${selection.endLine}`}
            range={selection}
            onSave={(body) => { commenting.onAdd(selection, body); setSelection(null) }}
            onCancel={() => { setSelection(null) }}
          />
        </>
      )
    }
  }

  const gutterEvents = commenting
    ? {
        onClick: ({ change }: ChangeEventArgs, event: React.MouseEvent) => {
          if (!change) return
          const { side, line } = lineOf(change)
          if (event.shiftKey && selection?.side === side) {
            const anchor = line < selection.startLine ? selection.endLine : selection.startLine
            setSelection({ side, startLine: Math.min(anchor, line), endLine: Math.max(anchor, line) })
          } else {
            setSelection({ side, startLine: line, endLine: line })
          }
        },
      }
    : undefined

  return (
    <div className="diff-hunk-view text-xs font-mono overflow-x-auto">
      <Diff
        viewType="unified"
        diffType="modify"
        hunks={rdvHunks}
        selectedChanges={selectedChanges}
        widgets={widgets}
        gutterEvents={gutterEvents}
        gutterClassName={commenting ? 'cursor-pointer' : undefined}
      >
        {(rdvHunks) => rdvHunks.map((hunk, i) => (
          <Hunk key={`${hunk.oldStart}:${hunk.newStart}:${i}`} hunk={hunk} />
        ))}
      </Diff>
    </div>
  )
}
