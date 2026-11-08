/**
 * Quotas (docs/RELAY-HARDENING.md §6).
 *
 * A mechanism with no built-in limits: a relay without a quotas file is
 * unlimited, as before. Limits come from an EntitlementsProvider; the
 * default one reads RELAY_QUOTAS_FILE (JSON) once at boot:
 *
 *   {
 *     "default":    { "machinesPerWorkspace": 25, "channelsPerUser": 16 },
 *     "workspaces": { "<workspace-id>": { "machinesPerWorkspace": 100, "channelsPerUser": null } }
 *   }
 *
 * A key that is absent is unlimited. Workspace entries override `default`
 * key by key, and `null` there lifts that default for the workspace. A deployment that sells plans can supply its own provider
 * that maps workspaces to plan entitlements.
 */

import { readFileSync } from 'fs'
import type Database from 'better-sqlite3'

export const QUOTA_KEYS = [
  /** Machines registered in a workspace, including ones still being set up. */
  'machinesPerWorkspace',
  /** Approved pairings a user hasn't claimed on a machine yet, per workspace. */
  'pendingPairingsPerUser',
  /** Open browser connections per user, across all machines. */
  'browserSocketsPerUser',
  /** Open session streams per user, across all machines. */
  'channelsPerUser',
  /** Invitations created in a workspace in the last 24 hours. */
  'invitationsPerWorkspacePerDay',
  /** People one session can be shared with. */
  'sharesPerSession',
  /**
   * Bytes relayed for a workspace per UTC day, both directions. Over it,
   * traffic slows to throttledBytesPerSecond per connection; it is never cut off.
   */
  'relayedBytesPerWorkspacePerDay',
  /** The slowed rate once relayedBytesPerWorkspacePerDay is used up (default 64 KiB/s). */
  'throttledBytesPerSecond',
] as const

export type QuotaKey = (typeof QUOTA_KEYS)[number]
export type QuotaLimits = Partial<Record<QuotaKey, number>>

export interface EntitlementsProvider {
  /** Limits that apply in a workspace. Missing keys are unlimited. */
  limitsFor(workspaceId: string): QuotaLimits
}

export const UNLIMITED: EntitlementsProvider = { limitsFor: () => ({}) }

export interface QuotaExceeded {
  error: 'quota_exceeded'
  quota: QuotaKey
  limit: number
  message: string
}

const MESSAGES: Record<Exclude<QuotaKey, 'relayedBytesPerWorkspacePerDay' | 'throttledBytesPerSecond'>, (limit: number) => string> = {
  machinesPerWorkspace: n => `This workspace has reached its limit of ${n} machine${n === 1 ? '' : 's'}.`,
  pendingPairingsPerUser: n => `You have ${n} machine setup${n === 1 ? '' : 's'} waiting to be finished. Finish or cancel one first.`,
  browserSocketsPerUser: n => `You have ${n} connection${n === 1 ? '' : 's'} open already. Close a tab or window and try again.`,
  channelsPerUser: n => `You have ${n} session${n === 1 ? '' : 's'} open already. Close one and try again.`,
  invitationsPerWorkspacePerDay: n => `This workspace has sent ${n} invitation${n === 1 ? '' : 's'} today. Try again tomorrow.`,
  sharesPerSession: n => `This session is already shared with ${n} ${n === 1 ? 'person' : 'people'}.`,
}

/**
 * The refusal body when `current` has reached the workspace's limit for
 * `quota`, or null when there is room (or no limit).
 */
export function checkQuota(
  entitlements: EntitlementsProvider,
  workspaceId: string,
  quota: keyof typeof MESSAGES,
  current: () => number,
): QuotaExceeded | null {
  const limit = entitlements.limitsFor(workspaceId)[quota]
  if (limit === undefined) return null
  if (current() < limit) return null
  return { error: 'quota_exceeded', quota, limit, message: MESSAGES[quota](limit) }
}

