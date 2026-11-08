/**
 * Abuse signals (docs/RELAY-HARDENING.md §6).
 *
 * The connector protocol is open, so anyone can pair a "machine" that is
 * really a custom program and use the relay as a generic pipe. The relay
 * can't tell a real connector from a fake one, but it can see traffic shape.
 * The hub keeps a per-machine traffic window and, every window, hands a
 * summary to an AbuseSignals policy, which may answer with findings:
 *
 *   flag      the machine goes into the operator's review queue
 *   throttle  flag, and slow the workspace's relayed traffic until resolved
 *
 * Stopping a machine (disabling its owner) stays an operator decision.
 * The relay ships the mechanism; thresholds live in a policy file
 * (RELAY_ABUSE_POLICY_FILE). Without one, nothing is evaluated.
 */

import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { recordAuditEvent } from './audit.js'

export interface MachineTrafficSummary {
  machineId: string
  workspaceId: string | null
  connectorVersion: string | null
  windowSeconds: number
  /** Frames and bytes in both directions through the hub. */
  frames: number
  bytes: number
  /** stream_data frames from the machine, and how many weren't a JSON object with a string `type`. */
  streamFrames: number
  malformedStreamFrames: number
  /** Frames at or above the policy's large-frame size. */
  largeFrames: number
  /** Sessions the connector last advertised (null if it never said). */
  sessionsAdvertised: number | null
}

export type AbuseAction = 'flag' | 'throttle'

export interface AbuseFinding {
  /** Stable name of the rule, e.g. `malformedStreamFrames`. One open flag per machine and signal. */
  signal: string
  action: AbuseAction
  /** Numbers that made the rule fire, for the reviewer. Never payloads. */
  detail: Record<string, number | string | null>
}

export interface AbuseSignals {
  /** Frames at or above this size count as large (0: don't count). */
  readonly largeFrameBytes: number
  /** Whether stream_data payloads need the (cheap) shape check. */
  readonly inspectStreamFrames: boolean
  readonly windowMs: number
  evaluate(summary: MachineTrafficSummary): AbuseFinding[]
  /** Release policy state after a machine has remained inactive for a full window. */
  forget?(machineId: string): void
}

// ── Rule-based policy from a JSON file ────────────────────────────────────

interface RatioRule { minFrames: number; ratio: number; action: AbuseAction }
interface PolicyFile {
  windowMinutes?: number
  malformedStreamFrames?: RatioRule
  largeFrames?: RatioRule & { frameBytes: number }
  sustainedThroughput?: { bytesPerSecond: number; windows: number; action: AbuseAction }
  trafficWithoutSessions?: { bytes: number; action: AbuseAction }
}

const ACTIONS: readonly AbuseAction[] = ['flag', 'throttle']

function num(value: unknown, where: string, { min = 0, integer = false } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${where} must be a ${integer ? 'whole ' : ''}number ≥ ${min}`)
  }
  return value
}

function action(value: unknown, where: string): AbuseAction {
  if (!ACTIONS.includes(value as AbuseAction)) throw new Error(`${where} must be one of ${ACTIONS.join(', ')}`)
  return value as AbuseAction
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`)
  return value as Record<string, unknown>
}

/** Validate a policy file's JSON. Throws on anything unexpected, so a typo fails at boot. */
export function parseAbusePolicy(json: unknown): PolicyFile {
  const root = obj(json, 'abuse policy')
  const known = ['windowMinutes', 'malformedStreamFrames', 'largeFrames', 'sustainedThroughput', 'trafficWithoutSessions']
  for (const key of Object.keys(root)) if (!known.includes(key)) throw new Error(`abuse policy: unknown key "${key}"`)
  const policy: PolicyFile = {}
  if (root.windowMinutes !== undefined) policy.windowMinutes = num(root.windowMinutes, 'windowMinutes', { min: 1 })
  if (root.malformedStreamFrames !== undefined) {
    const r = obj(root.malformedStreamFrames, 'malformedStreamFrames')
    policy.malformedStreamFrames = {
      minFrames: num(r.minFrames, 'malformedStreamFrames.minFrames', { min: 1, integer: true }),
      ratio: num(r.ratio, 'malformedStreamFrames.ratio'),
      action: action(r.action, 'malformedStreamFrames.action'),
    }
  }
  if (root.largeFrames !== undefined) {
    const r = obj(root.largeFrames, 'largeFrames')
    policy.largeFrames = {
      minFrames: num(r.minFrames, 'largeFrames.minFrames', { min: 1, integer: true }),
      ratio: num(r.ratio, 'largeFrames.ratio'),
      frameBytes: num(r.frameBytes, 'largeFrames.frameBytes', { min: 1, integer: true }),
      action: action(r.action, 'largeFrames.action'),
    }
  }
  if (root.sustainedThroughput !== undefined) {
    const r = obj(root.sustainedThroughput, 'sustainedThroughput')
    policy.sustainedThroughput = {
      bytesPerSecond: num(r.bytesPerSecond, 'sustainedThroughput.bytesPerSecond', { min: 1 }),
      windows: num(r.windows, 'sustainedThroughput.windows', { min: 1, integer: true }),
      action: action(r.action, 'sustainedThroughput.action'),
    }
  }
  if (root.trafficWithoutSessions !== undefined) {
    const r = obj(root.trafficWithoutSessions, 'trafficWithoutSessions')
    policy.trafficWithoutSessions = {
      bytes: num(r.bytes, 'trafficWithoutSessions.bytes', { min: 1 }),
      action: action(r.action, 'trafficWithoutSessions.action'),
    }
  }
  return policy
}

