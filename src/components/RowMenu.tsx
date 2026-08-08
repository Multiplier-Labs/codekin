/**
 * RowMenu — the persistent overflow menu attached to a sidebar row.
 *
 * One implementation for every row action. It replaces the hover-revealed
 * controls that were unreachable on touch, and the two hand-rolled
 * viewport-flip positioners that used to live in RepoSection and
 * NewSessionButton.
 *
 * Positioned `fixed` and measured on open, because the sidebar's scroll
 * container clips absolutely positioned children.
 */

import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { IconDots } from '@tabler/icons-react'

export interface RowMenuItem {
  label: string
  icon?: React.ReactNode
  onSelect: () => void
  /** Hover hint, e.g. a provider's description. */
  title?: string
  /** Destructive actions render in the error colour. */
  danger?: boolean
  /** Draw a rule above this item — used to fence off destructive actions. */
  separated?: boolean
}

interface Props {
  items: RowMenuItem[]
  /** Accessible name, e.g. "Actions for codekin". */
  label: string
  /** Extra classes for the trigger button. */
  className?: string
  /** Trigger content; defaults to the `⋯` glyph. */
  trigger?: React.ReactNode
  /** Replaces the default icon-button styling — for a full-width row trigger. */
  triggerClassName?: string
  /** Lets the host react to the menu opening (e.g. pin a hover-revealed row). */
  onOpenChange?: (open: boolean) => void
}

const MENU_WIDTH = 200
const VIEWPORT_MARGIN = 8

export function RowMenu({ items, label, className = '', trigger, triggerClassName, onOpenChange }: Props) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Anchor below the trigger, flipping above when it would overflow the
  // viewport and clamping horizontally.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return
    const btn = buttonRef.current.getBoundingClientRect()
    const menu = menuRef.current
    const height = menu.offsetHeight
    const top = btn.bottom + height + VIEWPORT_MARGIN > window.innerHeight
      ? Math.max(VIEWPORT_MARGIN, btn.top - height - 4)
      : btn.bottom + 4
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(btn.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    )
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`
  }, [open])

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen(o => !o)
  }, [])

  if (items.length === 0) return null

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className={`${triggerClassName ?? `tap-target flex-shrink-0 rounded-control p-0.5 transition-colors ${
          open ? 'text-ink bg-surface-raised' : 'text-ink-faint hover:text-ink hover:bg-surface-raised'
        }`} ${className}`}
      >
        {trigger ?? <IconDots size={14} stroke={2} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ width: MENU_WIDTH }}
          className="fixed z-50 rounded-floating border border-edge-strong bg-surface-raised py-1 shadow-floating"
        >
          {items.map((item, i) => (
            <div key={item.label}>
              {item.separated && i > 0 && <div className="my-1 border-t border-edge" />}
              <button
                role="menuitem"
                title={item.title}
                onClick={(e) => { e.stopPropagation(); setOpen(false); item.onSelect() }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition-colors ${
                  item.danger
                    ? 'text-error-5 hover:bg-error-9/20'
                    : 'text-ink hover:bg-edge'
                }`}
              >
                {item.icon && <span className="flex-shrink-0 text-ink-muted">{item.icon}</span>}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
