/**
 * Deployment monitor — deterministic probes over registered deployments.
 *
 * The two-layer design from the Joe expansion plan: probes are plain code
 * (seconds-cheap, no LLM anywhere in the hot path) sampling into a
 * `deployment_samples` table; AI enters only on a threshold breach, delivered
 * as a durable `probe-breach` signal through the trigger engine, which the
 * orchestrator consumes as a notification (and, later, as a diagnostic child).
 *
 * Sampling is driven by the engine's tick (registerTickTask) — no interval
 * loop of its own. Breach signals fire on *transitions* (ok → breached and
 * back), not on every breached sample, so a persistent condition alerts once.
 *
 * Everything here is sudo-free by policy: http requests, `pm2 jlist`, and
 * `df` all run as the unprivileged Codekin user.
 */

import Database from 'better-sqlite3'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { request as httpsRequest } from 'https'
import { existsSync, chmodSync } from 'fs'
import { defaultRunsDbPath } from './run-db.js'
import { jsonParse } from './json-parse.js'
import {
  loadDeployments,
  probeKey,
  type DeploymentConfig,
  type ProbeConfig,
  type HttpProbeConfig,
  type Pm2ProbeConfig,
  type DiskProbeConfig,
  type HostProbeConfigRef,
} from './deployment-config.js'
import { runHostProbe } from './host-probe.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProbeMetrics = Record<string, number | string | null>

export interface ProbeResult {
  ok: boolean
  /** Persistent breach conditions (status-shaped: present while the condition holds). */
  breaches: string[]
  /** One-off events worth signaling even though they self-clear (e.g. a restart). */
  events: string[]
  metrics: ProbeMetrics
}

export interface DeploymentSample {
  id: number
  deploymentId: string
  probeKey: string
  probeType: ProbeConfig['type']
  ok: boolean
  breaches: string[]
  metrics: ProbeMetrics
  createdAt: string
}

export interface ProbeRunners {
  http: (probe: HttpProbeConfig) => Promise<ProbeResult>
  pm2: (probe: Pm2ProbeConfig, previous: ProbeMetrics | null) => Promise<ProbeResult>
  disk: (probe: DiskProbeConfig) => Promise<ProbeResult>
  host: (probe: HostProbeConfigRef) => Promise<ProbeResult>
}

/** Durable-queue publisher — the trigger engine's enqueueSignal, injected. */
export type SignalPublisher = (input: { kind: string; payload?: Record<string, unknown>; dedupeKey?: string; ttlMs?: number }) => void

const DEFAULT_HTTP_TIMEOUT_MS = 10_000
const CERT_WARN_DAYS = 14
const DEFAULT_MIN_FREE_PCT = 10
/** Breach signals expire fast — a stale alert is worse than none. */
const BREACH_SIGNAL_TTL_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Default probe runners (all sudo-free)
// ---------------------------------------------------------------------------

/** Days until the TLS certificate of `url` expires, or `null` when unavailable. */
function certDaysRemaining(url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const req = httpsRequest(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        const socket = res.socket as import('tls').TLSSocket
        const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
        res.resume()
        if (!cert || !cert.valid_to) return resolve(null)
        const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        resolve(Number.isFinite(days) ? days : null)
      })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.on('error', () => resolve(null))
      req.end()
    } catch {
      resolve(null)
    }
  })
}

/** Exported for tests (stubbed global fetch). */
export async function runHttpProbe(probe: HttpProbeConfig): Promise<ProbeResult> {
  const timeoutMs = probe.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const breaches: string[] = []
  const metrics: ProbeMetrics = { status: null, latencyMs: null, certDays: null }

  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(probe.url, { signal: controller.signal })
    clearTimeout(timer)
    metrics.latencyMs = Date.now() - started
    metrics.status = res.status
    const statusOk = probe.expectStatus !== undefined ? res.status === probe.expectStatus : res.status < 400
    if (!statusOk) {
      breaches.push(`http ${res.status}${probe.expectStatus !== undefined ? ` (expected ${probe.expectStatus})` : ''}`)
    }
    // Security-header posture of the live surface (opt-in, https only).
    if (probe.checkHeaders && probe.url.startsWith('https:')) {
      const hsts = res.headers.get('strict-transport-security') !== null
      const csp = res.headers.get('content-security-policy') !== null
      metrics.hsts = hsts ? 1 : 0
      metrics.csp = csp ? 1 : 0
      if (!hsts) breaches.push('missing Strict-Transport-Security header')
      if (!csp) breaches.push('missing Content-Security-Policy header')
    }
  } catch (err) {
    metrics.latencyMs = Date.now() - started
    const msg = err instanceof Error && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err)
    breaches.push(`unreachable: ${msg}`)
  }

  if (probe.checkTls && probe.url.startsWith('https:')) {
    const days = await certDaysRemaining(probe.url, timeoutMs)
    metrics.certDays = days
    if (days !== null && days < CERT_WARN_DAYS) {
      breaches.push(`TLS certificate expires in ${days} day(s)`)
    }
  }

  return { ok: breaches.length === 0, breaches, events: [], metrics }
}

