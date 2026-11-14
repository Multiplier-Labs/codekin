/**
 * The composer's unboxed session-state items (worktree, permission mode, the
 * agent chip): monospace, muted, no chip and no border. Shared by InputBar and
 * the agent picker.
 */

/**
 * Unboxed session-state item: monospace, muted, no chip and no border.
 *
 * `group/state` lets a child label collapse to nothing and expand on hover or
 * keyboard focus — see StateLabel. The `title` carries the same text for touch,
 * where there is no hover.
 */
export function StateItem({ children, title, onClick, danger = false, innerRef }: {
  children: React.ReactNode; title?: string; onClick?: () => void; danger?: boolean
  innerRef?: React.Ref<HTMLButtonElement>
}) {
  // Error rather than warning: it matches the red corner the card wears in a
  // dangerous mode, and error-4 clears 4.5:1 in every theme on the card's own
  // surface where warning-4 doesn't (Light: 3.8:1).
  const tone = danger ? 'text-error-4' : 'text-ink-muted hover:text-ink'
  const className = `group/state flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden font-mono text-meta whitespace-nowrap transition-colors ${tone}`
  if (!onClick) return <span className={className} title={title}>{children}</span>
  return (
    <button ref={innerRef} onClick={onClick} className={className} title={title}>
      {children}
    </button>
  )
}

/**
 * A state item's text, hidden until its item is hovered or focused. Kept in the
 * DOM (rather than conditionally rendered) so screen readers and find-in-page
 * still see it.
 */
export function StateLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="sr-only group-hover/state:not-sr-only group-focus-visible/state:not-sr-only">
      {children}
    </span>
  )
}
