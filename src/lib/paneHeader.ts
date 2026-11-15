/**
 * The one pane header: sidebar, chat, Canvas and Changes all use the same
 * height (--pane-header-h: 40px, 48px on touch), so their bottom borders meet
 * in one line whenever the panes sit side by side. No fill of its own: the
 * header sits on its pane's ground. Text controls inside are PANE_CONTROL
 * high. Callers add their own horizontal padding and gap.
 */
export const PANE_HEADER = 'flex h-(--pane-header-h) shrink-0 items-center border-b border-edge'

/** Height of a text control (chip, button) inside a pane header. */
export const PANE_CONTROL = 'h-(--pane-control-h)'
