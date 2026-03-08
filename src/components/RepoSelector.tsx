/**
 * Landing page shown when no session is active.
 *
 * Displays available repositories grouped by owner, with icons indicating
 * whether each repo is cloned locally or only available remotely.
 * Clicking a remote repo triggers an on-demand clone before opening.
 */

import { useState } from 'react'
import { IconGitBranch } from '@tabler/icons-react'
import type { Repo } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'
import { RepoList } from './RepoList'

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
          <RepoList
            groups={groups}
            onSelect={handleSelect}
            cloningId={cloning}
            autoFocus
          />
        )}
      </div>
    </div>
  )
}
