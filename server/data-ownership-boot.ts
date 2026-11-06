/**
 * Takes exclusive ownership of the state directories at server boot.
 *
 * Imported **first** by ws-server.ts, so ES module evaluation runs it before
 * any module that opens state, and before SessionManager, SQLite stores,
 * migrations or session restore. On a conflict the server exits 1 without
 * touching application state.
 *
 * Two roots, because `DATA_DIR` only relocates part of the state: the session
 * archive, run database and several config files always live in
 * `~/.codekin`. Two servers with different `DATA_DIR`s still share those, so
 * both directories are locked (once, if they're the same).
 */

import { homedir } from 'os'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import { acquireDataOwnership, DataDirInUseError, DataDirNewerError, type OwnershipHandle } from './data-ownership.js'
import { codekinPackageVersion } from './relay/relay-credential.js'
import { serverLifecycle } from './server-lifecycle.js'

/** Every directory a running server writes state to. */
export const STATE_DIRS = [DATA_DIR, join(homedir(), '.codekin')]

function acquire(): OwnershipHandle {
  const version = codekinPackageVersion()
  try {
    const handle = acquireDataOwnership(STATE_DIRS, version)
    console.log(`[ownership] Owning ${handle.dirs.join(', ')} (Codekin ${version})`)
    return handle
  } catch (err) {
    if (err instanceof DataDirInUseError || err instanceof DataDirNewerError) {
      console.error(`[ownership] ${err.message}`)
      if (err instanceof DataDirInUseError) {
        console.error('[ownership] Stop the other server (codekin stop, or quit the desktop app) or attach to it instead.')
      }
      serverLifecycle.emit('ownership_error', err)
      process.exit(1)
    }
    throw err
  }
}

/** Held for the process lifetime; the reference keeps the lock connections open. */
export const dataOwnership: OwnershipHandle = acquire()
