/**
 * Small pieces shared by the Changes panel's file list and diff bar: the
 * status chip and the +/− counts.
 */

import type { DiffFile, DiffFileStatus } from '../../types'

const STATUS_CONFIG: Record<DiffFileStatus, { label: string; color: string; title: string }> = {
  modified: { label: 'M', color: 'text-warning-5 bg-warning-10', title: 'Modified' },
  added: { label: 'A', color: 'text-success-5 bg-success-10', title: 'Added' },
  deleted: { label: 'D', color: 'text-error-5 bg-error-10', title: 'Deleted' },
  renamed: { label: 'R', color: 'text-accent-5 bg-accent-10', title: 'Renamed' },
}

export function StatusChip({ status, large }: { status: DiffFileStatus; large?: boolean }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded font-bold leading-none ${large ? 'h-6 w-6 text-meta' : 'h-[18px] w-[18px] text-micro'} ${cfg.color}`}
      title={cfg.title}
    >
      {cfg.label}
    </span>
  )
}

/** +/− counts, or "binary". */
export function Counts({ file, className = '' }: { file: DiffFile; className?: string }) {
  if (file.isBinary) return <span className={`shrink-0 italic text-ink-faint ${className}`}>binary</span>
  if (file.additions === 0 && file.deletions === 0) return null
  return (
    <span className={`shrink-0 whitespace-nowrap ${className}`}>
      {file.additions > 0 && <span className="text-success-5">+{file.additions}</span>}
      {file.additions > 0 && file.deletions > 0 && ' '}
      {file.deletions > 0 && <span className="text-error-5">&minus;{file.deletions}</span>}
    </span>
  )
}
