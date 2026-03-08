/**
 * Sidebar button with a dropdown for creating new Claude sessions.
 *
 * Shows a repo browser grouped by owner. Selecting a repo opens a new
 * session; an optional name field allows custom session labels. Remote
 * (uncloned) repos are cloned on-demand before the session starts.
 * Dismisses on click-outside or Escape.
 */

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { IconPlus } from '@tabler/icons-react'
import type { Repo } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'

interface Props {
  groups: RepoGroup[]
  token?: string
  onOpen: (repo: Repo, sessionName?: string) => void
}

export function NewSessionButton({ groups, token, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [cloning, setCloning] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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

  // Focus input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
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
    const name = sessionName.trim() || undefined

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
    setSessionName('')
    onOpen(repo, name)
  }

  return (
    <div ref={containerRef} className="relative h-full flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className={`app-new-session-btn rounded p-1.5 transition ${open ? 'bg-neutral-6 text-neutral-1' : 'text-neutral-4 hover:bg-neutral-6 hover:text-neutral-1'}`}
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
          <div className="p-2">
            <input
              ref={inputRef}
              type="text"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              placeholder="Session name (optional)"
              className="w-full rounded border border-neutral-10 bg-neutral-11 px-2.5 py-1.5 text-[15px] text-neutral-2 placeholder-neutral-8 outline-none focus:border-primary-8/50"
            />
          </div>
          <div className="max-h-72 overflow-y-auto px-1 pb-1">
            {groups.map(group => (
              <div key={group.owner}>
                <div className="px-2.5 pb-1 pt-2 text-[12px] font-medium uppercase tracking-wider text-neutral-7">
                  {group.owner}
                </div>
                {group.repos.map(repo => {
                  const isCloning = cloning === repo.id
                  return (
                    <button
                      key={`${group.owner}/${repo.id}`}
                      onClick={() => handleSelect(repo)}
                      disabled={!!cloning}
                      className={`w-full rounded px-2.5 py-1.5 text-left transition ${
                        cloning ? 'cursor-wait' : 'hover:bg-neutral-10/50'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[15px] font-medium ${repo.cloned ? 'text-neutral-2' : 'text-neutral-5'}`}>
                          {repo.name}
                        </span>
                        {isCloning && (
                          <span className="rounded bg-primary-9/30 px-1.5 py-0.5 text-[12px] text-primary-4 animate-pulse">cloning...</span>
                        )}
                        {!repo.cloned && !isCloning && (
                          <span className="rounded bg-neutral-10 px-1.5 py-0.5 text-[12px] text-neutral-7">remote</span>
                        )}
                      </div>
                      {repo.description && (
                        <div className="mt-0.5 text-[13px] text-neutral-7 truncate">{repo.description}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
            {groups.length === 0 && (
              <p className="py-4 text-center text-[15px] text-neutral-5">No repos found</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
