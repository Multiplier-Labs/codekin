/**
 * A single file card in the diff viewer — header with path/counts/actions,
 * plus a collapsible body with diff hunks.
 */

import { useState } from 'react'
import { IconChevronDown, IconChevronRight, IconCopy, IconTrash, IconFile } from '@tabler/icons-react'
import type { DiffFile, DiffFileStatus } from '../../types'
import { DiffHunkView } from './DiffHunkView'

const LARGE_DIFF_THRESHOLD = 300

interface DiffFileCardProps {
  file: DiffFile
  isActive: boolean
  onDiscard: (path: string, status: DiffFileStatus) => void
  onScrollRef: (el: HTMLDivElement | null) => void
}

export function DiffFileCard({ file, isActive, onDiscard, onScrollRef }: DiffFileCardProps) {
  const totalChanges = file.additions + file.deletions
  const isLarge = totalChanges > LARGE_DIFF_THRESHOLD
  const [expanded, setExpanded] = useState(!isLarge)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const displayPath = file.status === 'renamed' && file.oldPath
    ? `${file.oldPath} → ${file.path}`
    : file.path

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(file.path)
  }

  const handleDiscard = () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true)
      setTimeout(() => setConfirmDiscard(false), 3000)
      return
    }
    onDiscard(file.path, file.status)
    setConfirmDiscard(false)
  }

  return (
    <div
      ref={onScrollRef}
      className={`border rounded-lg overflow-hidden ${
        isActive ? 'border-primary-6' : 'border-neutral-9'
      }`}
    >
      {/* Card header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-neutral-10 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded
          ? <IconChevronDown size={14} className="text-neutral-5 shrink-0" />
          : <IconChevronRight size={14} className="text-neutral-5 shrink-0" />
        }
        <span className="font-mono text-xs text-neutral-2 truncate flex-1" title={displayPath}>
          {displayPath}
        </span>
        {!file.isBinary && (
          <span className="text-xs whitespace-nowrap">
            {file.additions > 0 && <span className="text-success-5">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && <span className="text-neutral-5 mx-0.5"> </span>}
            {file.deletions > 0 && <span className="text-error-5">&minus;{file.deletions}</span>}
          </span>
        )}
        {file.isBinary && (
          <span className="text-xs text-neutral-5 italic">binary</span>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1 ml-1" onClick={e => e.stopPropagation()}>
          <button
            className="p-1 rounded hover:bg-neutral-8 text-neutral-4 hover:text-neutral-2"
            onClick={handleCopyPath}
            title="Copy path"
          >
            <IconCopy size={13} />
          </button>
          <button
            className={`p-1 rounded hover:bg-error-950/50 ${
              confirmDiscard ? 'text-error-5' : 'text-neutral-4 hover:text-error-5'
            }`}
            onClick={handleDiscard}
            title={confirmDiscard ? 'Click again to confirm' : 'Discard file changes'}
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>

      {/* Card body */}
      {expanded && (
        <div className="border-t border-neutral-9">
          {file.isBinary ? (
            <div className="flex items-center gap-2 px-4 py-3 text-neutral-5 text-xs italic">
              <IconFile size={14} />
              Binary file
            </div>
          ) : isLarge && file.hunks.length > 0 ? (
            <div className="px-4 py-3">
              <DiffHunkView hunks={file.hunks}  />
            </div>
          ) : file.hunks.length > 0 ? (
            <div className="px-0">
              <DiffHunkView hunks={file.hunks}  />
            </div>
          ) : (
            <div className="px-4 py-3 text-neutral-5 text-xs italic">No changes</div>
          )}
        </div>
      )}

      {/* Collapsed large diff note */}
      {!expanded && isLarge && (
        <div
          className="border-t border-neutral-9 px-4 py-2 text-xs text-neutral-5 italic cursor-pointer hover:text-neutral-3"
          onClick={() => setExpanded(true)}
        >
          Large diff ({totalChanges} lines) — click to expand
        </div>
      )}
    </div>
  )
}
