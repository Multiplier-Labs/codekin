/**
 * Fetches available repositories, global skills, and global modules
 * from the server API on mount.
 *
 * Repos are returned both grouped by owner (for the repo selector UI)
 * and as a flat list (for the command palette). Each repo includes
 * clone status, description, and any repo-specific skills/modules.
 *
 * Local checkouts under the repositories root are always listed (a "Local"
 * group holds ones not matched to a GitHub repo); the GitHub CLI is optional
 * enrichment whose state is reported separately as `ghStatus`.
 */

import { useState, useEffect, useCallback } from 'react'
import type { Repo, Skill, Module } from '../types'
import { transport } from '../lib/transport'

/** Extended repo data returned by the /api/repos endpoint. */
export interface ApiRepo extends Repo {
  cloned: boolean
  description: string
  url: string
  owner: string
}

export interface RepoGroup {
  owner: string
  /** `github` for an owner listed via `gh`; `local` for unmatched on-disk checkouts. */
  source?: 'github' | 'local'
  repos: ApiRepo[]
  /** This owner's listing failed (e.g. SSO-enforced org); other groups are unaffected. */
  error?: string
}

/**
 * State of the optional GitHub CLI integration on the host; `unknown` until
 * the first successful response.
 */
export type GhStatus = 'ok' | 'missing' | 'unauthenticated' | 'error' | 'unknown'

interface ReposResponse {
  groups: RepoGroup[]
  globalSkills?: Skill[]
  globalModules?: Module[]
  ghMissing?: boolean
  ghStatus?: Exclude<GhStatus, 'unknown'>
  ghError?: string
}

/** Human-readable reason for a failed repo fetch. Exported for tests. */
export function describeReposError(status: number): string {
  if (status === 504) return 'Timed out loading repositories'
  if (status === 401) return 'Not authorized to list repositories'
  return `Failed to load repositories (HTTP ${status})`
}

export function useRepos(token?: string) {
  const [groups, setGroups] = useState<RepoGroup[]>([])
  const [globalSkills, setGlobalSkills] = useState<Skill[]>([])
  const [globalModules, setGlobalModules] = useState<Module[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ghStatus, setGhStatus] = useState<GhStatus>('unknown')
  const [ghError, setGhError] = useState<string | null>(null)

  // Flat list for compatibility (CommandPalette, etc.)
  const repos = groups.flatMap(g => g.repos)

  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    transport.fetch('/api/repos', { headers })
      .then(res => {
        if (!res.ok) throw new Error(describeReposError(res.status))
        return res.json() as Promise<ReposResponse>
      })
      .then(data => {
        if (cancelled) return
        setGroups(data.groups)
        setGlobalSkills(data.globalSkills ?? [])
        setGlobalModules(data.globalModules ?? [])
        // Older servers send only ghMissing.
        setGhStatus(data.ghStatus ?? (data.ghMissing ? 'missing' : 'ok'))
        setGhError(data.ghError ?? null)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [token, refreshCount])

  // Loading starts true for the mount fetch; a refresh (e.g. Retry) re-enters it.
  const refresh = useCallback(() => {
    setLoading(true)
    setRefreshCount(c => c + 1)
  }, [])

  const ghMissing = ghStatus === 'missing'
  return { groups, repos, globalSkills, globalModules, loading, error, ghMissing, ghStatus, ghError, refresh }
}
