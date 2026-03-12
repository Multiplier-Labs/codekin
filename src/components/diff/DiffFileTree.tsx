/**
 * Compact file list showing changed files with status badges and change counts.
 */

import type { DiffFile, DiffFileStatus } from '../../types'

const STATUS_CONFIG: Record<DiffFileStatus, { label: string; color: string }> = {
  modified: { label: 'M', color: 'text-warning-5 bg-warning-950/40' },
  added: { label: 'A', color: 'text-success-5 bg-success-950/40' },
  deleted: { label: 'D', color: 'text-error-5 bg-error-950/40' },
  renamed: { label: 'R', color: 'text-accent-5 bg-accent-950/40' },
}

interface DiffFileTreeProps {
  files: DiffFile[]
  activeFile: string | null
  onSelectFile: (path: string) => void
}

export function DiffFileTree({ files, activeFile, onSelectFile }: DiffFileTreeProps) {
  if (files.length === 0) return null

  return (
    <div className="flex flex-col text-xs">
      {files.map(file => {
        const cfg = STATUS_CONFIG[file.status]
        const isActive = file.path === activeFile
        const displayPath = file.status === 'renamed' && file.oldPath
          ? `${file.oldPath} → ${file.path}`
          : file.path

        return (
          <button
            key={file.path}
            className={`flex items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-10 transition-colors ${
              isActive ? 'bg-neutral-10 text-neutral-1' : 'text-neutral-3'
            }`}
            onClick={() => onSelectFile(file.path)}
          >
            <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold shrink-0 ${cfg.color}`}>
              {cfg.label}
            </span>
            <span className="font-mono truncate flex-1" title={displayPath}>
              {displayPath}
            </span>
            {!file.isBinary && (file.additions > 0 || file.deletions > 0) && (
              <span className="whitespace-nowrap shrink-0">
                {file.additions > 0 && <span className="text-success-5">+{file.additions}</span>}
                {file.additions > 0 && file.deletions > 0 && ' '}
                {file.deletions > 0 && <span className="text-error-5">&minus;{file.deletions}</span>}
              </span>
            )}
            {file.isBinary && (
              <span className="text-neutral-6 italic shrink-0">binary</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
