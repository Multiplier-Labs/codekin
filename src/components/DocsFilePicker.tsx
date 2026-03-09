/**
 * DocsFilePicker — dropdown showing available .md files for a repo.
 *
 * Anchored to the doc icon on the repo row. Pinned files (CLAUDE.md, README.md)
 * appear first, separated by a divider from the rest.
 */

import { useEffect, useRef } from 'react'
import { IconLoader2 } from '@tabler/icons-react'

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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const pinned = files.filter(f => f.pinned)
  const rest = files.filter(f => !f.pinned)

  return (
    <div
      ref={ref}
      className="absolute left-full top-0 ml-1 w-64 z-50 rounded-md border border-neutral-10 bg-neutral-12 py-1 shadow-lg"
    >
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <IconLoader2 size={14} className="animate-spin text-neutral-5" />
        </div>
      ) : files.length === 0 ? (
        <div className="text-[13px] text-neutral-5 px-3 py-2">No markdown files found</div>
      ) : (
        <>
          {pinned.map(f => (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className="w-full text-left px-3 py-1.5 text-[15px] text-neutral-2 font-medium hover:bg-neutral-10/50 transition-colors cursor-pointer"
            >
              {f.path}
            </button>
          ))}
          {pinned.length > 0 && rest.length > 0 && (
            <div className="border-t border-neutral-10 my-1" />
          )}
          {rest.map(f => (
            <button
              key={f.path}
              onClick={() => onSelect(f.path)}
              className="w-full text-left px-3 py-1.5 text-[15px] text-neutral-4 hover:bg-neutral-10/50 transition-colors cursor-pointer"
            >
              {f.path}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
