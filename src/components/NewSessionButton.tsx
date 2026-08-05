/**
 * Sidebar button with a dropdown for creating new sessions.
 *
 * One menu, two steps: pick a repo, then pick a provider. Remote (uncloned)
 * repos are cloned on-demand before the session starts. Dismisses on
 * click-outside or Escape.
 *
 * The popover is positioned by the header's own stacking context — the
 * sidebar header sits outside the scroll container, so no measured
 * viewport-flip is needed.
 */

import { useState, useRef, useEffect } from 'react'
import { IconPlus, IconChevronLeft } from '@tabler/icons-react'
import type { Repo, CodingProvider } from '../types'
import { PROVIDERS } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'
import { RepoList } from './RepoList'

interface Props {
  groups: RepoGroup[]
  token?: string
  onOpen: (repo: Repo, provider?: CodingProvider) => void
}

export function NewSessionButton({ groups, token, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [cloning, setCloning] = useState<string | null>(null)
  /** Second step — set once a repo is chosen. */
  const [pendingRepo, setPendingRepo] = useState<Repo | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Reset to step one whenever the menu closes
  useEffect(() => {
    if (!open) setPendingRepo(null) // eslint-disable-line react-hooks/set-state-in-effect -- reset transient step state on close
  }, [open])

  // Close on Escape or click outside
  useEffect(() => {
    if (!open) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (containerRef.current && !containerRef.current.contains(target) &&
          popupRef.current && !popupRef.current.contains(target)) {
        setOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  async function handleSelect(repo: ApiRepo) {
    if (cloning) return
    if (!repo.cloned) {
      setCloning(repo.id)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch('/cc/api/clone', {
          method: 'POST',
          headers,
          body: JSON.stringify({ owner: repo.owner, name: repo.name }),
        })
        if (!res.ok) {
          const data = await res.json() as { error?: string }
          throw new Error(data.error || 'Clone failed')
        }
        repo.cloned = true
      } catch {
        setCloning(null)
        return
      }
      setCloning(null)
    }

    // Step two — which provider runs in it
    setPendingRepo(repo)
  }

  return (
    <div ref={containerRef} className="relative h-full flex items-center">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`app-new-session-btn rounded-control p-1.5 transition ${open ? 'bg-surface-raised text-ink' : 'text-ink hover:bg-surface-raised hover:text-ink'}`}
        title="New session"
      >
        <IconPlus size={16} stroke={2} />
      </button>

      {open && (
        <div ref={popupRef} className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-floating border border-edge-strong bg-surface-raised shadow-floating">
          {pendingRepo ? (
            <>
              <div className="flex items-center gap-1.5 px-3 pt-3 pb-1">
                <button
                  onClick={() => setPendingRepo(null)}
                  className="rounded-control p-0.5 text-ink-muted transition-colors hover:bg-edge hover:text-ink"
                  title="Back to repositories"
                >
                  <IconChevronLeft size={14} stroke={2} />
                </button>
                <div className="min-w-0">
                  <h3 className="truncate text-body font-medium text-ink">{pendingRepo.name}</h3>
                  <p className="text-body text-ink-faint">Choose a provider</p>
                </div>
              </div>
              <div className="px-2 pb-2">
                {PROVIDERS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { setOpen(false); onOpen(pendingRepo, p.id) }}
                    className="density-row flex w-full items-center rounded-control px-2 text-left text-body text-ink transition-colors hover:bg-edge"
                    title={p.description}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="px-3 pt-3 pb-1">
                <h3 className="text-body font-medium text-ink">New session</h3>
                <p className="mt-0.5 text-body text-ink-faint">Choose a repository to work on</p>
              </div>
              <div className="px-2 pb-2">
                <RepoList
                  groups={groups}
                  onSelect={handleSelect}
                  cloningId={cloning}
                  maxHeight="240px"
                  autoFocus
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
