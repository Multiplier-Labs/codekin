/**
 * Searchable, grouped repo list used by both RepoSelector (sidebar)
 * and AddWorkflowModal.
 */

import { useEffect, useRef, useState } from 'react'
import { IconGitBranch, IconCloud } from '@tabler/icons-react'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'

interface Props {
  groups: RepoGroup[]
  /** Currently selected repo id (highlighted with accent border). */
  selectedId?: string
  onSelect: (repo: ApiRepo) => void
  /** Repo currently being cloned (shows pulsing badge). */
  cloningId?: string | null
  /** Max height for the scrollable list. */
  maxHeight?: string
  autoFocus?: boolean
}

export function RepoList({ groups, selectedId, onSelect, cloningId, maxHeight = '240px', autoFocus }: Props) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const filteredGroups = search.trim()
    ? groups.map(g => ({
        ...g,
        repos: g.repos.filter(r =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          r.description?.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(g => g.repos.length > 0)
    : groups

  const totalRepos = groups.reduce((n, g) => n + g.repos.length, 0)

  if (totalRepos === 0) {
    return <p className="text-center text-[15px] text-neutral-6 py-2">No repositories available</p>
  }

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search repos…"
        className="mb-2 w-full rounded-lg border border-neutral-7 bg-neutral-11/50 px-3 py-2 text-[15px] text-neutral-2 placeholder-neutral-5 focus:border-accent-6 focus:outline-none"
      />
      <div className="overflow-y-auto rounded-lg border border-neutral-7 bg-neutral-11/50" style={{ maxHeight }}>
        {filteredGroups.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-neutral-5 text-center">No matching repos</p>
        ) : (
          filteredGroups.map((group) => (
            <div key={group.owner}>
              <div className="sticky top-0 z-10 bg-neutral-8 backdrop-blur-sm px-3 py-1.5 text-[13px] font-medium uppercase tracking-wider text-neutral-4 border-b border-neutral-7">
                {group.owner}
              </div>
              {group.repos.map((repo) => {
                const isCloning = cloningId === repo.id
                const isSelected = selectedId === repo.id
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => onSelect(repo)}
                    disabled={!!cloningId}
                    className={`group flex w-full items-start gap-3 border-b border-neutral-7/50 px-3 py-2.5 text-left transition last:border-b-0 ${
                      isSelected
                        ? 'bg-accent-9/20 border-l-2 border-l-accent-6'
                        : cloningId ? 'cursor-wait opacity-60' : 'hover:bg-neutral-7/20'
                    }`}
                  >
                    <div className="mt-0.5 flex-shrink-0 text-neutral-4 group-hover:text-neutral-3 transition-colors">
                      {repo.cloned ? (
                        <IconGitBranch size={16} stroke={1.5} />
                      ) : (
                        <IconCloud size={16} stroke={1.5} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-medium text-neutral-2 group-hover:text-neutral-1 transition-colors truncate">
                          {repo.name}
                        </span>
                        {isCloning && (
                          <span className="flex-shrink-0 rounded bg-primary-9/30 px-1.5 py-0.5 text-[13px] text-primary-4 animate-pulse">
                            cloning...
                          </span>
                        )}
                        {!repo.cloned && !isCloning && (
                          <span className="flex-shrink-0 rounded border border-neutral-6 bg-neutral-8/50 px-1.5 py-0.5 text-[13px] text-neutral-3">
                            remote
                          </span>
                        )}
                      </div>
                      {repo.description && (
                        <div className="mt-0.5 text-[13px] text-neutral-6 truncate">
                          {repo.description}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </>
  )
}
