/**
 * Places on the client: where a new session will run.
 *
 * A place is picked in the new-session composer before the session exists,
 * so it can describe things that don't exist yet: a scratch folder created on
 * Send, or a GitHub repo cloned on Send. Once a session is running, the
 * server's derived `SessionPlace` (on the session info) is the source of
 * truth; see server/places.ts.
 */

import type { Session, SessionPlace } from '../types'
import type { ApiRepo } from '../hooks/useRepos'
import { getPref, setPref } from './prefs'

/** `org`: every repository of a GitHub owner, from `<repos root>/<owner>`. */
export type DraftPlaceKind = 'scratch' | 'folder' | 'repo' | 'org'

export interface DraftPlace {
  kind: DraftPlaceKind
  /** Absolute path; absent for a scratch folder not yet created, a repo not yet cloned, or an org. */
  path?: string
  /** The place is (or, for a GitHub repo, will be) in a git work tree. */
  git: boolean
  /**
   * The enclosing repository's root, when the folder is inside a repository
   * rather than its root. Such a session runs in place: no worktree.
   */
  inRepo?: string
  /** Short display text: `~/notes`, `acme-co/web-app`, `Scratch folder`. */
  label: string
  /** GitHub coordinates, for repos listed through gh. */
  repo?: { id: string; owner: string; name: string; cloned: boolean; /** Where it is, or will be, checked out. */ dir?: string }
  /** GitHub owner, for an org place. */
  owner?: string
}

/** A fresh scratch folder, created when the session is sent. */
export const NEW_SCRATCH: DraftPlace = Object.freeze({ kind: 'scratch', git: false, label: 'Scratch folder' }) as DraftPlace

/** Max places remembered in the recent list. */
export const MAX_RECENT_PLACES = 8

/** Replace a leading home directory with `~`. */
export function tildify(path: string, home?: string | null): string {
  if (!home) return path
  const h = home.replace(/\/+$/, '')
  if (path === h) return '~'
  if (path.startsWith(h + '/')) return '~' + path.slice(h.length)
  return path
}

/** Expand a leading `~` with the home directory. */
export function untildify(path: string, home?: string | null): string {
  if (!home) return path
  if (path === '~') return home
  if (path.startsWith('~/')) return home.replace(/\/+$/, '') + path.slice(1)
  return path
}

/** Last path segment, for compact labels. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** A place for a repository from the repo list. */
export function placeFromRepo(repo: ApiRepo): DraftPlace {
  return {
    kind: 'repo',
    path: repo.cloned ? repo.workingDir : undefined,
    git: true,
    label: repo.owner ? `${repo.owner}/${repo.name}` : repo.name,
    repo: { id: repo.id, owner: repo.owner, name: repo.name, cloned: repo.cloned, dir: repo.workingDir || undefined },
  }
}

/** A place for a folder picked by path; `repoRoot` is the work tree containing it, if any. */
export function placeFromPath(path: string, git: boolean, home?: string | null, repoRoot?: string | null): DraftPlace {
  const place: DraftPlace = { kind: 'folder', path, git, label: tildify(path, home) }
  if (git && repoRoot && repoRoot !== path) place.inRepo = repoRoot
  return place
}

/** A place for a whole GitHub owner (phase 2). */
export function placeFromOwner(owner: string): DraftPlace {
  return { kind: 'org', git: false, label: owner, owner }
}

/** A place for an existing session's folder, used by the sidebar's group "+". */
export function placeFromSession(session: Pick<Session, 'workingDir' | 'groupDir' | 'place'>, home?: string | null): DraftPlace {
  const place: SessionPlace = session.place ?? { kind: 'folder', git: true }
  if (place.kind === 'scratch') return NEW_SCRATCH
  const path = session.groupDir ?? session.workingDir
  if (place.kind === 'org') {
    const owner = place.owner ?? baseName(path)
    return { kind: 'org', path, git: false, label: owner, owner }
  }
  const draft: DraftPlace = { kind: place.kind, path, git: place.git, label: place.kind === 'repo' ? baseName(path) : tildify(path, home) }
  if (place.inRepo) draft.inRepo = place.inRepo
  return draft
}

/** Identity used to dedupe recent places and to mark the current one. */
export function placeKey(place: DraftPlace): string {
  if (place.kind === 'scratch' && !place.path) return 'scratch:new'
  if (place.kind === 'org') return `org:${place.owner ?? place.label}`
  if (place.path) return `path:${place.path}`
  if (place.repo) return `repo:${place.repo.owner}/${place.repo.name}`
  return `${place.kind}:${place.label}`
}

