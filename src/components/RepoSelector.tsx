/**
 * Landing page shown when no session is active.
 *
 * Displays available repositories grouped by owner, with icons indicating
 * whether each repo is cloned locally or only available remotely.
 * Clicking a remote repo triggers an on-demand clone before opening.
 */

import { useState, useEffect } from 'react'
import { IconGitBranch } from '@tabler/icons-react'
import type { Repo } from '../types'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'
import { RepoList } from './RepoList'
import { FolderPicker } from './FolderPicker'
import { EnvironmentChecklist } from './EnvironmentChecklist'
import { cloneRepo, getReposPath, setReposPath as setReposPathApi } from '../lib/ccApi'

interface Props {
  groups: RepoGroup[]
  token?: string
  ghMissing?: boolean
  onOpen: (repo: Repo) => void
  onRefreshRepos?: () => void
}

export function RepoSelector({ groups, token, ghMissing, onOpen, onRefreshRepos }: Props) {
  const [cloning, setCloning] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [reposPath, setReposPath] = useState('')

  useEffect(() => {
    if (token) {
      getReposPath(token).then(p => { setReposPath(p) }).catch(() => {})
    }
  }, [token])

  async function handleSaveReposPath(path: string) {
    if (!token) return
    await setReposPathApi(token, path)
    setReposPath(path)
    onRefreshRepos?.()
  }

  async function handleSelect(repo: ApiRepo) {
    if (cloning) return

    if (!repo.cloned) {
      setCloning(repo.id)
      setCloneError(null)
      try {
        await cloneRepo(token, repo.owner, repo.name)
        repo.cloned = true
      } catch (err) {
        // Say why — a failed clone that just puts the list back looks like a
        // dead click.
        setCloneError(err instanceof Error ? err.message : 'Clone failed')
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
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-edge-strong/50">
            <IconGitBranch size={24} stroke={1.5} className="text-ink" />
          </div>
          <h2 className="text-head font-medium text-ink">Choose a repository to start a session</h2>
        </div>

        {/* Live environment checks — agents, gh, repos — with fixes inline. */}
        <EnvironmentChecklist ghMissing={ghMissing ?? false} repoCount={totalRepos} />

        {totalRepos === 0 ? (
          <p className="text-center text-title text-ink-faint">No repositories yet</p>
        ) : (
          <>
            <RepoList
              groups={groups}
              onSelect={handleSelect}
              cloningId={cloning}
              autoFocus
            />
            {cloneError && (
              <div className="mt-2 rounded-control bg-error-10/50 px-3 py-2 text-meta text-error-4">{cloneError}</div>
            )}
          </>
        )}

        {/* Repos path setting */}
        <div className="mt-6 border-t border-edge-strong pt-5">
          <FolderPicker
            value={reposPath}
            token={token}
            helpText="Absolute path to your locally cloned repositories"
            onSave={handleSaveReposPath}
          />
        </div>
      </div>
    </div>
  )
}
