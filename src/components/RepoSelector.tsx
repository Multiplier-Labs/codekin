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
import type { ApiRepo, GhStatus, RepoGroup } from '../hooks/useRepos'
import { RepoList } from './RepoList'
import { FolderPicker } from './FolderPicker'
import { EnvironmentChecklist } from './EnvironmentChecklist'
import { cloneRepo, getReposPath, setReposPath as setReposPathApi } from '../lib/ccApi'

interface Props {
  groups: RepoGroup[]
  token?: string
  /** State of the optional GitHub CLI on the host. */
  ghStatus?: GhStatus
  ghError?: string | null
  /** The repository list is being fetched. */
  loading?: boolean
  /** The repository fetch failed (network, timeout) — distinct from "no repositories". */
  error?: string | null
  onOpen: (repo: Repo) => void
  onRefreshRepos?: () => void
}

export function RepoSelector({ groups, token, ghStatus = 'unknown', ghError, loading, error, onOpen, onRefreshRepos }: Props) {
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
        const path = await cloneRepo(token, repo.owner, repo.name)
        repo.cloned = true
        // The server may point at an existing checkout rather than a fresh clone.
        if (path) { repo.path = path; repo.workingDir = path }
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
        <EnvironmentChecklist
          ghStatus={ghStatus}
          ghError={ghError}
          repoCount={totalRepos}
          reposLoading={loading}
          reposError={error}
        />

        {/* Loading, fetch failure, and a genuinely empty root are different
            situations with different next actions — never collapse them into
            "No repositories yet". */}
        {error && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-control bg-error-10/50 px-3 py-2 text-meta text-error-4">
            <span className="min-w-0">
              {error}
              {totalRepos > 0 ? ' — showing the last loaded list.' : '.'}
            </span>
            {onRefreshRepos && (
              <button
                type="button"
                onClick={onRefreshRepos}
                disabled={loading}
                className="flex-shrink-0 rounded-control border border-error-6 px-2 py-0.5 text-meta text-error-4 hover:bg-error-10 disabled:cursor-wait disabled:opacity-60"
              >
                {loading ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </div>
        )}

        {totalRepos === 0 ? (
          error ? null : loading ? (
            <p className="text-center text-body text-ink-faint">Loading repositories…</p>
          ) : (
            <div className="text-center">
              <p className="text-title text-ink-faint">No repositories yet</p>
              <p className="mt-1 text-meta text-ink-faint">
                Git checkouts under the repositories path below appear here
                {ghStatus === 'ok' ? '.' : ' — connect the GitHub CLI to also list and clone GitHub repos.'}
              </p>
              {groups.filter(g => g.error).map(g => (
                <p key={g.owner} className="mt-1 text-meta text-warning-4">Couldn't list {g.owner}: {g.error}</p>
              ))}
            </div>
          )
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
