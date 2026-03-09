/**
 * Sidebar button with a dropdown for creating new Claude sessions.
 *
 * Shows a repo browser grouped by owner. Selecting a repo opens a new
 * session. Remote
 * (uncloned) repos are cloned on-demand before the session starts.
 * Dismisses on click-outside or Escape.
 */

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { IconPlus } from '@tabler/icons-react'
import type { Repo } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'
import { RepoList } from './RepoList'

interface Props {
  groups: RepoGroup[]
  token?: string
  onOpen: (repo: Repo) => void
}

export function NewSessionButton({ groups, token, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [cloning, setCloning] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Position popup below button, clamped to viewport
  useLayoutEffect(() => {
    if (!open || !containerRef.current || !popupRef.current) return
    const btn = containerRef.current.getBoundingClientRect()
    const popup = popupRef.current
    const popupWidth = 288 // w-72
    const top = btn.bottom + 6
    const left = Math.max(8, Math.min(btn.right - popupWidth, window.innerWidth - popupWidth - 8))
    popup.style.top = `${top}px`
    popup.style.left = `${left}px`
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
          const data = await res.json()
          throw new Error(data.error || 'Clone failed')
        }
        repo.cloned = true
      } catch {
        setCloning(null)
        return
      }
      setCloning(null)
    }

    setOpen(false)
    onOpen(repo)
  }

  return (
    <div ref={containerRef} className="relative h-full flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className={`app-new-session-btn rounded p-1.5 transition ${open ? 'bg-neutral-6 text-neutral-1' : 'text-neutral-3 hover:bg-neutral-6 hover:text-neutral-1'}`}
        title="New session"
      >
        <IconPlus size={16} stroke={2} />
      </button>

      {open && (
        <div ref={popupRef} className="fixed z-50 w-72 rounded-md border border-neutral-10 bg-neutral-12 shadow-lg">
          <div className="px-3 pt-3 pb-1">
            <h3 className="text-[15px] font-medium text-neutral-3">New Session</h3>
            <p className="mt-0.5 text-[13px] text-neutral-6">Choose a repository to work on</p>
          </div>
          <div className="px-2 pb-2">
            <RepoList
              groups={groups}
              onSelect={handleSelect}
              cloningId={cloning}
              maxHeight="240px"
            />
          </div>
        </div>
      )}
    </div>
  )
}