export class RulePolicy implements AbuseSignals {
  readonly largeFrameBytes: number
  readonly inspectStreamFrames: boolean
  readonly windowMs: number
  /** Consecutive windows each machine has been over the sustained-throughput rate. */
  private streaks = new Map<string, number>()

  constructor(private policy: PolicyFile) {
    this.largeFrameBytes = policy.largeFrames?.frameBytes ?? 0
    this.inspectStreamFrames = policy.malformedStreamFrames !== undefined
    this.windowMs = (policy.windowMinutes ?? 10) * 60_000
  }

  forget(machineId: string): void { this.streaks.delete(machineId) }

  evaluate(s: MachineTrafficSummary): AbuseFinding[] {
    const findings: AbuseFinding[] = []
    const p = this.policy
    if (p.malformedStreamFrames && s.streamFrames >= p.malformedStreamFrames.minFrames) {
      const ratio = s.malformedStreamFrames / s.streamFrames
      if (ratio > p.malformedStreamFrames.ratio) {
        findings.push({ signal: 'malformedStreamFrames', action: p.malformedStreamFrames.action, detail: { streamFrames: s.streamFrames, malformed: s.malformedStreamFrames } })
      }
    }
    if (p.largeFrames && s.frames >= p.largeFrames.minFrames && s.largeFrames / s.frames > p.largeFrames.ratio) {
      findings.push({ signal: 'largeFrames', action: p.largeFrames.action, detail: { frames: s.frames, large: s.largeFrames, frameBytes: p.largeFrames.frameBytes } })
    }
    if (p.sustainedThroughput) {
      const rate = s.windowSeconds > 0 ? s.bytes / s.windowSeconds : 0
      const streak = rate >= p.sustainedThroughput.bytesPerSecond ? (this.streaks.get(s.machineId) ?? 0) + 1 : 0
      if (streak === 0) this.streaks.delete(s.machineId)
      else this.streaks.set(s.machineId, streak)
      if (streak >= p.sustainedThroughput.windows) {
        findings.push({ signal: 'sustainedThroughput', action: p.sustainedThroughput.action, detail: { bytesPerSecond: Math.round(rate), windows: streak } })
      }
    }
    if (p.trafficWithoutSessions && s.sessionsAdvertised === 0 && s.bytes >= p.trafficWithoutSessions.bytes) {
      findings.push({ signal: 'trafficWithoutSessions', action: p.trafficWithoutSessions.action, detail: { bytes: s.bytes } })
    }
    return findings
  }
}

