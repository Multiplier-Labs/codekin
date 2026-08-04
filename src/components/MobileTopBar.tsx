/**
 * Top app bar shown on mobile viewports (< 1024px).
 *
 * Provides a hamburger button to open the sidebar drawer, the current
 * session/repo name, and a new-session shortcut.
 */

import { IconMenu2, IconPlus, IconSettings } from '@tabler/icons-react'
import type { Repo } from '../types'
import AppIcon from './AppIcon'

interface Props {
  repoName: string | null
  sessionName: string | null
  onMenuOpen: () => void
  onNewSession: () => void
  onSettingsOpen: () => void
  activeRepo: Repo | null
}

export function MobileTopBar({ repoName, sessionName, onMenuOpen, onNewSession, onSettingsOpen }: Props) {
  return (
    <div className="app-left-sidebar mobile-top-bar-safe flex items-center h-12 px-1.5 border-b border-edge bg-surface flex-shrink-0">
      <button
        onClick={onMenuOpen}
        className="flex items-center justify-center rounded-control size-[34px] text-ink hover:text-ink hover:bg-surface-raised transition-colors"
        aria-label="Open menu"
      >
        <IconMenu2 size={24} stroke={2} />
      </button>

      <div className="flex items-center gap-2 flex-1 min-w-0 px-1.5">
        <AppIcon size={24} className="text-primary-7 flex-shrink-0" />
        <div className="flex-1 min-w-0 truncate text-body text-ink">
          {repoName ? (
            <>
              <span className="font-semibold">{repoName}</span>
              {sessionName && (
                <span className="text-ink-muted ml-1.5">/ {sessionName}</span>
              )}
            </>
          ) : (
            <span className="font-semibold">Codekin</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          onClick={onSettingsOpen}
          className="flex items-center justify-center rounded-control size-[34px] text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors"
          aria-label="Settings"
        >
          <IconSettings size={24} stroke={2} />
        </button>

        <button
          onClick={onNewSession}
          className="flex items-center justify-center rounded-control size-[34px] text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors"
          aria-label="New session"
        >
          <IconPlus size={24} stroke={2} />
        </button>
      </div>
    </div>
  )
}
