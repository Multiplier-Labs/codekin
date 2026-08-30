/**
 * Deployment registry persistence.
 *
 * The list of deployed apps Codekin monitors, stored as JSON at
 * ~/.codekin/deployments.json. Each deployment carries a set of deterministic
 * probes (http / pm2 / disk) sampled by the DeploymentMonitor. The registry is
 * meant to be bootstrapped by discovery (pm2 process list) and confirmed by
 * the operator — never silently auto-enrolled.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpProbeConfig {
  type: 'http'
  url: string
  /** Expected status code. Default: any 2xx/3xx. */
  expectStatus?: number
  timeoutMs?: number
  /** Also check TLS certificate days-remaining (https URLs). */
  checkTls?: boolean
  /** Also check security headers (HSTS, CSP) on https responses. */
  checkHeaders?: boolean
}

export interface Pm2ProbeConfig {
  type: 'pm2'
  processName: string
  /** Breach when resident memory exceeds this (MB). Unset = no memory check. */
  memoryLimitMb?: number
}

export interface DiskProbeConfig {
  type: 'disk'
  path: string
  /** Breach when free space drops below this percentage. Default 10. */
  minFreePct?: number
}

/**
 * Host probe config lives in host-probe.ts; re-declared here structurally to
 * keep this module dependency-free. `type: 'host'` monitors the machine
 * itself: memory, load, pending updates, reboot-required — all sudo-free.
 */
export interface HostProbeConfigRef {
  type: 'host'
  minMemAvailablePct?: number
  maxLoadPerCore?: number
  alertOnSecurityUpdates?: boolean
  alertOnRebootRequired?: boolean
}

export type ProbeConfig = HttpProbeConfig | Pm2ProbeConfig | DiskProbeConfig | HostProbeConfigRef

export interface DeploymentConfig {
  id: string
  name: string
  /** Optional link back to the source repo (connects incidents to recent merges). */
  repoPath?: string
  enabled: boolean
  /**
   * Operator opt-in: spawn a diagnostic child session automatically when a
   * probe breaches (requires `repoPath`). The child investigates and writes an
   * incident report; it never touches the running system. Default false —
   * without it, breaches only notify the orchestrator.
   */
  autoDiagnose?: boolean
  probes: ProbeConfig[]
}

export interface DeploymentsFile {
  deployments: DeploymentConfig[]
}

/** Stable identity of one probe within a deployment — the sample/breach-state key. */
export function probeKey(deployment: DeploymentConfig, probe: ProbeConfig): string {
  const target = probe.type === 'http' ? probe.url
    : probe.type === 'pm2' ? probe.processName
    : probe.type === 'disk' ? probe.path
    : 'system'
  return `${deployment.id}::${probe.type}:${target}`
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.codekin')
const CONFIG_PATH = join(CONFIG_DIR, 'deployments.json')

export function loadDeployments(): DeploymentsFile {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      return JSON.parse(raw) as DeploymentsFile
    }
  } catch (err) {
    console.error('[deployments] Failed to load config:', err)
  }
  return { deployments: [] }
}

export function saveDeployments(config: DeploymentsFile): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export function upsertDeployment(deployment: DeploymentConfig): DeploymentsFile {
  const config = loadDeployments()
  const idx = config.deployments.findIndex(d => d.id === deployment.id)
  if (idx >= 0) config.deployments[idx] = deployment
  else config.deployments.push(deployment)
  saveDeployments(config)
  return config
}

export function removeDeployment(id: string): DeploymentsFile {
  const config = loadDeployments()
  config.deployments = config.deployments.filter(d => d.id !== id)
  saveDeployments(config)
  return config
}

export function updateDeployment(id: string, patch: Partial<DeploymentConfig>): DeploymentsFile {
  const config = loadDeployments()
  const idx = config.deployments.findIndex(d => d.id === id)
  if (idx < 0) throw new Error(`Deployment not found: ${id}`)
  config.deployments[idx] = { ...config.deployments[idx], ...patch, id }
  saveDeployments(config)
  return config
}
