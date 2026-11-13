/**
 * Standing authority (signed-intents spec §6.2) is classified by route
 * prefix: every create or change under the automation prefixes needs the
 * passkey unless STANDING_EXEMPT names it. These tests walk the routers the
 * local server really registers, so a new route there can't slip through as
 * "not privileged" without a deliberate change here.
 */
import { describe, it, expect } from 'vitest'
import type { Router } from 'express'
import { createAutomationRouter } from '../automation-routes.js'
import { createMaintenanceRouter } from '../maintenance-routes.js'
import { createWorkflowRouter } from '../workflow-routes.js'
import { createDeploymentRouter } from '../deployment-routes.js'
import { createWebhookSetupRouter } from '../webhook-setup-routes.js'
import { frameStepUpReason, requestNeedsStepUp, requestStepUpReason, standingRouteReason } from './intent-actions.js'

const stub = {} as never
const yes = () => true

/** Every route a router registers, as `METHOD /path` with `:params` filled in. */
function routesOf(router: Router, mount = ''): string[] {
  const out: string[] = []
  for (const layer of (router as unknown as { stack: Array<{ route?: { path: string | string[]; methods: Record<string, boolean> } }> }).stack) {
    if (!layer.route) continue
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
    for (const path of paths) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on && method !== '_all') out.push(`${method.toUpperCase()} ${mount}${path.replace(/:[A-Za-z]+/g, 'x1')}`)
      }
    }
  }
  return out
}

const mounted: string[] = [
  ...routesOf(createAutomationRouter(yes, () => 'user' as never, stub)),
  ...routesOf(createMaintenanceRouter(yes, () => 'user' as never, stub, yes)),
  ...routesOf(createWorkflowRouter(yes, () => 'token', undefined, undefined, { automations: stub }), '/api/workflows'),
  ...routesOf(createDeploymentRouter(yes, () => 'token'), '/api/deployments'),
  ...routesOf(createWebhookSetupRouter(yes, () => 'token', () => stub)),
]

const mutating = mounted.filter(r => /^(POST|PUT|PATCH) /.test(r))

/**
 * The automation-prefix routes that are deliberately NOT standing: they run
 * something once, check something, or only stop or remove. Adding a route
 * here is a security decision.
 */
const EXPECTED_NOT_STANDING = new Set([
  'POST /api/orchestrator/automations/workflows/validate',
  'POST /api/orchestrator/automations/runs',
  'POST /api/orchestrator/automations/x1/trigger',
  'POST /api/orchestrator/automations/x1/remove',
  'POST /api/orchestrator/maintenance/pause',
  'POST /api/orchestrator/maintenance/off',
  'POST /api/orchestrator/maintenance/activity',
  'POST /api/orchestrator/maintenance/responsibilities/x1/remove',
  'POST /api/workflows/schedules/x1/trigger',
  'POST /api/integrations/github/pr-review/test',
  // Outside the standing prefixes: one-off runs and events (deferred: a
  // confirmed device may already start an unprompted session, §6.2).
  'POST /api/workflows/commit-event',
  'POST /api/workflows/runs',
  'POST /api/workflows/runs/x1/cancel',
])

const split = (r: string) => r.split(' ') as [string, string]

describe('standing-authority classification (§6.2)', () => {
  it('found the routers it walks', () => {
    expect(mutating).toContain('POST /api/orchestrator/automations')
    expect(mutating).toContain('POST /api/orchestrator/maintenance/enable')
    expect(mutating).toContain('PATCH /api/workflows/schedules/x1')
    expect(mutating).toContain('POST /api/deployments/')
    expect(mutating).toContain('POST /api/integrations/github/pr-review/setup')
  })

  it('treats every create or change there as standing, except the reviewed list', () => {
    const notStanding = mutating.filter(r => standingRouteReason(...split(r), new TextEncoder().encode('{}')) === null)
    expect(new Set(notStanding)).toEqual(EXPECTED_NOT_STANDING)
  })

  it('covers the routes the audit found unclassified', () => {
    const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    for (const [m, p, body] of [
      ['POST', '/api/orchestrator/automations', { repo: '/r', kind: 'k', cronExpression: '0 * * * *' }],
      ['PATCH', '/api/orchestrator/automations/a1', { customPrompt: 'x' }],
      ['POST', '/api/orchestrator/maintenance/enable', { repo: '/r' }],
      ['POST', '/api/orchestrator/maintenance/resume', { repo: '/r' }],
      ['POST', '/api/orchestrator/maintenance/release', { automationId: 'a1' }],
      ['POST', '/api/integrations/github/pr-review/setup', { repo: 'o/r', webhookUrl: 'https://example.com/hook' }],
      ['POST', '/api/deployments', { id: 'd', autoDiagnose: true }],
      ['PATCH', '/api/deployments/d', { autoDiagnose: true }],
    ] as const) {
      expect(requestNeedsStepUp(m, p, json(body)), `${m} ${p}`).toBe(true)
      expect(requestStepUpReason(m, p, json(body)), `${m} ${p}`).toBe('automation')
    }
  })

  it('lets the PR-review setup preview without a passkey, only for dryRun: true', () => {
    const path = '/api/integrations/github/pr-review/setup'
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(standingRouteReason('POST', path, enc('{"repo":"o/r","webhookUrl":"u","dryRun":true}'))).toBeNull()
    for (const body of ['{"dryRun":1}', '{"dryRun":"true"}', '{"dryRun":false}', '{}', 'not json']) {
      expect(standingRouteReason('POST', path, enc(body)), body).toBe('automation')
    }
    expect(standingRouteReason('POST', path, new Uint8Array([0xff, 0xfe]))).toBe('automation')
    expect(standingRouteReason('POST', path, null)).toBe('automation')
  })

  it('matches routes the way Express does, and never counts DELETE or reads', () => {
    expect(standingRouteReason('post', '/API/Orchestrator/Automations/', null)).toBe('automation')
    expect(standingRouteReason('POST', '/api/orchestrator/automations?x=1', null)).toBe('automation')
    expect(standingRouteReason('DELETE', '/api/workflows/schedules/x1', null)).toBeNull()
    expect(standingRouteReason('GET', '/api/orchestrator/automations', null)).toBeNull()
    expect(standingRouteReason('POST', '/api/orchestrator/trust/pin', null)).toBe('standing-approval')
    expect(standingRouteReason('POST', '/api/orchestrator/trust/reset', null)).toBeNull()
  })

  it('names pre-approved tools, not bypass, when a create has both', () => {
    const both = { permissionMode: 'bypassPermissions', allowedTools: ['Bash'] }
    expect(frameStepUpReason(JSON.stringify({ type: 'create_session', name: 'n', workingDir: '/w', ...both }))).toBe('allowed-tools')
    expect(requestStepUpReason('POST', '/api/sessions/create', new TextEncoder().encode(JSON.stringify(both)))).toBe('allowed-tools')
    expect(frameStepUpReason(JSON.stringify({ type: 'create_session', name: 'n', workingDir: '/w', permissionMode: 'bypassPermissions' }))).toBe('bypass')
  })
})
