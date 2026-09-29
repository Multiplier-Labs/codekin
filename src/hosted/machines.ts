/**
 * The paired machines a hosted user can work on: the type, the fetch, and the
 * memory of which one they were last on.
 *
 * Split out of MachinesPage because the same list is now shown in two places —
 * the first-run picker and the Machines section of Settings — and the reload
 * path needs the fetch without either of them.
 */

import { workspaceHeaders } from './workspace'
import { saveUserPrefs, userPref } from './userPrefs'

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
  /**
   * Created by an install command that has not been run yet. Such a machine
   * has never connected; the UI shows it as "waiting for installation", not
   * as an ordinary offline machine.
   */
  setupPending?: boolean
  /** When the pending install command stops working (epoch ms); null otherwise. */
  pairingExpiresAt?: number | null
}

/** A machine that has finished setup — something you could actually open. */
export function isUsableMachine(machine: Machine): boolean {
  return !machine.setupPending
}

/**
 * Machine the user was last connected to, so a reload — on this device or
 * another — returns them to it. Kept on the relay (see ./userPrefs).
 */
export function rememberMachine(id: string): void {
  void saveUserPrefs({ machineId: id })
}

/** Forget the connection — a reload then lands on the picker, as before. */
export function forgetMachine(): Promise<void> {
  return saveUserPrefs({ machineId: null })
}

export function lastMachineId(): string | null {
  return userPref('machineId')
}

/**
 * The relay's own API, not the machine's — this is a same-origin call to
 * app.codekin.ai, so it never goes through the transport.
 */
export async function fetchMachines(): Promise<Machine[]> {
  const res = await fetch('/api/machines', { credentials: 'include', headers: workspaceHeaders() })
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

/** A failed relay call, carrying the HTTP status and the relay's error code. */
export class RelayRequestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, code: string | null) {
    super(code ?? String(status))
    this.status = status
    this.code = code
  }
}

async function relayError(res: Response): Promise<RelayRequestError> {
  let code: string | null = null
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string') code = body.error
  } catch {
    // Not JSON — the status alone has to do.
  }
  return new RelayRequestError(res.status, code)
}

/** A freshly minted install command's secret half. Never persisted. */
export interface Pairing {
  pairingToken: string
  machineId: string
  expiresAt: number
}

/**
 * Mint a pre-approved pairing token for the install-command funnel. The
 * token goes into the one-line installer or `codekin relay login`, both via
 * the CODEKIN_PAIR_TOKEN environment variable; the machine that runs it becomes
 * paired to this account with no further approval. Single-use, 10-minute TTL.
 *
 * `replaceMachineId` regenerates: the relay discards that still-unclaimed
 * machine and its token first, so regenerating never piles up pending rows.
 * The token cannot be fetched again later — callers keep it in component
 * memory only (never storage or the URL).
 */
export async function precreatePairing(opts: { replaceMachineId?: string } = {}): Promise<Pairing> {
  const res = await fetch('/api/machines/pair/precreate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify(opts.replaceMachineId ? { replaceMachineId: opts.replaceMachineId } : {}),
  })
  if (!res.ok) throw await relayError(res)
  return (await res.json()) as Pairing
}

/** Remove a machine (owner only). This also revokes its connector's credential. */
export async function removeMachine(machineId: string): Promise<void> {
  const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw await relayError(res)
}

/** User-facing text for a failed install-command generation. */
export function pairingErrorMessage(err: unknown): string {
  if (err instanceof RelayRequestError) {
    if (err.status === 429) return 'Too many install commands in a short time. Wait a minute, then try again.'
    if (err.status === 401) return 'Your session has ended. Reload the page and sign in again.'
    if (err.code === 'machine_already_paired') return 'That computer has already been paired, so its command cannot be replaced.'
    if (err.code === 'machine_not_found') return 'That setup no longer exists. Generate a new install command.'
  }
  return 'Could not generate an install command. Try again.'
}

/** "9 min" while there is time, whole seconds in the last minute. */
export function formatTimeLeft(ms: number): string {
  if (ms > 60_000) return `${Math.ceil(ms / 60_000)} min`
  return `${Math.max(0, Math.ceil(ms / 1000))} s`
}

/** The relay the installer and CLI use when no URL is given. */
export const DEFAULT_RELAY_URL = 'https://app.codekin.ai'

/**
 * The two copy-paste commands for a pairing token. The token travels as an
 * environment variable (CODEKIN_PAIR_TOKEN) rather than an argument so it is
 * not visible in the process list while the installer runs, and the script is
 * fetched over https so nothing can be injected before a redirect.
 */
export function installCommands(token: string, origin: string): { install: string; login: string } {
  const custom = origin.replace(/\/$/, '') !== DEFAULT_RELAY_URL
  return {
    install: `curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=${token} bash${custom ? ` -s -- --relay ${origin}` : ''}`,
    login: `CODEKIN_PAIR_TOKEN=${token} codekin relay login${custom ? ` --url ${origin}` : ''}`,
  }
}
