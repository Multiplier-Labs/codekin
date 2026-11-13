/**
 * Move a scratch session's folder somewhere permanent: the **Move to a
 * folder…** action of the Keep this work? callout (session-start phase 3).
 *
 * The folder keeps its name and moves into a chosen parent inside the
 * allowed roots; the target must not exist. The session is repointed by the
 * caller (SessionManager.moveSessionFolder), between turns only.
 */

import { cpSync, existsSync, realpathSync, renameSync, rmSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import { allowedRoots, expandTilde, getScratchRoot, isWithinRoots } from './places.js'

/** Check where a folder may move; returns the full target path. */
export function validateMoveTarget(rawParent: unknown, source: string): { ok: true; target: string } | { ok: false; error: string } {
  if (typeof rawParent !== 'string' || !rawParent.trim()) return { ok: false, error: 'Choose a folder to move it into' }
  let parent: string
  try {
    parent = realpathSync(resolve(expandTilde(rawParent.trim())))
  } catch {
    return { ok: false, error: 'That folder does not exist' }
  }
  if (!statSync(parent).isDirectory()) return { ok: false, error: 'Not a folder' }
  if (!isWithinRoots(parent, allowedRoots())) {
    return { ok: false, error: 'Choose a folder under your home directory or the repositories root' }
  }
  if (isWithinRoots(parent, [getScratchRoot()])) return { ok: false, error: 'Choose a folder outside the scratch folders' }
  if (parent === source || parent.startsWith(source + '/')) return { ok: false, error: 'A folder cannot move into itself' }
  const target = join(parent, basename(source))
  if (existsSync(target)) return { ok: false, error: `${target} already exists` }
  return { ok: true, target }
}

/** Move a directory; copies then deletes when the target is on another filesystem. */
export function moveDir(source: string, target: string): void {
  try {
    renameSync(source, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(source, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    rmSync(source, { recursive: true, force: true })
  }
}