/** The policy in RELAY_ABUSE_POLICY_FILE, or null (no evaluation) when unset. */
export function loadAbusePolicy(path: string | undefined): AbuseSignals | null {
  if (!path) return null
  try {
    return new RulePolicy(parseAbusePolicy(JSON.parse(readFileSync(path, 'utf-8'))))
  } catch (err) {
    throw new Error(`RELAY_ABUSE_POLICY_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/** Whether a stream_data payload looks like a Codekin protocol frame: a JSON object with a string `type`. */
export function isWellFormedStreamData(data: unknown): boolean {
  if (typeof data !== 'string' || data.length < 2 || data[0] !== '{') return false
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string'
  } catch {
    return false
  }
}

// ── Review queue ──────────────────────────────────────────────────────────

export interface AbuseFlag {
  id: string
  machineId: string
  machineName: string | null
  workspaceId: string | null
  ownerUserId: string | null
  ownerLogin: string | null
  signal: string
  action: AbuseAction
  detail: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
  resolutionNote: string | null
}

interface FlagRow {
  id: string
  machine_id: string
  display_name: string | null
  workspace_id: string | null
  owner_user_id: string | null
  login: string | null
  signal: string
  action: AbuseAction
  detail: string
  created_at: string
  resolved_at: string | null
  resolution_note: string | null
}

function toFlag(r: FlagRow): AbuseFlag {
  let detail: Record<string, unknown> = {}
  try { detail = JSON.parse(r.detail) as Record<string, unknown> } catch { /* keep empty */ }
  return {
    id: r.id, machineId: r.machine_id, machineName: r.display_name, workspaceId: r.workspace_id,
    ownerUserId: r.owner_user_id, ownerLogin: r.login, signal: r.signal, action: r.action, detail,
    createdAt: r.created_at, resolvedAt: r.resolved_at, resolutionNote: r.resolution_note,
  }
}

/**
 * Record a finding: a new open flag unless this machine already has one for
 * the signal. Returns the flag id when one was created.
 */
export function recordFinding(db: Database.Database, machineId: string, finding: AbuseFinding): string | null {
  const open = db.prepare('SELECT id FROM abuse_flags WHERE machine_id = ? AND signal = ? AND resolved_at IS NULL').get(machineId, finding.signal)
  if (open) return null
  const machine = db.prepare('SELECT workspace_id, owner_user_id FROM machines WHERE id = ?').get(machineId) as
    | { workspace_id: string; owner_user_id: string }
    | undefined
  const id = randomUUID()
  db.prepare(
    `INSERT INTO abuse_flags (id, machine_id, workspace_id, owner_user_id, signal, action, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, machineId, machine?.workspace_id ?? null, machine?.owner_user_id ?? null, finding.signal, finding.action, JSON.stringify(finding.detail))
  recordAuditEvent(db, {
    kind: 'abuse_flagged',
    machineId,
    workspaceId: machine?.workspace_id ?? null,
    metadata: { flagId: id, signal: finding.signal, action: finding.action },
  })
  return id
}

export function listAbuseFlags(db: Database.Database, status: 'open' | 'all' = 'open', limit = 200): AbuseFlag[] {
  const rows = db.prepare(
    `SELECT f.id, f.machine_id, m.display_name, f.workspace_id, f.owner_user_id, u.login, f.signal, f.action,
            f.detail, f.created_at, f.resolved_at, f.resolution_note
     FROM abuse_flags f
     LEFT JOIN machines m ON m.id = f.machine_id
     LEFT JOIN users u ON u.id = f.owner_user_id
     ${status === 'open' ? 'WHERE f.resolved_at IS NULL' : ''}
     ORDER BY f.created_at DESC LIMIT ?`,
  ).all(limit) as FlagRow[]
  return rows.map(toFlag)
}

/** Close an open flag. Returns the flag as it was, or null if missing or already resolved. */
export function resolveAbuseFlag(
  db: Database.Database,
  id: string,
  operatorUserId: string,
  note: string,
): AbuseFlag | null {
  const changed = db.prepare(
    `UPDATE abuse_flags SET resolved_at = datetime('now'), resolved_by_user_id = ?, resolution_note = ?
     WHERE id = ? AND resolved_at IS NULL`,
  ).run(operatorUserId, note.slice(0, 500), id).changes
  if (changed === 0) return null
  const flag = listAbuseFlags(db, 'all', 10_000).find(f => f.id === id) ?? null
  recordAuditEvent(db, {
    kind: 'abuse_flag_resolved',
    actorUserId: operatorUserId,
    machineId: flag?.machineId ?? null,
    workspaceId: flag?.workspaceId ?? null,
    metadata: { flagId: id, signal: flag?.signal ?? null },
  })
  return flag
}

/** Workspaces with an open `throttle` flag: their relayed traffic is slowed until it's resolved. */
export function throttledWorkspaces(db: Database.Database): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT workspace_id FROM abuse_flags WHERE action = 'throttle' AND resolved_at IS NULL AND workspace_id IS NOT NULL`,
  ).all() as Array<{ workspace_id: string }>
  return new Set(rows.map(r => r.workspace_id))
}
