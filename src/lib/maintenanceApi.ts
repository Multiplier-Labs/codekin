/**
 * Client for explicit repo maintenance (/api/orchestrator/maintenance) —
 * mirrors server/maintenance-service.ts.
 */

import { transport } from './transport'

export type PlanState = 'off' | 'enabled' | 'paused'
export type CoverageHealth = 'healthy' | 'starting' | 'degraded' | 'unavailable'
export type ResponsePolicy = 'notify' | 'propose' | 'investigate' | 'implement'

export interface ResponsibilityCheck {
  automationId: string
  name: string | null
  managedBy: 'user' | 'maintenance' | null
  health: 'healthy' | 'starting' | 'held' | 'degraded' | 'unavailable' | 'disabled' | 'missing'
  lastSuccessAt: string | null
  nextRunAt: string | null
  hold: { at: string; reason: string } | null
}

export interface Responsibility {
  id: string
  repo: string
  name: string
  scope: string
  automationIds: string[]
  policy: ResponsePolicy
  maxActiveTasks: number
  requiredDecision: string
  enabled: boolean
  proposed: boolean
  latestObservation: string | null
  latestObservationAt: string | null
  health: CoverageHealth | null
  reasons: string[]
  checks: ResponsibilityCheck[]
  openTasks: number
}

export interface RepoMaintenance {
  repo: string
  state: PlanState
  revision: number
  health: CoverageHealth | null
  label: string
  reasons: string[]
  responsibilities: Responsibility[]
  activeTasks: number
  runningTasks: number
  needsYou: number
  governedAutomations: string[]
  hasProposal: boolean
  updatedAt: string | null
}

export interface MaintenanceActivity {
  id: string
  repo: string
  responsibilityId: string | null
  kind: 'check_ok' | 'check_failed' | 'finding' | 'action' | 'config' | 'coverage'
  summary: string
  ref: string | null
  createdAt: string
}

export const POLICY_LABELS: Record<ResponsePolicy, { label: string; description: string }> = {
  notify: { label: 'Notify', description: 'Record findings and tell you' },
  propose: { label: 'Propose work', description: 'Create tasks you start yourself' },
  investigate: { label: 'Investigate', description: 'Diagnose and recommend' },
  implement: { label: 'Implement', description: 'Fix through a verified PR' },
}

const BASE = '/api/orchestrator/maintenance'

async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await transport.fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* keep the status message */ }
    throw new Error(message)
  }
  return (await res.json()) as T
}

export async function listMaintenance(token: string): Promise<RepoMaintenance[]> {
  return (await call<{ repos: RepoMaintenance[] }>(token, '')).repos
}

export function getMaintenancePlan(token: string, repo: string): Promise<{ plan: RepoMaintenance; activity: MaintenanceActivity[] }> {
  return call(token, `/plan?repo=${encodeURIComponent(repo)}`)
}

export async function setPlanState(
  token: string,
  action: 'enable' | 'pause' | 'resume' | 'off',
  repo: string,
  opts: { expectedRevision?: number; adoptAutomationIds?: string[] } = {},
): Promise<RepoMaintenance> {
  return (await call<{ plan: RepoMaintenance }>(token, `/${action}`, { method: 'POST', body: { repo, ...opts } })).plan
}

export function addResponsibility(token: string, input: { repo: string; name: string; scope?: string; automationIds: string[]; policy: ResponsePolicy; maxActiveTasks?: number; requiredDecision?: string }): Promise<unknown> {
  return call(token, '/responsibilities', { method: 'POST', body: input })
}

export function updateResponsibility(token: string, id: string, patch: Partial<Pick<Responsibility, 'name' | 'scope' | 'automationIds' | 'policy' | 'maxActiveTasks' | 'requiredDecision' | 'enabled'>>): Promise<unknown> {
  return call(token, `/responsibilities/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

export function removeResponsibility(token: string, id: string): Promise<unknown> {
  return call(token, `/responsibilities/${encodeURIComponent(id)}/remove`, { method: 'POST' })
}

export function releaseAutomation(token: string, automationId: string): Promise<unknown> {
  return call(token, '/release', { method: 'POST', body: { automationId } })
}

/** Compact indicator text for the repo nav: "Joe maintaining · 2 running · 1 needs you". */
export function indicatorText(m: RepoMaintenance, agentName = 'Joe'): string {
  const label = m.label.replace(/^Joe\b/, agentName)
  const parts = [label]
  if (m.runningTasks > 0) parts.push(`${m.runningTasks} running`)
  if (m.needsYou > 0) parts.push(`${m.needsYou} need${m.needsYou === 1 ? 's' : ''} you`)
  return parts.join(' · ')
}
