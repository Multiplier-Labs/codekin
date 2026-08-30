/**
 * Incident response — turns a probe breach into a diagnostic child task.
 *
 * The autonomy model: auto-diagnosis is a per-deployment operator opt-in
 * (`autoDiagnose: true` + a linked repo), never a default. The spawned child
 * investigates and reports; it is explicitly forbidden from touching the
 * running system — restarts and host changes stay propose-only, per the
 * sudo-free / hard-floor policy.
 */

import type { DeploymentSample } from './deployment-monitor.js'

/** Payload of a `probe-breach` signal (shape published by DeploymentMonitor). */
export interface BreachPayload {
  deploymentId: string
  deploymentName: string
  repoPath: string | null
  probeKey: string
  probeType: string
  breaches?: string[]
  metrics?: Record<string, unknown>
}

/** Minimum time between auto-spawned diagnostic children for one probe. */
export const DIAGNOSE_COOLDOWN_MS = 6 * 60 * 60 * 1000

/** Branch-safe slug from a deployment id (spawn route validates the pattern). */
export function incidentBranchName(deploymentId: string, now: Date): string {
  const slug = deploymentId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'deployment'
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return `incident/${slug}-${stamp}`
}

function formatSample(s: DeploymentSample): string {
  const state = s.ok ? 'ok' : `BREACHED (${s.breaches.join('; ')})`
  return `- ${s.createdAt} — ${state} — ${JSON.stringify(s.metrics)}`
}

/** The diagnostic child's task text, carrying the breach evidence inline. */
export function buildIncidentTask(payload: BreachPayload, recentSamples: DeploymentSample[], now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return [
    `Diagnose a production probe breach for the deployment "${payload.deploymentName}".`,
    '',
    `Probe: ${payload.probeKey} (type: ${payload.probeType})`,
    `Breaches: ${(payload.breaches ?? []).join('; ') || 'unknown'}`,
    `Metrics at breach: ${JSON.stringify(payload.metrics ?? {})}`,
    '',
    'Recent probe samples (newest first):',
    ...(recentSamples.length ? recentSamples.map(formatSample) : ['- (no history available)']),
    '',
    'Do the following:',
    '1. Investigate the likely cause. Useful angles: application/process logs readable from this repo\'s deployment, recent commits and merged PRs in this repository, and whether the breach correlates with a deploy.',
    `2. Write an incident report to .codekin/reports/incidents/${date}_${payload.deploymentId}.md — symptoms, evidence, root cause (or best-supported hypothesis), impact, and remediation. The file must contain only the finished report.`,
    '3. If the root cause is a clear, low-risk fix in this repository\'s code or config, implement it on this branch. Otherwise end the report with a "Proposed remediation" section describing exactly what should be done and by whom.',
    '',
    'Hard constraints: you are diagnosing, not operating. Do not restart services, kill processes, or modify anything on the host outside this repository — those actions are operator-approved only. Do not modify the deployment registry or monitoring configuration.',
  ].join('\n')
}