interface Pm2Process {
  name?: string
  pm2_env?: { status?: string; restart_time?: number }
  monit?: { memory?: number }
}

async function runPm2Probe(probe: Pm2ProbeConfig, previous: ProbeMetrics | null): Promise<ProbeResult> {
  const breaches: string[] = []
  const events: string[] = []
  const metrics: ProbeMetrics = { status: null, restarts: null, memoryMb: null }

  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 })
    const list = JSON.parse(stdout) as Pm2Process[]
    const proc = list.find(p => p.name === probe.processName)
    if (!proc) {
      breaches.push(`pm2 process '${probe.processName}' not found`)
    } else {
      const status = proc.pm2_env?.status ?? 'unknown'
      const restarts = proc.pm2_env?.restart_time ?? 0
      const memoryMb = proc.monit?.memory != null ? Math.round(proc.monit.memory / (1024 * 1024)) : null
      metrics.status = status
      metrics.restarts = restarts
      metrics.memoryMb = memoryMb

      if (status !== 'online') breaches.push(`pm2 status '${status}'`)
      if (probe.memoryLimitMb && memoryMb !== null && memoryMb > probe.memoryLimitMb) {
        breaches.push(`memory ${memoryMb}MB > limit ${probe.memoryLimitMb}MB`)
      }
      const prevRestarts = typeof previous?.restarts === 'number' ? previous.restarts : null
      if (prevRestarts !== null && restarts > prevRestarts) {
        events.push(`restarted (${prevRestarts} → ${restarts})`)
      }
    }
  } catch (err) {
    breaches.push(`pm2 jlist failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: breaches.length === 0, breaches, events, metrics }
}

async function runDiskProbe(probe: DiskProbeConfig): Promise<ProbeResult> {
  const minFree = probe.minFreePct ?? DEFAULT_MIN_FREE_PCT
  const breaches: string[] = []
  const metrics: ProbeMetrics = { freePct: null }

  try {
    const { stdout } = await execFileAsync('df', ['-kP', probe.path], { timeout: 10_000 })
    const line = stdout.trim().split('\n')[1]
    const usedPctMatch = line ? /(\d+)%/.exec(line) : null
    if (!usedPctMatch) {
      breaches.push(`df output unparseable for ${probe.path}`)
    } else {
      const freePct = 100 - parseInt(usedPctMatch[1], 10)
      metrics.freePct = freePct
      if (freePct < minFree) breaches.push(`disk free ${freePct}% < ${minFree}% on ${probe.path}`)
    }
  } catch (err) {
    breaches.push(`df failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: breaches.length === 0, breaches, events: [], metrics }
}

