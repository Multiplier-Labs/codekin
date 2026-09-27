/**
 * Miniature preview of a theme — page ground, sidebar strip, a line of text,
 * a primary pill and an accent dot — painted from the registry swatches.
 *
 * This is the one component that legitimately paints colors from a theme
 * other than the active one, so it uses inline styles rather than tokens.
 */

import type { ThemeDefinition } from '../themes/registry'

interface Props {
  theme: ThemeDefinition
  /** 'card' fills its container (Settings grid); 'chip' is a small inline sample (menus). */
  variant?: 'card' | 'chip'
}

export function ThemeSwatch({ theme, variant = 'card' }: Props) {
  const { page, surface, ink, primary, accent } = theme.swatches

  if (variant === 'chip') {
    return (
      <span
        aria-hidden
        className="flex h-4 w-7 flex-shrink-0 overflow-hidden rounded-control border border-edge"
        style={{ backgroundColor: page }}
      >
        <span className="h-full w-2" style={{ backgroundColor: surface }} />
        <span className="flex flex-1 items-center justify-center gap-0.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: primary }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
        </span>
      </span>
    )
  }

  return (
    <span aria-hidden className="flex h-14 w-full overflow-hidden rounded-control border border-edge" style={{ backgroundColor: page }}>
      <span className="h-full w-1/4" style={{ backgroundColor: surface }} />
      <span className="flex flex-1 flex-col justify-center gap-1.5 px-2">
        <span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: ink }} />
        <span className="h-1 w-3/5 rounded-full opacity-60" style={{ backgroundColor: ink }} />
        <span className="flex items-center gap-1">
          <span className="h-2 w-5 rounded-full" style={{ backgroundColor: primary }} />
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
        </span>
      </span>
    </span>
  )
}
