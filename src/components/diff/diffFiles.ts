/**
 * Path helpers for the Changes panel's file list and diff bar: splitting a
 * path into folder and name, rename display, and the folder grouping order.
 */

import type { DiffFile } from '../../types'

/** Split a path into its folder (with trailing slash, '' at the root) and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/** File name shown in lists: "old → new" for renames. */
export function displayName(file: DiffFile): string {
  const { name } = splitPath(file.path)
  if (file.status === 'renamed' && file.oldPath) return `${splitPath(file.oldPath).name} → ${name}`
  return name
}

/** Full path shown in tooltips: "old → new" for renames. */
export function displayPath(file: DiffFile): string {
  return file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
}

/** Files sorted by folder; within a folder the server's order is kept (sort is stable). */
export function groupOrder(files: DiffFile[]): DiffFile[] {
  return [...files].sort((a, b) => {
    const da = splitPath(a.path).dir
    const db = splitPath(b.path).dir
    return da < db ? -1 : da > db ? 1 : 0
  })
}