const DEFAULT_RUNNERS: ProbeRunners = { http: runHttpProbe, pm2: runPm2Probe, disk: runDiskProbe, host: runHostProbe }

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class DeploymentMonitor {
  private db: Database.Database
  private runners: ProbeRunners
  private publish: SignalPublisher
  private loadConfig: () => ReturnType<typeof loadDeployments>

  constructor(opts: {
    publish: SignalPublisher
    dbPath?: string
    runners?: Partial<ProbeRunners>
    loadConfig?: () => ReturnType<typeof loadDeployments>
  }) {
    const resolvedPath = opts.dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id TEXT NOT NULL,
        probe_key TEXT NOT NULL,
        probe_type TEXT NOT NULL,
        ok INTEGER NOT NULL,
        breaches TEXT NOT NULL DEFAULT '[]',
        metrics TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deployment_samples_probe ON deployment_samples(probe_key, id);
    `)
    this.runners = { ...DEFAULT_RUNNERS, ...opts.runners }
    this.publish = opts.publish
    this.loadConfig = opts.loadConfig ?? loadDeployments
  }

  close(): void {
    this.db.close()
  }

  /**
   * One sampling pass over every enabled deployment/probe. Inserts a sample
   * per probe and publishes durable signals on breach/recovery *transitions*
   * and on one-off events. Probe errors are themselves breaches, so a broken
   * probe is visible rather than silent.
   */
  async sampleAll(now: Date = new Date()): Promise<void> {
    const { deployments } = this.loadConfig()
    for (const deployment of deployments) {
      if (!deployment.enabled) continue
      for (const probe of deployment.probes) {
        try {
          await this.sampleProbe(deployment, probe, now)
        } catch (err) {
          console.error(`[deployment-monitor] Probe failed unexpectedly (${probeKey(deployment, probe)}):`, err)
        }
      }
    }
  }

  private async sampleProbe(deployment: DeploymentConfig, probe: ProbeConfig, now: Date): Promise<void> {
    const key = probeKey(deployment, probe)
    const previous = this.latestSample(key)

    const result: ProbeResult = probe.type === 'http'
      ? await this.runners.http(probe)
      : probe.type === 'pm2'
        ? await this.runners.pm2(probe, previous?.metrics ?? null)
        : probe.type === 'disk'
          ? await this.runners.disk(probe)
          : await this.runners.host(probe)

    this.db.prepare(`
      INSERT INTO deployment_samples (deployment_id, probe_key, probe_type, ok, breaches, metrics, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deployment.id, key, probe.type, result.ok ? 1 : 0, JSON.stringify(result.breaches), JSON.stringify(result.metrics), now.toISOString())

    const payloadBase = {
      deploymentId: deployment.id,
      deploymentName: deployment.name,
      repoPath: deployment.repoPath ?? null,
      probeKey: key,
      probeType: probe.type,
      metrics: result.metrics,
    }

    // Transition ok → breached: alert once, not on every breached sample.
    const wasBreached = previous ? !previous.ok : false
    if (!result.ok && !wasBreached) {
      this.publish({
        kind: 'probe-breach',
        payload: { ...payloadBase, breaches: result.breaches },
        dedupeKey: `probe-breach::${key}`,
        ttlMs: BREACH_SIGNAL_TTL_MS,
      })
    }
    // Transition breached → ok: close the loop.
    if (result.ok && wasBreached) {
      this.publish({
        kind: 'probe-recovered',
        payload: payloadBase,
        dedupeKey: `probe-recovered::${key}`,
        ttlMs: BREACH_SIGNAL_TTL_MS,
      })
    }
    // One-off events (e.g. a pm2 restart) signal regardless of breach state.
    for (const event of result.events) {
      this.publish({
        kind: 'probe-event',
        payload: { ...payloadBase, event },
        dedupeKey: `probe-event::${key}::${event}`,
        ttlMs: BREACH_SIGNAL_TTL_MS,
      })
    }
  }

  /** Latest sample for one probe key, or `null`. */
  latestSample(key: string): DeploymentSample | null {
    const row = this.db.prepare(`SELECT * FROM deployment_samples WHERE probe_key = ? ORDER BY id DESC LIMIT 1`)
      .get(key) as Record<string, unknown> | undefined
    return row ? this.rowToSample(row) : null
  }

  /** Latest sample per probe, across all deployments — the status surface. */
  latestSamples(): DeploymentSample[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM deployment_samples s
      JOIN (SELECT probe_key, MAX(id) AS max_id FROM deployment_samples GROUP BY probe_key) latest
        ON s.id = latest.max_id
      ORDER BY s.deployment_id, s.probe_key
    `).all() as Record<string, unknown>[]
    return rows.map(row => this.rowToSample(row))
  }

  /** Sample history for one probe, newest first. */
  listSamples(opts: { probeKey: string; limit?: number }): DeploymentSample[] {
    const rows = this.db.prepare(`SELECT * FROM deployment_samples WHERE probe_key = ? ORDER BY id DESC LIMIT ?`)
      .all(opts.probeKey, Math.min(opts.limit ?? 100, 1000)) as Record<string, unknown>[]
    return rows.map(row => this.rowToSample(row))
  }

  /** Delete samples older than the retention window (called on boot, like ledger pruning). */
  pruneSamples(retentionMs: number = 30 * 24 * 60 * 60 * 1000): void {
    const cutoff = new Date(Date.now() - retentionMs).toISOString()
    this.db.prepare(`DELETE FROM deployment_samples WHERE created_at < ?`).run(cutoff)
  }

  private rowToSample(row: Record<string, unknown>): DeploymentSample {
    return {
      id: row.id as number,
      deploymentId: row.deployment_id as string,
      probeKey: row.probe_key as string,
      probeType: row.probe_type as ProbeConfig['type'],
      ok: !!(row.ok as number),
      breaches: jsonParse(row.breaches as string) as string[],
      metrics: jsonParse(row.metrics as string) as ProbeMetrics,
      createdAt: row.created_at as string,
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery (sudo-free: pm2 jlist as the Codekin user)
// ---------------------------------------------------------------------------

export interface DiscoveredProcess {
  name: string
  status: string
  alreadyConfigured: boolean
}

/**
 * Propose monitorable pm2 processes. Never auto-enrolls — the result is a
 * suggestion list for the operator (or Joe, under trust) to confirm.
 */
export async function discoverPm2Processes(): Promise<DiscoveredProcess[]> {
  const configured = new Set(
    loadDeployments().deployments.flatMap(d => d.probes.filter((p): p is Pm2ProbeConfig => p.type === 'pm2').map(p => p.processName)),
  )
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 })
    const list = JSON.parse(stdout) as Pm2Process[]
    return list
      .filter((p): p is Pm2Process & { name: string } => !!p.name)
      .map(p => ({
        name: p.name,
        status: p.pm2_env?.status ?? 'unknown',
        alreadyConfigured: configured.has(p.name),
      }))
  } catch {
    // pm2 absent or errored — nothing to propose.
    return []
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: DeploymentMonitor | null = null

export function initDeploymentMonitor(opts: ConstructorParameters<typeof DeploymentMonitor>[0]): DeploymentMonitor {
  instance?.close()
  instance = new DeploymentMonitor(opts)
  return instance
}

export function tryGetDeploymentMonitor(): DeploymentMonitor | null {
  return instance
}

export function shutdownDeploymentMonitor(): void {
  instance?.close()
  instance = null
}
