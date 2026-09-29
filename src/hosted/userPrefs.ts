/**
 * Where the hosted app resumes for this user: the workspace a new tab opens
 * in and the machine a reload reconnects to.
 *
 * Stored on the relay per user (PUT /api/me/preferences, returned by
 * /api/me), not in localStorage, so it follows the user across browsers and
 * devices. `seedUserPrefs` is called with each /api/me response; the getters
 * read the in-memory copy synchronously.
 *
 * Browsers that remembered these in localStorage (before this moved to the
 * relay) have them uploaded once and the old keys removed.
 */

export interface UserPrefs {
  workspaceId: string | null
  machineId: string | null
}

const LEGACY_WORKSPACE_KEY = 'codekin.hosted.workspaceId'
const LEGACY_MACHINE_KEY = 'codekin.hosted.lastMachineId'

let prefs: UserPrefs = { workspaceId: null, machineId: null }

export function userPref<K extends keyof UserPrefs>(key: K): UserPrefs[K] {
  return prefs[key]
}

/**
 * Update the local copy immediately and save it to the relay. Resolves once
 * the relay has it (callers about to reload wait for that); never rejects —
 * a failed save only means the next device starts from the previous value.
 */
export async function saveUserPrefs(patch: Partial<UserPrefs>): Promise<void> {
  const changed = (Object.keys(patch) as Array<keyof UserPrefs>).some(k => patch[k] !== prefs[k])
  if (!changed) return
  prefs = { ...prefs, ...patch }
  await putUserPrefs(patch)
}

/** Send a patch to the relay. Null when the request never got an answer. */
async function putUserPrefs(patch: Partial<UserPrefs>): Promise<Response | null> {
  try {
    return await fetch('/api/me/preferences', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    return null
  }
}

function readLegacy(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/**
 * Take the relay's copy from /api/me (null before full sign-in). Fills any
 * gap from legacy localStorage once, then removes the legacy keys.
 */
export function seedUserPrefs(fromRelay: Partial<UserPrefs> | null | undefined): void {
  if (!fromRelay) return
  prefs = { workspaceId: fromRelay.workspaceId ?? null, machineId: fromRelay.machineId ?? null }

  const legacyWorkspace = readLegacy(LEGACY_WORKSPACE_KEY)
  const legacyMachine = readLegacy(LEGACY_MACHINE_KEY)
  if (legacyWorkspace === null && legacyMachine === null) return
  const patch: Partial<UserPrefs> = {}
  if (!prefs.workspaceId && legacyWorkspace) patch.workspaceId = legacyWorkspace
  if (!prefs.machineId && legacyMachine) patch.machineId = legacyMachine
  prefs = { ...prefs, ...patch }
  const clear = () => {
    try {
      localStorage.removeItem(LEGACY_WORKSPACE_KEY)
      localStorage.removeItem(LEGACY_MACHINE_KEY)
    } catch { /* storage disabled */ }
  }
  if (Object.keys(patch).length === 0) {
    clear()
    return
  }
  // A stale workspace id is refused by the relay (400); either way the
  // legacy copy has been dealt with. Only a network failure keeps it for
  // the next load.
  void putUserPrefs(patch).then(res => { if (res) clear() })
}

/** For tests: forget everything. */
export function resetUserPrefsForTests(initial: Partial<UserPrefs> = {}): void {
  prefs = { workspaceId: null, machineId: null, ...initial }
}
