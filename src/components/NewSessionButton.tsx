/**
 * The sidebar's New button: opens the new-session composer (/new), where the
 * user types first and picks where the session runs from a chip beside the
 * prompt. Shown as current while the composer is up.
 */

import { IconPlus } from '@tabler/icons-react'

interface Props {
  onNewSession: () => void
  /** The composer is the current screen (marks the button aria-current). */
  current?: boolean
}

export function NewSessionButton({ onNewSession, current = false }: Props) {
  return (
    <div className="relative h-full flex items-center">
      {/* Labelled, not a bare glyph — this is the only new-session affordance
          in the sidebar, so it says what it does. It is a pane-header
          control, so it grows with the header on touch. */}
      <button
        onClick={onNewSession}
        aria-current={current ? 'page' : undefined}
        className={`app-new-session-btn flex h-(--pane-control-h) items-center gap-1.5 rounded-control bg-surface-raised px-2.5 text-body text-ink transition-colors hover:bg-edge ${current ? 'bg-edge' : ''}`}
        title="New session"
      >
        <IconPlus size={14} stroke={2.5} className="flex-shrink-0" />
        <span>New</span>
      </button>
    </div>
  )
}
