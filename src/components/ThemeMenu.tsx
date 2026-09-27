/**
 * ThemeMenu — sidebar button that opens a popover listing every theme.
 *
 * Selecting a row applies the theme immediately. Hovering does not preview:
 * repainting the whole app on pointer movement flickers. Keyboard: arrows
 * move, Enter/Space select, Escape closes.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconCheck, IconPalette } from '@tabler/icons-react'
import { THEMES, type ThemeId } from '../themes/registry'
import { ThemeSwatch } from './ThemeSwatch'

interface Props {
  theme: ThemeId
  onSelect: (theme: ThemeId) => void
  /** Classes for the trigger button, so it matches its neighbours. */
  buttonClassName: string
  /** Icon sizing: a pixel size, or the density-token icon class. */
  iconSize?: number
  iconClassName?: string
}

export function ThemeMenu({ theme, onSelect, buttonClassName, iconSize, iconClassName }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    const selected = THEMES.findIndex(t => t.id === theme)
    optionRefs.current[Math.max(selected, 0)]?.focus()
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => { document.removeEventListener('mousedown', handleClick) }
    // Focus the current theme only when the menu opens, not on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleKeyDown(e: KeyboardEvent) {
    const index = optionRefs.current.findIndex(el => el === document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = (index + delta + THEMES.length) % THEMES.length
      optionRefs.current[next]?.focus()
    }
  }

  const current = THEMES.find(t => t.id === theme)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(o => !o) }}
        className={buttonClassName}
        title={`Theme: ${current?.label ?? theme}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <IconPalette size={iconSize} className={iconClassName} stroke={2} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Theme"
          onKeyDown={handleKeyDown}
          className="absolute bottom-full left-0 z-50 mb-2 w-52 rounded-floating border border-edge-strong bg-surface-raised p-1 shadow-floating"
        >
          <div className="px-2 pb-1 pt-1.5 text-micro font-medium uppercase tracking-wider text-ink-muted">Theme</div>
          {THEMES.map((t, i) => (
            <button
              key={t.id}
              ref={el => { optionRefs.current[i] = el }}
              role="option"
              aria-selected={t.id === theme}
              onClick={() => { onSelect(t.id); setOpen(false) }}
              className="flex w-full items-center gap-2 rounded-control text-left text-body text-ink hover:bg-edge focus:bg-edge focus:outline-none"
              style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--row-pad)' }}
            >
              <ThemeSwatch theme={t} variant="chip" />
              <span className="flex-1 truncate">{t.label}</span>
              {t.id === theme && <IconCheck size={14} stroke={2} className="flex-shrink-0 text-accent-5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
