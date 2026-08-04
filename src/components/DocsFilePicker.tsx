/**
 * DocsFilePicker — inline scrollable list of .md files for a repo.
 *
 * Rendered inside the sidebar (like archived sessions), with a search filter
 * and scrollable list capped at ~10 visible items. Starred files appear first,
 * then pinned files (CLAUDE.md, README.md), separated by dividers from the rest.
 */

import { useState, useEffect, useRef } from 'react'
import { IconLoader2, IconFileText, IconStarFilled } from '@tabler/icons-react'

interface DocFile {
  path: string
  pinned: boolean
}

interface Props {
  files: DocFile[]
  loading: boolean
  starredDocs: string[]
  onSelect: (filePath: string) => void
  onClose: () => void
}

export function DocsFilePicker({ files, loading, starredDocs, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const starredSet = new Set(starredDocs)

  const filtered = search.trim()
    ? files.filter(f => f.path.toLowerCase().includes(search.toLowerCase()))
    : files

  const starred = filtered.filter(f => starredSet.has(f.path))
  const pinned = filtered.filter(f => f.pinned && !starredSet.has(f.path))
  const rest = filtered.filter(f => !f.pinned && !starredSet.has(f.path))
  const hasGroups = (starred.length > 0 ? 1 : 0) + (pinned.length > 0 ? 1 : 0) + (rest.length > 0 ? 1 : 0) > 1

  return (
    <div ref={ref} className="mt-1 border-t border-edge pt-1">
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <IconLoader2 size={14} className="animate-spin text-ink-muted" />
        </div>
      ) : files.length === 0 ? (
        <div className="pl-10 pr-2 py-1 text-body text-ink-muted">No markdown files found</div>
      ) : (
        <>
          {files.length > 5 && (
            <div className="px-2 pb-1">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter docs..."
                autoFocus
                className="w-full rounded-control border border-edge-strong bg-surface-raised px-2 py-1 text-body text-ink placeholder-ink-muted focus:border-focus focus:outline-none"
              />
            </div>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: '320px' }}>
            {filtered.length === 0 ? (
              <div className="pl-10 pr-2 py-1 text-body text-ink-muted">No matching files</div>
            ) : (
              <>
                {starred.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelect(f.path)}
                    className="group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-body text-ink font-medium hover:bg-surface-raised hover:text-ink transition-colors cursor-pointer rounded-control"
                  >
                    <IconStarFilled size={13} className="flex-shrink-0 text-primary-5" />
                    <span className="flex-1 truncate">{f.path}</span>
                  </button>
                ))}
                {starred.length > 0 && hasGroups && (
                  <div className="border-t border-edge my-0.5 mx-10" />
                )}
                {pinned.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelect(f.path)}
                    className="group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-body text-ink font-medium hover:bg-surface-raised hover:text-ink transition-colors cursor-pointer rounded-control"
                  >
                    <IconFileText size={13} className="flex-shrink-0 text-ink-muted" />
                    <span className="flex-1 truncate">{f.path}</span>
                  </button>
                ))}
                {pinned.length > 0 && rest.length > 0 && (
                  <div className="border-t border-edge my-0.5 mx-10" />
                )}
                {rest.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelect(f.path)}
                    className="group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-body text-ink-muted hover:bg-surface-raised hover:text-ink transition-colors cursor-pointer rounded-control"
                  >
                    <IconFileText size={13} className="flex-shrink-0 text-ink-faint" />
                    <span className="flex-1 truncate">{f.path}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
