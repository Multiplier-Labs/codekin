/**
 * Landing page shown when no session is active.
 *
 * Displays available repositories grouped by owner, with icons indicating
 * whether each repo is cloned locally or only available remotely.
 * Clicking a remote repo triggers an on-demand clone before opening.
 */

import { useState } from 'react'
import { IconGitBranch, IconCloud } from '@tabler/icons-react'
import type { Repo } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'

interface Props {
  groups: RepoGroup[]
  token?: string
  onOpen: (repo: Repo) => void
}

export function RepoSelector({ groups, token, onOpen }: Props) {
  const [cloning, setCloning] = useState<string | null>(null)

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

    onOpen(repo)
  }

  const totalRepos = groups.reduce((n, g) => n + g.repos.length, 0)

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-7/50">
            <IconGitBranch size={24} stroke={1.5} className="text-neutral-3" />
          </div>
          <h2 className="text-[19px] font-medium text-neutral-2">Choose a repository to start a Claude Code session</h2>
        </div>

        {totalRepos === 0 ? (
          <p className="text-center text-[17px] text-neutral-6">No repositories configured</p>
        ) : (
          <div className="max-h-[240px] overflow-y-auto rounded-lg border border-neutral-7 bg-neutral-11/50">
            {groups.map((group) => (
              <div key={group.owner}>
                <div className="sticky top-0 z-10 bg-neutral-8 backdrop-blur-sm px-3 py-1.5 text-[13px] font-medium uppercase tracking-wider text-neutral-4 border-b border-neutral-7">
                  {group.owner}
                </div>
                {group.repos.map((repo) => {
                  const isCloning = cloning === repo.id
                  return (
                    <button
                      key={repo.id}
                      onClick={() => handleSelect(repo)}
                      disabled={!!cloning}
                      className={`group flex w-full items-start gap-3 border-b border-neutral-7/50 px-3 py-2.5 text-left transition last:border-b-0 ${
                        cloning ? 'cursor-wait opacity-60' : 'hover:bg-neutral-7/20'
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
                          <span className="text-[17px] font-medium text-neutral-2 group-hover:text-neutral-1 transition-colors truncate">
                            {repo.name}
                          </span>
                          {isCloning && (
                            <span className="flex-shrink-0 rounded bg-primary-9/30 px-1.5 py-0.5 text-[13px] text-primary-4 animate-pulse">
                              cloning...
                            </span>
                          )}
                          {!repo.cloned && !isCloning && (
                            <span className="flex-shrink-0 rounded border border-neutral-6/40 bg-neutral-8/30 px-1.5 py-0.5 text-[13px] text-neutral-5">
                              remote
                            </span>
                          )}
                        </div>
                        {repo.description && (
                          <div className="mt-0.5 text-[15px] text-neutral-6 truncate">
                            {repo.description}
                          </div>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
