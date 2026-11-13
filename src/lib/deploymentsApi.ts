/**
 * HTTP client for the deployment registry + monitor REST API.
 *
 * All calls go through the active transport at /api/deployments with Bearer
 * token auth. Types mirror server/deployment-config.ts and
 * server/deployment-monitor.ts.
 */

import { request, type RequestOptions } from './request'

const BASE = '/api/deployments'

/** A /api/deployments call. Every deployments request sends the JSON content type and the Bearer token. */
function deployments<T = unknown>(token: string, path: string, opts: Omit<RequestOptions, 'token'>): Promise<T> {
  return request<T>(`${BASE}${path}`, { token, jsonHeader: true, ...opts })
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
  return (await deployments<{ deployments: Deployment[] }>(token, '', { error: 'Failed to list deployments' })).deployments
}

export async function saveDeployment(token: string, deployment: Omit<Deployment, 'latestSamples'>): Promise<void> {
  await deployments(token, '', { method: 'POST', body: deployment, parse: 'none', serverMessage: ['error'], error: 'Failed to save deployment' })
}

export async function patchDeployment(token: string, id: string, patch: Partial<Omit<Deployment, 'latestSamples'>>): Promise<void> {
  await deployments(token, `/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, parse: 'none', error: 'Failed to update deployment' })
}

export async function deleteDeployment(token: string, id: string): Promise<void> {
  await deployments(token, `/${encodeURIComponent(id)}`, { method: 'DELETE', parse: 'none', error: 'Failed to delete deployment' })
}

/** pm2 process proposals (never auto-enrolled). */
export async function discoverDeployments(token: string): Promise<DiscoveredProcess[]> {
  return (await deployments<{ pm2: DiscoveredProcess[] }>(token, `/discover`, { error: 'Failed to discover' })).pm2
}
