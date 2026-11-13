/**
 * Attached places: folders a running session can also work in.
 *
 * A session keeps its primary place (`groupDir ?? workingDir`) for life; the
 * sidebar group, "always allow" rules, CLAUDE_PROJECT_DIR and worktrees all
 * stay keyed by it. Attaching adds folders beside it, stored on the session
 * as `addDirs` (realpaths) and persisted:
 *
 * - Claude and Codex are told at spawn (`--add-dir`, Codex's writable roots),
 *   so attaching restarts them between turns, keeping the conversation.
 * - Grok and OpenCode have no such flag: access outside the working
 *   directory goes through their normal approval prompt.
 * - Every harness gets a note prefixed to the next message saying what was
 *   attached or detached and where, the same channel the org manifest uses.
 *
 * The server only ever attaches directories. A repository not cloned yet, or
 * an org, is resolved to its folder by the client first (clone, org folder).
 */

import { realpathSync, statSync } from 'fs'
import { resolve } from 'path'
import { describePlace, isWithinRoots, allowedRoots, type SessionPlace } from './places.js'
import { buildOrgManifest } from './org-manifest.js'

/** Most folders one session may have attached. */
export const MAX_ATTACHED = 10

/** True when `a` and `b` are the same folder or one contains the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

/**
 * Check a folder to attach and return its realpath, or why it is refused.
 * `roots` are the session's own folders (primary root, working directory);
 * `attached` are the folders attached already.
 */
export function validateAttachPath(
  raw: unknown, roots: readonly string[], attached: readonly string[],
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'path must be a non-empty string' }
  let real: string
  try {
    real = realpathSync(resolve(raw.trim()))
  } catch {
    return { ok: false, error: 'Folder does not exist or is inaccessible' }
  }
  if (!statSync(real).isDirectory()) return { ok: false, error: 'Not a folder' }
  if (!isWithinRoots(real, allowedRoots())) {
    return { ok: false, error: 'Folder must be under your home directory or the repositories root' }
  }
  for (const root of roots) {
    let realRoot = root
    try { realRoot = realpathSync(root) } catch { /* gone: compare as stored */ }
    if (overlaps(real, realRoot)) return { ok: false, error: 'The session already works in this folder' }
  }
  if (attached.some(a => overlaps(real, a))) return { ok: false, error: 'This folder, or one around or inside it, is already attached' }
  if (attached.length >= MAX_ATTACHED) return { ok: false, error: `At most ${MAX_ATTACHED} folders can be attached` }
  return { ok: true, path: real }
}

function kindLabel(place: SessionPlace): string {
  if (place.kind === 'org') return `the folder of GitHub owner "${place.owner}"`
  if (place.kind === 'repo') return 'a git repository'
  if (place.git) return 'a git folder'
  return 'a folder (not a git repository)'
}

export interface PlaceNoteInput {
  action: 'attached' | 'detached'
  path: string
  sessionId: string
  /** Worktree preference and branch prefix, for an attached org's manifest. */
  worktrees: boolean
  branchPrefix: string
}

/** The note the agent reads before the next message after an attach or detach. */
export function buildPlaceNote(input: PlaceNoteInput): string {
  const { action, path, sessionId, worktrees, branchPrefix } = input
  if (action === 'detached') {
    return [
      '<codekin-place-detached>',
      `The user detached ${path} from this session. Don't read or change anything there from now on.`,
      '</codekin-place-detached>',
    ].join('\n')
  }
  const place = describePlace(path)
  const lines = [
    '<codekin-place-attached>',
    `The user attached ${path} (${kindLabel(place)}) to this session. You may read and work there as well as in your working directory; use absolute paths for it.`,
  ]
  if (place.kind === 'org' && place.owner) {
    lines.push(buildOrgManifest({ owner: place.owner, dir: path, sessionId, worktrees, branchPrefix }))
  }
  lines.push('</codekin-place-attached>')
  return lines.join('\n')
}

/** Attached folders as the session list shows them. */
export function describeAttached(dirs: readonly string[] | undefined): Array<{ path: string; place: SessionPlace }> | undefined {
  if (!dirs?.length) return undefined
  return dirs.map(path => ({ path, place: describePlace(path) }))
}
