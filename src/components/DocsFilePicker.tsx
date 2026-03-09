/**
 * DocsFilePicker — inline scrollable list of .md files for a repo.
 *
 * Rendered inside the sidebar (like archived sessions), with a search filter
 * and scrollable list capped at ~10 visible items. Pinned files (CLAUDE.md,
 * README.md) appear first, separated by a divider from the rest.
 */

import { useState, useEffect, useRef } from 'react'
import { IconLoader2, IconFileText } from '@tabler/icons-react'

interface DocFile {
  path: string
  pinned: boolean
}

interface Props {
  files: DocFile[]
  loading: boolean
  onSelect: (filePath: string) => void
  onClose: () => void
}

export function DocsFilePicker({ files, loading, onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const filtered = search.trim()
    ? files.filter(f => f.path.toLowerCase().includes(search.toLowerCase()))
    : files

  const pinned = filtered.filter(f => f.pinned)
  const rest = filtered.filter(f => !f.pinned)

  return (
    <div ref={ref} className="mt-1 border-t border-neutral-8/30 pt-1">
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <IconLoader2 size={14} className="animate-spin text-neutral-5" />
        </div>
      ) : files.length === 0 ? (
        <div className="pl-10 pr-2 py-1 text-[13px] text-neutral-5">No markdown files found</div>
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
                className="w-full rounded border border-neutral-7 bg-neutral-10/50 px-2 py-1 text-[13px] text-neutral-2 placeholder-neutral-5 focus:border-accent-6 focus:outline-none"
              />
            </div>
          )}
          <div className="overflow-y-auto" style={{ maxHeight: '320px' }}>
            {filtered.length === 0 ? (
              <div className="pl-10 pr-2 py-1 text-[13px] text-neutral-5">No matching files</div>
            ) : (
              <>
                {pinned.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelect(f.path)}
                    className="group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-[15px] text-neutral-2 font-medium hover:bg-neutral-6/50 hover:text-neutral-1 transition-colors cursor-pointer rounded-md"
                  >
                    <IconFileText size={13} className="flex-shrink-0 text-neutral-5" />
                    <span className="flex-1 truncate">{f.path}</span>
                  </button>
                ))}
                {pinned.length > 0 && rest.length > 0 && (
                  <div className="border-t border-neutral-8/30 my-0.5 mx-10" />
                )}
                {rest.map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelect(f.path)}
                    className="group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-[15px] text-neutral-4 hover:bg-neutral-6/50 hover:text-neutral-2 transition-colors cursor-pointer rounded-md"
                  >
                    <IconFileText size={13} className="flex-shrink-0 text-neutral-6" />
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
