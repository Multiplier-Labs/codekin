/**
 * Inline confirmation for discarding changes in the Changes panel. It names
 * what is lost: edits that are reverted and new files that are deleted.
 */

import type { DiffFile } from '../../types'

const LISTED_NEW_FILES = 3

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function Paths({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, LISTED_NEW_FILES)
  const more = paths.length - shown.length
  return (
    <>
      {shown.map((p, i) => (
        <span key={p}>
          {i > 0 && (i === shown.length - 1 && more === 0 ? ' and ' : ', ')}
          <code className="font-mono">{p}</code>
        </span>
      ))}
      {more > 0 && ` and ${more} more`}
    </>
  )
}

interface Props {
  /** Files that will be discarded. */
  files: DiffFile[]
  /** One file (from its diff bar) rather than the whole view. */
  single: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DiscardConfirm({ files, single, onCancel, onConfirm }: Props) {
  const created = files.filter(f => f.status === 'added')
  const edited = files.filter(f => f.status !== 'added')

  const title = single ? `Discard changes to ${files[0].path.split('/').pop()}?` : `Discard all ${plural(files.length, 'file')}?`
  const action = single ? 'Discard file' : `Discard ${plural(files.length, 'file')}`

  let body: React.ReactNode
  if (single) {
    body = created.length
      ? <>The new file <Paths paths={[files[0].path]} /> is deleted.</>
      : <>Edits to <Paths paths={[files[0].path]} /> are reverted.</>
  } else {
    const newFiles = created.length > 0 && (
      <>{plural(created.length, 'new file')}, <Paths paths={created.map(f => f.path)} />, {created.length === 1 ? 'is' : 'are'} deleted</>
    )
    body = edited.length && newFiles
      ? <>Edits to {plural(edited.length, 'file')} are reverted and {newFiles}.</>
      : edited.length
        ? <>Edits to {plural(edited.length, 'file')} are reverted.</>
        : <>{newFiles}.</>
  }

  return (
    <div className="mx-4 my-3 flex shrink-0 flex-col gap-2 rounded-lg border border-error-8 bg-error-11 px-3.5 py-3" role="alertdialog" aria-label={title}>
      <p className="text-meta font-bold text-error-4">{title}</p>
      <p className="text-meta text-error-2 [overflow-wrap:anywhere]">{body} This can't be undone.</p>
      <div className="flex justify-end gap-2">
        <button className="density-row h-8 rounded-control border border-edge bg-page px-3 text-meta text-ink hover:bg-surface-raised" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button className="density-row h-8 rounded-control bg-error-5 px-3 text-meta font-bold text-error-12 hover:opacity-90" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </div>
  )
}
