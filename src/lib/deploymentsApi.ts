/**
 * HTTP client for the deployment registry + monitor REST API.
 *
 * All calls go through the active transport at /api/deployments with Bearer
 * token auth. Types mirror server/deployment-config.ts and
 * server/deployment-monitor.ts.
 */

import { transport } from './transport'

const BASE = '/api/deployments'

async function fetchJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

function headers(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpProbeConfig {
  type: 'http'
  url: string
  expectStatus?: number
  timeoutMs?: number
  checkTls?: boolean
  checkHeaders?: boolean
}

export interface Pm2ProbeConfig {
  type: 'pm2'
  processName: string
  memoryLimitMb?: number
}

export interface DiskProbeConfig {
  type: 'disk'
  path: string
  minFreePct?: number
}

export interface LogProbeConfig {
  type: 'log'
  path: string
  errorPattern?: string
  maxErrorsPerWindow?: number
}

export interface HostProbeConfig {
  type: 'host'
  minMemAvailablePct?: number
  maxLoadPerCore?: number
  alertOnSecurityUpdates?: boolean
  alertOnRebootRequired?: boolean
}

export type ProbeConfig = HttpProbeConfig | Pm2ProbeConfig | DiskProbeConfig | LogProbeConfig | HostProbeConfig

export interface DeploymentSample {
  id: number
  deploymentId: string
  probeKey: string
  probeType: ProbeConfig['type']
  ok: boolean
  breaches: string[]
  metrics: Record<string, number | string | null>
  createdAt: string
}

export interface Deployment {
  id: string
  name: string
  repoPath?: string
  enabled: boolean
  autoDiagnose?: boolean
  probes: ProbeConfig[]
  latestSamples: DeploymentSample[]
}

export interface DiscoveredProcess {
  name: string
  status: string
  alreadyConfigured: boolean
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Registry with each probe's latest sample. */
export async function listDeployments(token: string): Promise<Deployment[]> {
  const res = await transport.fetch(BASE, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to list deployments: ${res.status}`)
  const data = await fetchJson<{ deployments: Deployment[] }>(res)
  return data.deployments
}

export async function saveDeployment(token: string, deployment: Omit<Deployment, 'latestSamples'>): Promise<void> {
  const res = await transport.fetch(BASE, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(deployment),
  })
  if (!res.ok) {
    const body = await fetchJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
    throw new Error(body.error ?? `Failed to save deployment: ${res.status}`)
  }
}

export async function patchDeployment(token: string, id: string, patch: Partial<Omit<Deployment, 'latestSamples'>>): Promise<void> {
  const res = await transport.fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update deployment: ${res.status}`)
}

export async function deleteDeployment(token: string, id: string): Promise<void> {
  const res = await transport.fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`Failed to delete deployment: ${res.status}`)
}

/** pm2 process proposals (never auto-enrolled). */
export async function discoverDeployments(token: string): Promise<DiscoveredProcess[]> {
  const res = await transport.fetch(`${BASE}/discover`, { headers: headers(token) })
  if (!res.ok) throw new Error(`Failed to discover: ${res.status}`)
  const data = await fetchJson<{ pm2: DiscoveredProcess[] }>(res)
  return data.pm2
}
