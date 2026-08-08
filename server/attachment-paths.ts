/**
 * Containment checks for `[Attached files: …]` paths.
 *
 * The attachment prefix is a plain-text protocol: the frontend uploads files
 * via /api/upload and prepends the returned paths to the message. Nothing stops
 * a client from hand-writing the same prefix with an arbitrary path, so the
 * server must not read whatever it is handed — that would let any caller pull
 * local files (SSH keys, env files, auth tokens) into the provider transcript,
 * bypassing the tool-approval flow that normally gates file reads.
 *
 * Uploads always land directly in SCREENSHOTS_DIR, so legitimate attachments
 * resolve to a child of that directory. Everything else is rejected.
 */

import { realpathSync } from 'fs'
import { resolve, sep } from 'path'
import { SCREENSHOTS_DIR } from './config.js'

/**
 * Resolve an attachment path and confirm it lives inside SCREENSHOTS_DIR.
 *
 * Both the candidate and the upload directory are passed through realpath so
 * symlinks planted inside the upload directory cannot escape it, and so the
 * comparison is not defeated by a symlinked directory on either side (e.g.
 * /tmp -> /private/tmp on macOS).
 *
 * Returns the resolved real path, or null if the path does not exist or falls
 * outside the upload directory.
 */
export function resolveAttachmentPath(filePath: string): string | null {
  let realRoot: string
  try {
    realRoot = realpathSync(SCREENSHOTS_DIR)
  } catch {
    // Upload directory does not exist yet — nothing can legitimately be inside it.
    return null
  }

  let real: string
  try {
    real = realpathSync(resolve(filePath))
  } catch {
    // Missing file, broken symlink, or an unreadable parent directory.
    return null
  }

  // Require a strict descendant: the root itself is a directory, not an
  // attachment, and the separator guard stops "<root>-evil" from matching.
  if (!real.startsWith(realRoot + sep)) return null

  return real
}
