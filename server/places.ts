/**
 * Places: where a session runs.
 *
 * A session's place is derived from its root directory (`groupDir ??
 * workingDir`) whenever session info is serialized, never stored. That way it
 * stays right when the user runs `git init` or adds a remote outside Codekin,
 * and archived or restored sessions need no migration.
 *
 * - `scratch`: the root is inside the scratch root (a throwaway folder Codekin
 *   created for the session).
 * - `repo`: a git work tree with an `origin` remote.
 * - `folder`: anything else; `git` says whether it is a work tree without a
 *   remote (shown as "git folder") or no repository at all.
 *
 * - `org`: a folder directly under the repositories root (the Settings value,
 *   else REPOS_ROOT) that is not itself in a repository — the owner folder
 *   clones land in (`<repos root>/<owner>/<name>`). An org session works
 *   across that owner's repositories.
 *
 * A folder inside a repository (not its root) belongs to that repository:
 * `git` is true and `inRepo` names the repository root. Such sessions run in
 * place; worktrees are only made from a repository root.
 *
 * Scratch folders live under one root (`~/codekin/scratch` by default,
 * overridable with SCRATCH_ROOT or the Settings value). The root must sit
 * inside the home directory or REPOS_ROOT — the same bounds every session
 * working directory is held to.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { randomInt } from 'crypto'
import { REPOS_ROOT } from './config.js'

export type PlaceKind = 'scratch' | 'folder' | 'repo' | 'org'

export interface SessionPlace {
  kind: PlaceKind
  /** The root is in a git work tree: its own, or an enclosing repository's. */
  git: boolean
  /** The enclosing repository's root, when the folder is inside one rather than its root. */
  inRepo?: string
  /** The GitHub owner (org or user), for an org place. */
  owner?: string
  /** Scratch only: the folder holds something besides `.git` (worth keeping). */
  hasFiles?: boolean
  /** Scratch only: the folder's repository has an `origin` remote (published). */
  remote?: boolean
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Roots every session directory must sit inside. */
export function allowedRoots(): string[] {
  return [homedir(), REPOS_ROOT]
}

/** True when `p` equals or descends from one of `roots`. Lexical; resolve symlinks first. */
export function isWithinRoots(p: string, roots: readonly string[] = allowedRoots()): boolean {
  return roots.some(root => p === root || p.startsWith(root + '/'))
}

export function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return p
}

/**
 * Resolve as much of `p` as exists through symlinks and append the rest, so a
 * not-yet-created path is checked against its real ancestors.
 */
function realpathOfExistingPrefix(p: string): string {
  let current = p
  const rest: string[] = []
  for (;;) {
    try {
      return rest.length ? join(realpathSync(current), ...rest.reverse()) : realpathSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return p
      rest.push(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)))
      current = parent
    }
  }
}

// ---------------------------------------------------------------------------
// Scratch root
// ---------------------------------------------------------------------------

/** `~/codekin/scratch`, computed on use so a changed home directory is honoured. */
export function defaultScratchRoot(): string {
  return join(homedir(), 'codekin', 'scratch')
}

/** The Settings value; empty means "use SCRATCH_ROOT or the default". */
let scratchSetting = ''

/** Set the Settings value (at boot and whenever it is saved). */
export function configureScratchRoot(setting: string): void {
  scratchSetting = setting.trim()
}

/**
 * Validate a candidate scratch root. It may not exist yet (it is created on
 * first use), but whatever part exists must resolve inside the allowed roots
 * and must not be a file.
 */
export function validateScratchRoot(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const expanded = expandTilde(raw.trim())
  if (!isAbsolute(expanded)) return { ok: false, error: 'Scratch folder must be an absolute path or start with ~' }
  const real = realpathOfExistingPrefix(resolve(expanded))
  if (!isWithinRoots(real)) {
    return { ok: false, error: 'Scratch folder must be under your home directory or the repositories root' }
  }
  if (existsSync(real) && !statSync(real).isDirectory()) {
    return { ok: false, error: 'Scratch folder path exists and is not a directory' }
  }
  return { ok: true, path: real }
}

/**
 * The scratch root in effect: the Settings value, else SCRATCH_ROOT, else
 * `~/codekin/scratch`. An invalid configured value falls back to the default
 * with a warning rather than failing session creation.
 */