/** Two places are the same place. A cloned repo matches its own path entry. */
export function samePlace(a: DraftPlace, b: DraftPlace): boolean {
  if (placeKey(a) === placeKey(b)) return true
  return !!a.repo && !!b.repo && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name
}

/**
 * The place a new session defaults to: the last one used, or a fresh
 * scratch folder when there is no history. A specific scratch folder is
 * never reused as the default — "last used: scratch" means a new one.
 */
export function defaultPlace(history: readonly DraftPlace[] | undefined): DraftPlace {
  const last = history?.[0]
  if (!last) return NEW_SCRATCH
  if (last.kind === 'scratch') return NEW_SCRATCH
  return last
}

/** Put `place` first in `history`, deduped and capped. Pure. */
export function withRecentPlace(history: readonly DraftPlace[] | undefined, place: DraftPlace): DraftPlace[] {
  // A created scratch folder is remembered as "a new scratch folder".
  const entry: DraftPlace = place.kind === 'scratch' ? NEW_SCRATCH : place
  const rest = (history ?? []).filter(p => !samePlace(p, entry))
  return [entry, ...rest].slice(0, MAX_RECENT_PLACES)
}

/** Recent places, newest first (server-side prefs). */
export function getRecentPlaces(): DraftPlace[] {
  const stored = getPref('recentPlaces')
  return Array.isArray(stored) ? stored.filter(isDraftPlace) : []
}

/** Record that a session was started in `place`. */
export function rememberPlace(place: DraftPlace): void {
  setPref('recentPlaces', withRecentPlace(getRecentPlaces(), place))
}

function isDraftPlace(v: unknown): v is DraftPlace {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<DraftPlace>
  return (p.kind === 'scratch' || p.kind === 'folder' || p.kind === 'repo' || p.kind === 'org')
    && typeof p.label === 'string' && typeof p.git === 'boolean'
}

/**
 * The hint line under the composer, saying where the session will run.
 * `scratchRoot` is shown for a new scratch folder when known.
 */
export function placeHint(place: DraftPlace, useWorktree: boolean, opts: { home?: string | null; scratchRoot?: string | null } = {}): string {
  const { home, scratchRoot } = opts
  switch (place.kind) {
    case 'scratch': {
      const where = scratchRoot ? `${tildify(scratchRoot, home)}/…` : 'a new scratch folder'
      return `Creates ${where} when you send. Git is optional: connect a repo later or never.`
    }
    case 'org': {
      const where = place.path ? tildify(place.path, home) : `the repositories folder's ${place.owner ?? place.label}/`
      const edits = useWorktree ? 'each repo it changes gets its own worktree' : 'it edits the clones in place'
      return `Works across ${place.owner ?? place.label} from ${where}. The agent clones repos as it needs them (you approve each), and ${edits}.`
    }
    case 'repo':
      if (!place.path && place.repo) {
        return `Clones ${place.repo.owner}/${place.repo.name} into the repositories folder when you send.`
      }
      return runsIn(place, useWorktree, home)
    case 'folder':
      if (!place.git) return `Runs in ${tildify(place.path ?? place.label, home)}. Not a git repo, so there are no worktrees.`
      return runsIn(place, useWorktree, home)
  }
}

function runsIn(place: DraftPlace, useWorktree: boolean, home?: string | null): string {
  const where = tildify(place.path ?? place.label, home)
  if (place.inRepo) {
    return `Runs in ${where}, inside ${tildify(place.inRepo, home)}, on the checked-out branch (no worktree in a subfolder).`
  }
  return useWorktree ? `Runs in ${where}, on a fresh worktree.` : `Runs in ${where}, on the checked-out branch.`
}

/**
 * True when a running session's folder has no git to review and could be
 * made a repository. An org folder holds repositories but is never one itself.
 */
export function isNotRepoPlace(place: SessionPlace | undefined): boolean {
  return !!place && !place.git && place.kind !== 'org'
}

/** Tag shown next to a place in lists and sidebar group headers. */
export function placeTag(kind: DraftPlaceKind | SessionPlace['kind'], git: boolean): string {
  switch (kind) {
    case 'scratch': return 'scratch'
    case 'repo': return 'repo'
    case 'org': return 'org'
    case 'folder': return git ? 'git folder' : 'folder'
  }
}
