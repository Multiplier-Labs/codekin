/**
 * Local repository discovery (audit N4).
 *
 * Finds Git checkouts under the configured repositories root without any
 * dependency on the GitHub CLI, so a machine with no `gh` (or an
 * unauthenticated one) still lists the projects that are already on disk.
 *
 * Both layouts are supported, to a bounded depth of two:
 *   - flat:              <root>/<project>/.git
 *   - owner-namespaced:  <root>/<owner>/<project>/.git
 *
 * The scan is readdir + stat only; the `origin` remote is read straight from
 * the repository's config file rather than by spawning `git` per directory.
 * `.git` may be a file (worktrees, submodules) — its `gitdir:` pointer and the
 * worktree's `commondir` are followed to find the shared config.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

/** A Git checkout found on disk under the repos root. */
export interface LocalRepo {
  /** Absolute path of the working tree. */
  path: string
  /** Path relative to the repos root (`project` or `owner/project`). */
  relPath: string
  /** Directory name. */
  name: string
  /** Raw `origin` URL from the repo config, if any. */
  originUrl: string | null
  /** Normalized `host/owner/name` form of `originUrl` (see normalizeRemoteUrl). */
  remoteKey: string | null
}

/** Directories never descended into while scanning. */
const SKIP_DIRS = new Set(['node_modules'])

/** Default scan depth: root/project (1) and root/owner/project (2). */
export const LOCAL_DISCOVERY_MAX_DEPTH = 2

/** Upper bound on discovered repos — keeps a pathological root from stalling the request. */
const MAX_LOCAL_REPOS = 5000

/**
 * Normalize a Git remote URL to a comparable `host/path` key, lowercased,
 * without credentials, port, scheme, or a trailing `.git` / slash.
 *
 *   https://github.com/Owner/Repo.git      → github.com/owner/repo
 *   git@github.com:Owner/Repo.git          → github.com/owner/repo
 *   ssh://git@github.com:22/Owner/Repo     → github.com/owner/repo
 *   https://user:token@github.com/o/r/     → github.com/o/r
 *
 * Returns null for anything that doesn't look like a host + path remote
 * (e.g. a local filesystem path).
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const raw = url.trim()
  if (!raw) return null

  let host: string
  let path: string

  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (scheme === 'file') return null
    const rest = schemeMatch[2]
    const slash = rest.indexOf('/')
    if (slash < 0) return null
    let authority = rest.slice(0, slash)
    path = rest.slice(slash + 1)
    const at = authority.lastIndexOf('@')
    if (at >= 0) authority = authority.slice(at + 1)
    host = authority.replace(/:\d*$/, '')
  } else {
    // scp-like syntax: [user@]host:path — but not a Windows drive or local path.
    const scpMatch = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/)
    if (!scpMatch || scpMatch[1].length < 2) return null
    host = scpMatch[1]
    path = scpMatch[2]
  }

  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!host || !path) return null
  return `${host}/${path}`.toLowerCase()
}

/** `{ owner, name }` for a GitHub remote key (`github.com/owner/name`), else null. */
export function githubSlugFromKey(key: string | null): { owner: string; name: string } | null {
  if (!key) return null
  const m = key.match(/^(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/)
  return m ? { owner: m[1], name: m[2] } : null
}

/**
 * Parse the `url` of `[remote "origin"]` out of a Git config file's contents.
 * Minimal INI handling: section headers, `key = value`, `#`/`;` comments,
 * optional double quotes around the value.
 */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]/)
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'
      continue
    }
    if (!inOrigin) continue
    const kv = line.match(/^url\s*=\s*(.*)$/i)
    if (kv) {
      let value = kv[1].trim()
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
      return value || null
    }
  }
  return null
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Locate the config file for the checkout whose `.git` entry is at `dotGit`.
 * Handles `.git` directories and `.git` files (`gitdir: <path>`), following
 * a linked worktree's `commondir` back to the shared repository.
 */
export function resolveGitConfigPath(dotGit: string): string | null {
  let gitDir: string
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) {
      gitDir = dotGit
    } else if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf-8')
      const m = content.match(/^gitdir:\s*(.+)$/m)
      if (!m) return null
      const target = m[1].trim()
      gitDir = isAbsolute(target) ? target : resolve(dirname(dotGit), target)
    } else {
      return null
    }
  } catch {
    return null
  }

  // A linked worktree's gitdir holds a `commondir` pointing at the main .git.
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim()
    if (common) gitDir = isAbsolute(common) ? common : resolve(gitDir, common)
  } catch {
    // Not a linked worktree — config lives in gitDir itself.
  }
  return join(gitDir, 'config')
}

/** True when `dir` contains a `.git` directory or file. */
function hasDotGit(dir: string): boolean {
  try {
    statSync(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

function readLocalRepo(root: string, dir: string): LocalRepo {
  const configPath = resolveGitConfigPath(join(dir, '.git'))
  let originUrl: string | null = null
  if (configPath) {
    try {
      originUrl = parseOriginUrl(readFileSync(configPath, 'utf-8'))
    } catch {
      // Unreadable config — still a checkout, just without a remote.
    }
  }
  return {
    path: dir,
    relPath: relative(root, dir),
    name: basename(dir),
    originUrl,
    remoteKey: normalizeRemoteUrl(originUrl),
  }
}

/**
 * Scan `root` for Git checkouts, flat and owner-namespaced. A directory that is
 * itself a checkout is not descended into (its subfolders are its contents,
 * not more projects). Hidden directories and node_modules are skipped.
 * Results are sorted by relative path. Never throws — an unreadable root
 * yields an empty list.
 */
export function discoverLocalRepos(root: string, maxDepth: number = LOCAL_DISCOVERY_MAX_DEPTH): LocalRepo[] {
  const found: LocalRepo[] = []

  const walk = (dir: string, depth: number) => {
    if (found.length >= MAX_LOCAL_REPOS) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_LOCAL_REPOS) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const child = join(dir, entry.name)
      // Symlinked directories count (stat follows them); depth bounds any loop.
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(child))) continue
      if (hasDotGit(child)) {
        found.push(readLocalRepo(root, child))
      } else if (depth < maxDepth) {
        walk(child, depth + 1)
      }
    }
  }

  walk(root, 1)
  found.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return found
}