export function getScratchRoot(): string {
  for (const candidate of [scratchSetting, process.env.SCRATCH_ROOT ?? '']) {
    if (!candidate) continue
    const checked = validateScratchRoot(candidate)
    if (checked.ok) return checked.path
    warnOnce(`[places] Ignoring scratch root ${candidate}: ${checked.error}`)
  }
  return realpathOfExistingPrefix(defaultScratchRoot())
}

const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'cosy', 'crisp', 'eager', 'fair', 'fond',
  'gentle', 'glad', 'golden', 'happy', 'keen', 'kind', 'lively', 'lucky', 'mellow', 'merry',
  'misty', 'nimble', 'polite', 'proud', 'quick', 'quiet', 'rapid', 'rosy', 'sharp', 'shiny',
  'silver', 'snowy', 'steady', 'sunny', 'swift', 'tidy', 'warm', 'wise', 'witty', 'zesty',
]
const NOUNS = [
  'badger', 'beacon', 'birch', 'brook', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta',
  'falcon', 'fern', 'finch', 'fjord', 'forest', 'harbor', 'heron', 'island', 'lagoon', 'lark',
  'maple', 'meadow', 'otter', 'owl', 'pebble', 'pine', 'plover', 'quartz', 'raven', 'reef',
  'ridge', 'river', 'robin', 'sparrow', 'spruce', 'summit', 'tern', 'valley', 'willow', 'wren',
]

/** A random `adjective-noun` folder name. Exported for tests. */
export function scratchName(pick: (n: number) => number = randomInt): string {
  return `${ADJECTIVES[pick(ADJECTIVES.length)]}-${NOUNS[pick(NOUNS.length)]}`
}

/**
 * Create a new, empty scratch folder and return its absolute path. Names are
 * retried on collision; after that a numeric suffix guarantees progress.
 */
export function createScratchDir(root: string = getScratchRoot(), pick?: (n: number) => number): string {
  // Check before writing anything: the default root, or one passed in, may
  // resolve outside the allowed roots (e.g. ~/codekin is a symlink).
  const checked = validateScratchRoot(root)
  if (!checked.ok) throw new Error(`${checked.error}. Set a scratch folder in Settings.`)
  mkdirSync(checked.path, { recursive: true })
  // Re-check after creation: a symlink planted along the way must not move the root out of bounds.
  const realRoot = realpathSync(checked.path)
  if (!isWithinRoots(realRoot)) throw new Error('Scratch folder is outside the allowed directories')
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = scratchName(pick)
    const name = attempt < 10 ? base : `${base}-${attempt}`
    const dir = join(realRoot, name)
    try {
      mkdirSync(dir)
      return dir
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not find a free scratch folder name')
}

// ---------------------------------------------------------------------------
// Place detection
// ---------------------------------------------------------------------------

/**
 * The git directory for a work tree root, following a `.git` file
 * (`gitdir: …`, used by worktrees and submodules). Null when not a work tree.
 */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, '.git')
  let st
  try { st = statSync(dotGit) } catch { return null }
  if (st.isDirectory()) return dotGit
  if (!st.isFile()) return null
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'))
    return m ? resolve(root, m[1].trim()) : null
  } catch {
    return null
  }
}

