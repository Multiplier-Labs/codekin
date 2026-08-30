/**
 * Host probe — the machine itself as a monitored asset.
 *
 * Samples memory pressure, load, pending apt updates (cached — apt is slow),
 * and reboot-required, all sudo-free as the Codekin server user. Breaches on
 * operator-relevant thresholds; anything that needs privileges to *fix*
 * (upgrades, reboots) is delivered as a proposal in the breach text —
 * observe → propose, with routine-execute deliberately not implemented until
 * the operator approves specific action classes.
 */

import { readFileSync, existsSync } from 'fs'
import { loadavg, cpus } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ProbeResult } from './deployment-monitor.js'
import type { DeploymentSample } from './deployment-monitor.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Config + raw snapshot
// ---------------------------------------------------------------------------

export interface HostProbeConfig {
  type: 'host'
  /** Breach when available memory drops below this percentage. Default 10. */
  minMemAvailablePct?: number
  /** Breach when 1-min load average per core exceeds this. Default 3. */
  maxLoadPerCore?: number
  /** Breach (once, on transition) when security updates are pending. Default true. */
  alertOnSecurityUpdates?: boolean
  /** Breach (once, on transition) when the system requires a reboot. Default true. */
  alertOnRebootRequired?: boolean
}

/** Raw host readings — separated from evaluation so tests can inject them. */
export interface HostRaw {
  memTotalKb: number | null
  memAvailableKb: number | null
  load1: number
  cores: number
  upgradable: number | null
  securityUpgradable: number | null
  rebootRequired: boolean
}

const DEFAULT_MIN_MEM_PCT = 10
const DEFAULT_MAX_LOAD_PER_CORE = 3
/** apt enumeration is slow (seconds) — refresh at most this often. */
const APT_CACHE_MS = 6 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Collection (sudo-free)
// ---------------------------------------------------------------------------

function readMeminfo(): { memTotalKb: number | null; memAvailableKb: number | null } {
  try {
    const text = readFileSync('/proc/meminfo', 'utf-8')
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(text)
    const available = /MemAvailable:\s+(\d+)\s*kB/.exec(text)
    return {
      memTotalKb: total ? parseInt(total[1], 10) : null,
      memAvailableKb: available ? parseInt(available[1], 10) : null,
    }
  } catch {
    return { memTotalKb: null, memAvailableKb: null }
  }
}

let aptCache: { at: number; upgradable: number | null; securityUpgradable: number | null } | null = null

async function readAptUpdates(): Promise<{ upgradable: number | null; securityUpgradable: number | null }> {
  if (aptCache && Date.now() - aptCache.at < APT_CACHE_MS) {
    return { upgradable: aptCache.upgradable, securityUpgradable: aptCache.securityUpgradable }
  }
  try {
    // Read-only enumeration of already-fetched package lists; no lock, no root.
    const { stdout } = await execFileAsync('apt', ['list', '--upgradable'], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    })
    const lines = stdout.split('\n').filter(l => l.includes('[upgradable from'))
    const result = {
      upgradable: lines.length,
      securityUpgradable: lines.filter(l => l.includes('-security')).length,
    }
    aptCache = { at: Date.now(), ...result }
    return result
  } catch {
    // apt absent (non-Debian host) or errored — unknown, not zero.
    aptCache = { at: Date.now(), upgradable: null, securityUpgradable: null }
    return { upgradable: null, securityUpgradable: null }
  }
}

/** One raw host snapshot. Exported for the runner; tests inject HostRaw directly. */
export async function collectHostRaw(): Promise<HostRaw> {
  const mem = readMeminfo()
  const apt = await readAptUpdates()
  return {
    ...mem,
    load1: loadavg()[0],
    cores: Math.max(cpus().length, 1),
    ...apt,
    rebootRequired: existsSync('/var/run/reboot-required'),
  }
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

export function evaluateHostProbe(probe: HostProbeConfig, raw: HostRaw): ProbeResult {
  const breaches: string[] = []
  const minMemPct = probe.minMemAvailablePct ?? DEFAULT_MIN_MEM_PCT
  const maxLoadPerCore = probe.maxLoadPerCore ?? DEFAULT_MAX_LOAD_PER_CORE

  const memAvailablePct = raw.memTotalKb && raw.memAvailableKb !== null
    ? Math.round((raw.memAvailableKb / raw.memTotalKb) * 100)
    : null
  if (memAvailablePct !== null && memAvailablePct < minMemPct) {
    breaches.push(`memory low: ${memAvailablePct}% available`)
  }

  const loadPerCore = raw.load1 / raw.cores
  if (loadPerCore > maxLoadPerCore) {
    breaches.push(`load high: ${raw.load1.toFixed(2)} (${loadPerCore.toFixed(2)} per core)`)
  }

  if ((probe.alertOnSecurityUpdates ?? true) && raw.securityUpgradable !== null && raw.securityUpgradable > 0) {
    breaches.push(`${raw.securityUpgradable} security update(s) pending (proposed, operator-run: sudo apt-get update && sudo apt-get upgrade)`)
  }

  if ((probe.alertOnRebootRequired ?? true) && raw.rebootRequired) {
    breaches.push('system reboot required (proposed, operator-run: schedule a reboot at a quiet moment)')
  }

  return {
    ok: breaches.length === 0,
    breaches,
    events: [],
    metrics: {
      memAvailablePct,
      memTotalMb: raw.memTotalKb !== null ? Math.round(raw.memTotalKb / 1024) : null,
      load1: Math.round(raw.load1 * 100) / 100,
      cores: raw.cores,
      upgradable: raw.upgradable,
      securityUpgradable: raw.securityUpgradable,
      rebootRequired: raw.rebootRequired ? 1 : 0,
    },
  }
}

/** The default host runner: collect + evaluate. */
export async function runHostProbe(probe: HostProbeConfig): Promise<ProbeResult> {
  return evaluateHostProbe(probe, await collectHostRaw())
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

/**
 * Human-readable host digest from the latest samples. The host sample leads;
 * deployment probes are summarized. Proposals stay operator-run.
 */
export function buildHostDigest(hostSample: DeploymentSample, allSamples: DeploymentSample[]): string {
  const m = hostSample.metrics
  const lines: string[] = ['Weekly host digest:']

  lines.push(`- Memory: ${m.memAvailablePct ?? '?'}% available of ${m.memTotalMb ?? '?'}MB`)
  lines.push(`- Load: ${m.load1 ?? '?'} across ${m.cores ?? '?'} core(s)`)
  if (m.upgradable === null || m.upgradable === undefined) {
    lines.push('- Updates: unknown (apt unavailable)')
  } else {
    lines.push(`- Updates: ${m.upgradable} upgradable, ${m.securityUpgradable ?? 0} security${(m.securityUpgradable as number) > 0 ? ' — proposed, operator-run: sudo apt-get update && sudo apt-get upgrade' : ''}`)
  }
  lines.push(`- Reboot required: ${m.rebootRequired ? 'YES — propose a reboot window to the user' : 'no'}`)

  const others = allSamples.filter(s => s.id !== hostSample.id)
  if (others.length > 0) {
    const breached = others.filter(s => !s.ok)
    lines.push(`- Deployment probes: ${others.length - breached.length}/${others.length} healthy${breached.length ? ` — breached: ${breached.map(s => s.probeKey).join(', ')}` : ''}`)
  }

  if (!hostSample.ok) {
    lines.push(`- Active host breaches: ${hostSample.breaches.join('; ')}`)
  }

  lines.push('Share a short summary with the user if anything above needs their attention; otherwise journal it.')
  return lines.join('\n')
}
