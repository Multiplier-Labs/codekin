/**
 * Browse folders on the machine through /api/browse-dirs.
 *
 * Shared by FolderPicker (Settings) and the place picker in the new-session
 * composer. Holds one listing at a time; `open` replaces it, `up` lists the
 * parent. Requests that resolve after a newer one are dropped, so fast
 * keyboard navigation never shows a stale folder.
 */

import { useCallback, useRef, useState } from 'react'
import { browseDirs, type DirListing } from '../lib/ccApi'

export interface DirBrowser {
  /** The folder currently listed; null before the first listing. */
  path: string | null
  dirs: string[]
  /** Subfolders that are git work trees. */
  gitDirs: ReadonlySet<string>
  /** The listed folder is in a git work tree. */
  git: boolean
  /** Root of the work tree containing the listed folder; null outside one. */
  repoRoot: string | null
  /** Roots every session folder must sit inside (empty until known). */
  roots: string[]
  home: string | null
  loading: boolean
  error: string | null
  /** List `path` (the home directory when omitted). Resolves to the listing, or null on failure. */
  open: (path?: string) => Promise<DirListing | null>
  /** List the parent of the current folder. */
  up: () => Promise<DirListing | null>
  /** Forget the listing (e.g. when a popover closes). */
  reset: () => void
}

/** Parent of an absolute path; `/` stays `/`. Exported for tests. */
export function parentDir(path: string): string {
  return path.replace(/\/[^/]+\/?$/, '') || '/'
}

/** Join a folder and one child name. Exported for tests. */
export function childDir(path: string, name: string): string {
  return path === '/' ? `/${name}` : `${path.replace(/\/+$/, '')}/${name}`
}

export function useDirBrowser(token: string | undefined): DirBrowser {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const open = useCallback(async (path?: string): Promise<DirListing | null> => {
    if (!token) return null
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const result = await browseDirs(token, path)
      if (mine !== seq.current) return null
      setListing(result)
      return result
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : 'Failed to browse directory')
      return null
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [token])

  const up = useCallback(() => {
    if (!listing) return Promise.resolve(null)
    return open(parentDir(listing.path))
  }, [listing, open])

  const reset = useCallback(() => {
    seq.current++
    setListing(null)
    setLoading(false)
    setError(null)
  }, [])

  return {
    path: listing?.path ?? null,
    dirs: listing?.dirs ?? [],
    gitDirs: new Set(listing?.gitDirs ?? []),
    git: listing?.git ?? false,
    repoRoot: listing?.repoRoot ?? null,
    roots: listing?.roots ?? [],
    home: listing?.home ?? null,
    loading,
    error,
    open,
    up,
    reset,
  }
}
