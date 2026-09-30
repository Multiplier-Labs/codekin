/**
 * The Changes panel's file list: files grouped under folder headings, one
 * row per file with its status chip, name, uncommitted dot and +/− counts.
 * Expects files already in group order (see `groupOrder`).
 */

import { IconFolder } from '@tabler/icons-react'
import type { DiffFile } from '../../types'
import { Counts, StatusChip } from './diffFileMeta'
import { displayName, displayPath, splitPath } from './diffFiles'

interface DiffFileTreeProps {
  files: DiffFile[]
  activeFile: string | null
  onSelectFile: (path: string) => void
  /** Narrow panel: folder headings drop their icon. */
  narrow?: boolean
}

export function DiffFileTree({ files, activeFile, onSelectFile, narrow }: DiffFileTreeProps) {
  if (files.length === 0) return null

  const rows: React.ReactNode[] = []
  let lastDir: string | null = null
  for (const file of files) {
    const { dir } = splitPath(file.path)
    if (dir !== lastDir && dir) {
      rows.push(
        <div key={`dir:${dir}`} className="flex h-[26px] shrink-0 items-center gap-1.5 px-4 font-mono text-meta text-ink-faint" title={dir}>
          {!narrow && <IconFolder size={14} className="shrink-0" />}
          <span className="truncate">{dir}</span>
        </div>,
      )
    }
    lastDir = dir

    const isActive = file.path === activeFile
    const full = displayPath(file)
    rows.push(
      <button
        key={file.path}
        className={`density-row flex h-8 w-full shrink-0 items-center gap-2.5 border-l-2 pl-[26px] pr-4 text-left text-ink transition-colors ${
          isActive ? 'border-primary-6 bg-page' : 'border-transparent hover:bg-surface-raised'
        }`}
        onClick={() => { onSelectFile(file.path) }}
        title={file.uncommitted ? `${full} (uncommitted changes)` : full}
        aria-current={isActive ? 'true' : undefined}
      >
        <StatusChip status={file.status} />
        <span className={`min-w-0 flex-1 truncate font-mono text-body ${isActive ? 'font-bold' : ''}`}>{displayName(file)}</span>
        {file.uncommitted && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-5" role="img" aria-label="uncommitted changes" />
        )}
        <Counts file={file} className="text-micro" />
      </button>,
    )
  }

  return <div className="flex flex-col">{rows}</div>
}