/** True when the repository's config defines an `origin` remote with a URL. */
function hasOriginRemote(gitDir: string): boolean {
  let configDir = gitDir
  try {
    // A linked worktree's config lives in the common dir.
    const common = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim()
    if (common) configDir = resolve(gitDir, common)
  } catch { /* not a linked worktree */ }
  let config: string
  try { config = readFileSync(join(configDir, 'config'), 'utf-8') } catch { return false }
  const section = /^\s*\[remote\s+"origin"\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(config)
  return !!section && /^\s*url\s*=\s*\S/m.test(section[1])
}

/**
 * True when `dir` is a repository root (has a `.git` directory or file). Cheap:
 * one stat. A subfolder of a repository is not one; see {@link findWorkTreeRoot}.
 */
export function isGitWorkTree(dir: string): boolean {
  try {
    statSync(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * The root of the work tree containing `dir`: `dir` itself or its nearest
 * ancestor with a `.git` entry, as git would find it. Null outside any
 * repository.
 */
export function findWorkTreeRoot(dir: string): string | null {
  let current = resolve(dir)
  for (;;) {
    if (gitDirOf(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Repositories root
// ---------------------------------------------------------------------------

/** The Settings value `repos_path`; empty means "use REPOS_ROOT". */
let reposPathSetting = ''

/** Set the repositories-folder Settings value (at boot and whenever it is saved). */
export function configureReposPath(setting: string): void {
  reposPathSetting = setting.trim()
  invalidatePlace()
}

/**
 * The repositories root in effect: the Settings value, else REPOS_ROOT. The
 * same root the repo list and cloning use, so an org folder is where that
 * owner's clones land.
 */
export function getReposRoot(): string {
  return reposPathSetting || REPOS_ROOT
}

// ---------------------------------------------------------------------------
// Org folders
// ---------------------------------------------------------------------------

/** GitHub owner names: letters, digits and single hyphens, up to 39 characters. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner) && !owner.includes('--') && !owner.endsWith('-')
}

/** The owner when `root` is a folder directly under the repositories root (not in a repository); else null. */
function ownerOfOrgFolder(root: string): string | null {
  const reposRoot = realpathOfExistingPrefix(resolve(getReposRoot()))
  const real = realpathOfExistingPrefix(resolve(root))
  if (dirname(real) !== reposRoot) return null
  const owner = real.slice(reposRoot.length + 1)
  return isValidOwner(owner) ? owner : null
}

/**
 * The folder for an org session, `<repos root>/<owner>`, created on first use
 * (with the repositories root itself, on a fresh install). Refuses an invalid
 * owner and an owner folder that is a symlink (it must not lead out of the
 * repos root).
 */
export function ensureOrgFolder(owner: string): string {
  if (!isValidOwner(owner)) throw new Error('Invalid owner name')
  const configured = resolve(getReposRoot())
  mkdirSync(configured, { recursive: true })
  const reposRoot = realpathSync(configured)
  const dir = join(reposRoot, owner)
  let st
  try { st = lstatSync(dir) } catch { st = null }
  if (st?.isSymbolicLink()) throw new Error('The owner folder is a symlink')
  if (st && !st.isDirectory()) throw new Error('The owner folder path exists and is not a directory')
  if (!st) mkdirSync(dir)
  if (findWorkTreeRoot(dir)) throw new Error('The owner folder is inside a git repository')
  return dir
}

/** Uncached place detection. Exported for tests. */
export function detectPlace(root: string, scratchRoot: string = getScratchRoot()): SessionPlace {
  // A scratch folder is a fresh, self-contained place: only its own `.git` counts.
  if (isWithinRoots(root, [scratchRoot])) {
    const place: SessionPlace = { kind: 'scratch', git: isGitWorkTree(root) }
    let entries: string[] = []
    try { entries = readdirSync(root) } catch { /* gone */ }
    if (entries.some(e => e !== '.git')) place.hasFiles = true
    const gitDir = place.git ? gitDirOf(root) : null
    if (gitDir && hasOriginRemote(gitDir)) place.remote = true
    return place
  }
  const repoRoot = findWorkTreeRoot(root)
  const gitDir = repoRoot && gitDirOf(repoRoot)
  if (!repoRoot || !gitDir) {
    const owner = ownerOfOrgFolder(root)
    return owner ? { kind: 'org', git: false, owner } : { kind: 'folder', git: false }
  }
  const place: SessionPlace = { kind: hasOriginRemote(gitDir) ? 'repo' : 'folder', git: true }
  if (repoRoot !== resolve(root)) place.inRepo = repoRoot
  return place
}

const PLACE_TTL_MS = 5_000
const placeCache = new Map<string, { place: SessionPlace; at: number }>()

/**
 * The place for a session root. Cached briefly, because session lists are
 * serialized often and detection touches the filesystem.
 */
export function describePlace(root: string, now: number = Date.now()): SessionPlace {
  const hit = placeCache.get(root)
  if (hit && now - hit.at < PLACE_TTL_MS) return hit.place
  const place = detectPlace(root)
  placeCache.set(root, { place, at: now })
  if (placeCache.size > 500) {
    for (const [key, value] of placeCache) {
      if (now - value.at >= PLACE_TTL_MS) placeCache.delete(key)
    }
  }
  return place
}

/** Drop a cached place, e.g. after `git init` changed it. */
export function invalidatePlace(root?: string): void {
  if (root === undefined) placeCache.clear()
  else placeCache.delete(root)
}