/** Limits by key; `null` (allowed only where `allowNull`) marks a default lifted. */
function parseLimits(value: unknown, where: string, allowNull = false): Partial<Record<QuotaKey, number | null>> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`)
  const limits: Partial<Record<QuotaKey, number | null>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!(QUOTA_KEYS as readonly string[]).includes(key)) throw new Error(`${where}: unknown quota "${key}"`)
    if (raw === null && allowNull) {
      limits[key as QuotaKey] = null
      continue
    }
    if (!Number.isInteger(raw) || (raw as number) < 0) {
      throw new Error(`${where}.${key} must be a non-negative integer${allowNull ? ' or null' : ''}`)
    }
    limits[key as QuotaKey] = raw as number
  }
  return limits
}

/** Build a provider from quotas-file JSON. Throws on anything malformed, so a typo fails at boot. */
export function parseQuotas(json: unknown): EntitlementsProvider {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('quotas file must hold a JSON object')
  const root = json as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (key !== 'default' && key !== 'workspaces') throw new Error(`quotas file: unknown key "${key}"`)
  }
  const defaults = parseLimits(root.default, 'default') as QuotaLimits
  const overrides = new Map<string, Partial<Record<QuotaKey, number | null>>>()
  if (root.workspaces !== undefined) {
    if (!root.workspaces || typeof root.workspaces !== 'object' || Array.isArray(root.workspaces)) {
      throw new Error('workspaces must be an object')
    }
    for (const [id, limits] of Object.entries(root.workspaces)) {
      overrides.set(id, parseLimits(limits, `workspaces.${id}`, true))
    }
  }
  return {
    limitsFor: workspaceId => {
      const override = overrides.get(workspaceId) ?? {}
      const merged: QuotaLimits = {}
      for (const key of QUOTA_KEYS) {
        const limit = key in override ? override[key] : defaults[key]
        if (typeof limit === 'number') merged[key] = limit
      }
      return merged
    },
  }
}

/** The provider for RELAY_QUOTAS_FILE, or UNLIMITED when no file is configured. */
export function loadEntitlements(path: string | undefined): EntitlementsProvider {
  if (!path) return UNLIMITED
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`RELAY_QUOTAS_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  try {
    return parseQuotas(json)
  } catch (err) {
    throw new Error(`RELAY_QUOTAS_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

// ── Usage counts ─────────────────────────────────────────────────────────

export function countWorkspaceMachines(db: Database.Database, workspaceId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM machines WHERE workspace_id = ?').get(workspaceId) as { n: number }).n
}

/** Approved, unexpired pairings by this user in this workspace that no machine has claimed yet. */
export function countPendingPairings(db: Database.Database, userId: string, workspaceId: string, now = Date.now()): number {
  return (db.prepare(
    `SELECT count(*) AS n FROM pairing_requests p JOIN machines m ON m.id = p.machine_id
     WHERE p.approved_by_user_id = ? AND m.workspace_id = ? AND p.status = 'approved' AND p.expires_at > ?`,
  ).get(userId, workspaceId, now) as { n: number }).n
}

export function countInvitationsToday(db: Database.Database, workspaceId: string): number {
  return (db.prepare(
    `SELECT count(*) AS n FROM workspace_invitations
     WHERE workspace_id = ? AND created_at > datetime('now', '-1 day')`,
  ).get(workspaceId) as { n: number }).n
}

/** People other than `exceptGranteeId` this session is shared with right now. */
export function countSessionShares(
  db: Database.Database,
  machineId: string,
  localSessionId: string,
  exceptGranteeId: string,
  now = new Date(),
): number {
  const rows = db.prepare(
    `SELECT expires_at FROM session_shares
     WHERE machine_id = ? AND local_session_id = ? AND grantee_user_id IS NOT NULL AND grantee_user_id != ?`,
  ).all(machineId, localSessionId, exceptGranteeId) as Array<{ expires_at: string | null }>
  return rows.filter(r => r.expires_at === null || new Date(r.expires_at) > now).length
}
