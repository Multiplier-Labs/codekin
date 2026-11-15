/**
 * The one pane header: chat, Canvas and Changes all use it, so their headers
 * line up whenever the panes sit side by side. 48px tall on the panel surface,
 * with 32px controls (`h-8`) inside. Callers add their own horizontal padding
 * and gap.
 */
export const PANE_HEADER = 'flex h-12 shrink-0 items-center border-b border-edge bg-surface'
