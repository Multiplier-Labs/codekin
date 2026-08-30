/** Tests for incident-response helpers — branch naming (must satisfy the spawn route's pattern) and the diagnostic task content. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildIncidentTask, incidentBranchName, type BreachPayload } from './incident-response.js'
import { runHttpProbe } from './deployment-monitor.js'
import type { DeploymentSample } from './deployment-monitor.js'

/** The branchName validation pattern from orchestrator-session-router. */
const BRANCH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/

const NOW = new Date('2026-08-30T14:30:00.000Z')

const payload: BreachPayload = {
  deploymentId: 'codekin-prod',
  deploymentName: 'Codekin Production',
  repoPath: '/srv/repos/codekin',
  probeKey: 'codekin-prod::http:https://app.example.com/health',
  probeType: 'http',
  breaches: ['http 502'],
  metrics: { status: 502, latencyMs: 120 },
}

describe('incidentBranchName', () => {
  it('produces a branch that passes the spawn route validation', () => {
    expect(incidentBranchName('codekin-prod', NOW)).toMatch(BRANCH_PATTERN)
    expect(incidentBranchName('My Weird/ID!!', NOW)).toMatch(BRANCH_PATTERN)
    expect(incidentBranchName('---', NOW)).toMatch(BRANCH_PATTERN)
  })

  it('embeds the deployment and timestamp for uniqueness', () => {
    expect(incidentBranchName('codekin-prod', NOW)).toBe('incident/codekin-prod-202608301430')
  })
})

describe('buildIncidentTask', () => {
  const sample: DeploymentSample = {
    id: 1, deploymentId: 'codekin-prod', probeKey: payload.probeKey, probeType: 'http',
    ok: false, breaches: ['http 502'], metrics: { status: 502 }, createdAt: NOW.toISOString(),
  }

  it('carries the breach evidence, report path, and operational hard constraints', () => {
    const task = buildIncidentTask(payload, [sample], NOW)
    expect(task).toContain('Codekin Production')
    expect(task).toContain('http 502')
    expect(task).toContain('.codekin/reports/incidents/2026-08-30_codekin-prod.md')
    expect(task).toContain('Do not restart services')
    expect(task).toContain('BREACHED (http 502)')
  })

  it('handles missing history gracefully', () => {
    const task = buildIncidentTask(payload, [], NOW)
    expect(task).toContain('(no history available)')
  })
})

describe('runHttpProbe security headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(headers: Record<string, string>) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    })))
  }

  it('breaches on missing HSTS/CSP when checkHeaders is set', async () => {
    stubFetch({})
    const result = await runHttpProbe({ type: 'http', url: 'https://x.test/', checkHeaders: true })
    expect(result.ok).toBe(false)
    expect(result.breaches).toEqual([
      'missing Strict-Transport-Security header',
      'missing Content-Security-Policy header',
    ])
  })

  it('passes when both headers are present, recording them as metrics', async () => {
    stubFetch({ 'strict-transport-security': 'max-age=63072000', 'content-security-policy': "default-src 'self'" })
    const result = await runHttpProbe({ type: 'http', url: 'https://x.test/', checkHeaders: true })
    expect(result.ok).toBe(true)
    expect(result.metrics).toMatchObject({ hsts: 1, csp: 1 })
  })

  it('does not check headers without the opt-in', async () => {
    stubFetch({})
    const result = await runHttpProbe({ type: 'http', url: 'https://x.test/' })
    expect(result.ok).toBe(true)
  })
})
