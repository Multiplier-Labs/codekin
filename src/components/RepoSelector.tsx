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

        {ghMissing ? (
          <div className="rounded-control border border-warning-5/30 bg-warning-5/10 px-4 py-3 text-body text-ink">
            <p className="mb-2 font-medium text-warning-4">GitHub CLI (gh) not found</p>
            <p className="text-ink-muted">The repo browser needs <code className="rounded-control bg-edge-strong px-1 py-0.5 text-ink">gh</code> to list and clone your repositories.</p>
            <p className="mt-2 text-ink-muted">
              Install it:{' '}
              <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="text-warning-4 underline underline-offset-2 hover:text-warning-3">
                https://cli.github.com
              </a>
            </p>
            <p className="mt-1 text-ink-muted">
              Then run: <code className="rounded-control bg-edge-strong px-1 py-0.5 text-ink">gh auth login</code>
            </p>
          </div>
        ) : totalRepos === 0 ? (
          <p className="text-center text-title text-ink-faint">No repositories configured</p>
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
