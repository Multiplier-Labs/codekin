/**
 * Fetches available repositories, global skills, and global modules
 * from the server API on mount.
 *
 * Repos are returned both grouped by owner (for the repo selector UI)
 * and as a flat list (for the command palette). Each repo includes
 * clone status, description, and any repo-specific skills/modules.
 */

import { useState, useEffect } from 'react'
import type { Repo, Skill, Module } from '../types'

/** Extended repo data returned by the /cc/api/repos endpoint. */
export interface ApiRepo extends Repo {
  cloned: boolean
  description: string
  url: string
  owner: string
}

export interface RepoGroup {
  owner: string
  repos: ApiRepo[]
}

export function useRepos(token?: string) {
  const [groups, setGroups] = useState<RepoGroup[]>([])
  const [globalSkills, setGlobalSkills] = useState<Skill[]>([])
  const [globalModules, setGlobalModules] = useState<Module[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ghMissing, setGhMissing] = useState(false)

  // Flat list for compatibility (CommandPalette, etc.)
  const repos = groups.flatMap(g => g.repos)

  useEffect(() => {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    fetch('/cc/api/repos', { headers })
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load repos: ${res.status}`)
        return res.json() as Promise<{ groups: RepoGroup[]; globalSkills?: Skill[]; globalModules?: Module[]; ghMissing?: boolean }>
      })
      .then(data => {
        setGroups(data.groups)
        setGlobalSkills(data.globalSkills ?? [])
        setGlobalModules(data.globalModules ?? [])
        setGhMissing(data.ghMissing ?? false)
        setError(null)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

  return { groups, repos, globalSkills, globalModules, loading, error, ghMissing }
}
