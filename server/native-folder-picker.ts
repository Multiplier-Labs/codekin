/**
 * Native macOS folder dialog for the Repositories path setting.
 *
 * A browser cannot hand back an absolute path, so the server — which runs on
 * the Mac — opens the standard "Choose Folder" dialog via osascript. That is
 * only correct when the browser sits on the same machine: a phone, a LAN
 * client, a reverse proxy or the hosted relay must never pop a dialog up on
 * the Mac. Those callers get `available: false` and fall back to the in-page
 * directory browser.
 */

import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Minimal view of an Express request — enough to decide locality. */
export interface LocalityRequest {
  socket: { remoteAddress?: string }
  headers: Record<string, string | string[] | undefined>
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Whether this request may open a native dialog: macOS server, loopback
 * caller, and no proxy in between (a local nginx fronting remote clients adds
 * X-Forwarded-For).
 */
export function isNativeFolderPickerAvailable(req: LocalityRequest, platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false
  const addr = req.socket.remoteAddress
  if (!addr || !LOOPBACK.has(addr)) return false
  if (req.headers['x-forwarded-for'] !== undefined) return false
  return true
}

/**
 * The AppleScript run by osascript. The default location arrives as argv, so
 * no user-supplied text is ever spliced into the script. Plain `activate`
 * brings osascript itself to the front — no Apple Events to another app, so
 * no Automation permission prompt.
 */
const SCRIPT = [
  'on run argv',
  '  activate',
  '  set p to choose folder with prompt "Choose your repositories folder" default location (POSIX file (item 1 of argv))',
  '  return POSIX path of p',
  'end run',
]

/** The dialog waits on the user; give them ample time before giving up. */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
) => unknown

let inFlight = false

/** Whether a dialog is currently open. */
export function isFolderDialogOpen(): boolean {
  return inFlight
}

/** Resolve the dialog's starting folder: the given path if it exists, else home. */
export function resolveDefaultLocation(defaultPath: string | undefined): string {
  const home = homedir()
  if (!defaultPath) return home
  const expanded = defaultPath === '~' || defaultPath.startsWith('~/') ? join(home, defaultPath.slice(1)) : defaultPath
  try {
    if (expanded.startsWith('/') && existsSync(expanded) && statSync(expanded).isDirectory()) return expanded
  } catch { /* fall through */ }
  return home
}

/**
 * Open the native folder dialog and resolve with the chosen absolute path,
 * or null if the user cancelled. Rejects on any other failure.
 */
export function pickFolderNative(defaultPath: string | undefined, execImpl: ExecFileFn = execFile as unknown as ExecFileFn): Promise<string | null> {
  const location = resolveDefaultLocation(defaultPath)
  const args = [...SCRIPT.flatMap(line => ['-e', line]), location]
  inFlight = true
  return new Promise<string | null>((resolve, reject) => {
    execImpl('osascript', args, { timeout: DIALOG_TIMEOUT_MS }, (error, stdout, stderr) => {
      inFlight = false
      if (error) {
        if (/-128|User cancel+ed/i.test(stderr)) resolve(null)
        else reject(new Error(stderr.trim() || error.message))
        return
      }
      const picked = stdout.trim().replace(/(.)\/+$/, '$1')
      resolve(picked || null)
    })
  })
}
