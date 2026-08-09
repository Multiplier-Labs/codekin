/**
 * The paired machines a hosted user can work on: the type, the fetch, and the
 * memory of which one they were last on.
 *
 * Split out of MachinesPage because the same list is now shown in two places —
 * the first-run picker and the Machines section of Settings — and the reload
 * path needs the fetch without either of them.
 */

export interface Machine {
  id: string
  displayName: string
  hostname: string | null
  platform: string | null
  connectorVersion: string | null
  localCodekinVersion: string | null
  status: 'online' | 'offline' | 'degraded'
  lastSeenAt: string | null
  /** 'shared' when reachable only through a session share. */
  access?: 'owner' | 'shared'
  /** True when the machine's connector is behind the supported version. */
  connectorOutdated?: boolean
}

/** Machine the user was last connected to, so a reload returns them to it. */
export const LAST_MACHINE_KEY = 'codekin.hosted.lastMachineId'

export function rememberMachine(id: string): void {
  localStorage.setItem(LAST_MACHINE_KEY, id)
}

/** Forget the connection — a reload then lands on the picker, as before. */
export function forgetMachine(): void {
  localStorage.removeItem(LAST_MACHINE_KEY)
}

export function lastMachineId(): string | null {
  return localStorage.getItem(LAST_MACHINE_KEY)
}

/**
 * The relay's own API, not the machine's — this is a same-origin call to
 * app.codekin.ai, so it never goes through the transport.
 */
export async function fetchMachines(): Promise<Machine[]> {
  const res = await fetch('/api/machines', { credentials: 'include' })
  if (!res.ok) throw new Error(String(res.status))
  const data = (await res.json()) as { machines: Machine[] }
  return data.machines
}

/**
 * What to do with a remembered machine id once the list comes back.
 *
 * - `connect` — it is there and reachable; go straight to the workspace
 * - `forget`  — it is gone from the account; stop remembering it
 * - `wait`    — it exists but is offline. Dialling it would land the reload on
 *               a connect error, so show the picker without forgetting: the
 *               machine is still where the user left off, it is just down.
 */
export type RestoreDecision =
  | { action: 'connect'; machine: Machine }
  | { action: 'forget' }
  | { action: 'wait' }

export function decideRestore(machines: Machine[], rememberedId: string | null): RestoreDecision {
  if (!rememberedId) return { action: 'forget' }
  const machine = machines.find(m => m.id === rememberedId)
  if (!machine) return { action: 'forget' }
  if (machine.status === 'offline') return { action: 'wait' }
  return { action: 'connect', machine }
}

/** Status dot colour, shared by the picker and the settings section. */
export const MACHINE_STATUS_DOT: Record<Machine['status'], string> = {
  online: 'bg-success-7',
  degraded: 'bg-warning-6',
  offline: 'bg-ink-faint',
}
