/**
 * The 40 px strip on the right edge while Canvas is open: the way into
 * Changes, which then slides over Canvas (docs/CANVAS-SPEC.md §4).
 */

import { IconFileDiff } from '@tabler/icons-react'

interface Props {
  count: number
  open: boolean
  onToggle: () => void
}

export function ChangesStrip({ count, open, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} Changes (⌘⇧D)`}
      aria-label={`${open ? 'Hide' : 'Show'} Changes${count > 0 ? `, ${count} file${count === 1 ? '' : 's'}` : ''}`}
      className={`flex w-10 shrink-0 flex-col items-center gap-2 border-l border-edge py-3 text-ink-muted transition-colors hover:text-ink ${
        open ? 'bg-surface-raised text-ink' : 'bg-surface'
      }`}
    >
      <IconFileDiff size={18} stroke={1.75} />
      <span className="text-meta font-medium [writing-mode:vertical-rl]">Changes</span>
      {count > 0 && (
        <span className="rounded-control bg-warning-5 px-1.5 text-micro font-bold tabular-nums text-ink-inverse">{count}</span>
      )}
    </button>
  )
}
