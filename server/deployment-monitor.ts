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
import { existsSync, chmodSync, statSync, openSync, readSync, closeSync } from 'fs'
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
  type LogProbeConfig,
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
  log: (probe: LogProbeConfig, previous: ProbeMetrics | null) => Promise<ProbeResult>
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

/**
 * Parse `pm2 jlist` output tolerantly. pm2 sometimes prints warning banners on
 * stdout *before* the JSON (e.g. "In-memory PM2 is out-of-date" after a node
 * upgrade), including ANSI color codes — so scan for the line the JSON array
 * actually starts on instead of trusting the whole stream. Exported for tests.
 */
export function parsePm2Jlist(stdout: string): Pm2Process[] {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed) as Pm2Process[]
  } catch {
    // Banner noise ahead of the payload — the array starts at the last line
    // beginning with '[' (ANSI escapes also contain '[', so match line starts).
    const start = trimmed.lastIndexOf('\n[')
    if (start >= 0) {
      return JSON.parse(trimmed.slice(start + 1)) as Pm2Process[]
    }
    throw new Error('pm2 jlist output contained no JSON array')
  }
}

async function runPm2Probe(probe: Pm2ProbeConfig, previous: ProbeMetrics | null): Promise<ProbeResult> {
  const breaches: string[] = []
  const events: string[] = []
  const metrics: ProbeMetrics = { status: null, restarts: null, memoryMb: null }

  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 })
    const list = parsePm2Jlist(stdout)
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

/** Bounded read of `[start, start+length)` from a file. */
function readWindow(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, start)
    return buf.toString('utf-8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/** Never scan more than this per window — bounds memory on runaway logs. */
const LOG_MAX_READ_BYTES = 5 * 1024 * 1024

/**
 * Error-rate log probe. The read offset travels in the sample metrics
 * (`fileOffset`), so the state is exactly as durable as the samples table:
 * the first sample (and the first after a restart gap or a probe error)
 * baselines at EOF and never scans history; a shrunken file means rotation
 * and the scan restarts from 0. Exported for tests.
 */
export async function runLogProbe(probe: LogProbeConfig, previous: ProbeMetrics | null): Promise<ProbeResult> {
  const maxErrors = probe.maxErrorsPerWindow ?? 10
  const breaches: string[] = []
  const metrics: ProbeMetrics = { errorCount: null, fileOffset: null, fileSize: null }

  let pattern: RegExp
  try {
    pattern = new RegExp(probe.errorPattern ?? '\\b(error|exception|fatal)\\b', 'i')
  } catch {
    breaches.push(`invalid errorPattern: ${probe.errorPattern}`)
    return { ok: false, breaches, events: [], metrics }
  }

  try {
    const size = statSync(probe.path).size
    metrics.fileSize = size
    const prevOffset = typeof previous?.fileOffset === 'number' ? previous.fileOffset : null

    if (prevOffset === null) {
      // No prior offset — baseline at EOF; counting starts next window.
      metrics.fileOffset = size
      metrics.errorCount = 0
    } else {
      let start = size < prevOffset ? 0 : prevOffset // shrunk = rotated/truncated
      if (size - start > LOG_MAX_READ_BYTES) {
        start = size - LOG_MAX_READ_BYTES
        metrics.truncatedScan = 1
      }
      const count = start >= size
        ? 0
        : readWindow(probe.path, start, size - start).split('\n').filter(l => pattern.test(l)).length
      metrics.errorCount = count
      metrics.fileOffset = size
      if (count > maxErrors) {
        breaches.push(`${count} error line(s) in the last window (threshold ${maxErrors}) in ${probe.path}`)
      }
    }
  } catch (err) {
    breaches.push(`log probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: breaches.length === 0, breaches, events: [], metrics }
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

const DEFAULT_RUNNERS: ProbeRunners = { http: runHttpProbe, pm2: runPm2Probe, disk: runDiskProbe, log: runLogProbe, host: runHostProbe }

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
          : probe.type === 'log'
            ? await this.runners.log(probe, previous?.metrics ?? null)
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
    const list = parsePm2Jlist(stdout)
    return list
      .filter((p): p is Pm2Process & { name: string } => !!p.name)
      .map(p => ({
        name: p.name,
        status: p.pm2_env?.status ?? 'unknown',
        alreadyConfigured: configured.has(p.name),
      }))
  } catch (err) {
    // pm2 absent or errored — nothing to propose, but say so in the logs
    // rather than failing silently.
    console.error('[deployment-monitor] pm2 discovery failed:', err instanceof Error ? err.message : err)
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
