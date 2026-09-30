/**
 * Tests for the automation API behind Joe's workflow tools, and for the
 * loader helpers it relies on (effective definitions, validation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AutomationChangeLog } from './automation-changes.js'
import { AutomationService } from './automation-service.js'
import { createAutomationRouter } from './automation-routes.js'
import { listEffectiveWorkflows, validateWorkflowDefinition } from './workflow-loader.js'
import type { WorkflowConfig } from './workflow-config.js'

function definition(kind: string, prompt = 'Review the code.'): string {
  return [
    '---',
    `kind: ${kind}`,
    `name: ${kind} review`,
    'sessionPrefix: review',
    'outputDir: .codekin/reports/custom',
    'filenameSuffix: _custom.md',
    'commitMessage: chore: custom review',
    '---',
    prompt,
  ].join('\n')
}

describe('workflow definitions', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'codekin-wf-'))
    mkdirSync(join(repo, '.codekin', 'workflows'), { recursive: true })
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reports built-ins, repo overrides and repo-only kinds with their source', () => {
    writeFileSync(join(repo, '.codekin', 'workflows', 'security-audit.weekly.md'), definition('security-audit.weekly', 'Focus on auth.'))
    writeFileSync(join(repo, '.codekin', 'workflows', 'perf-audit.md'), definition('perf-audit'))
    const workflows = listEffectiveWorkflows(repo)
    expect(workflows.find(w => w.kind === 'security-audit.weekly')).toMatchObject({ source: 'override', prompt: 'Focus on auth.', builtinPath: expect.stringContaining('security-audit.weekly.md') })
    expect(workflows.find(w => w.kind === 'perf-audit')).toMatchObject({ source: 'repo' })
    expect(workflows.find(w => w.kind === 'code-review.daily')).toMatchObject({ source: 'builtin' })
    expect(listEffectiveWorkflows().some(w => w.kind === 'perf-audit')).toBe(false)
  })

  it('ignores an override whose filename does not match its kind (runs would not load it)', () => {
    writeFileSync(join(repo, '.codekin', 'workflows', 'security.md'), definition('security-audit.weekly', 'Focus on auth.'))
    expect(listEffectiveWorkflows(repo).find(w => w.kind === 'security-audit.weekly')?.source).toBe('builtin')
  })

  it('validates proposed definitions and describes their effect', () => {
    expect(validateWorkflowDefinition(definition('perf-audit'), { repoPath: repo, filename: 'perf-audit.md' }))
      .toMatchObject({ valid: true, effect: 'new-kind', kind: 'perf-audit' })
    expect(validateWorkflowDefinition(definition('security-audit.weekly'), { repoPath: repo }))
      .toMatchObject({ valid: true, effect: 'override-builtin', warnings: [expect.stringMatching(/Overrides the built-in/)] })
    expect(validateWorkflowDefinition(definition('perf-audit'), { filename: 'perf.md' }).errors[0]).toMatch(/must be named perf-audit.md/)
    expect(validateWorkflowDefinition('no frontmatter').valid).toBe(false)
    expect(validateWorkflowDefinition(definition('x').replace('outputDir: .codekin/reports/custom', 'outputDir: ../../etc')).valid).toBe(false)
  })
})

describe('automation routes', () => {
  let server: Server
  let baseUrl: string
  let config: WorkflowConfig
  let changes: AutomationChangeLog
  let repo: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'codekin-auto-'))
    config = { reviewRepos: [] }
    changes = new AutomationChangeLog(':memory:')
    const service = new AutomationService({
      config: {
        load: () => config,
        add: (r) => { config.reviewRepos.push(r) },
        update: (id, patch) => {
          const i = config.reviewRepos.findIndex(r => r.id === id)
          config.reviewRepos[i] = { ...config.reviewRepos[i], ...patch }
        },
        remove: (id) => { config.reviewRepos = config.reviewRepos.filter(r => r.id !== id) },
      },
      engine: () => null,
      sync: () => {},
      resolveRepo: (p) => p,
      workflows: (r) => listEffectiveWorkflows(r),
      changes,
    })
    const app = express()
    app.use(express.json())
    // "user-token" is the user; any other valid token is Joe.
    app.use(createAutomationRouter(
      (req) => ['Bearer user-token', 'Bearer joe-token'].includes(req.headers.authorization ?? ''),
      (req) => (req.headers.authorization === 'Bearer user-token' ? 'user' : 'joe'),
      service,
    ))
    server = app.listen(0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orchestrator/automations`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(repo, { recursive: true, force: true })
  })

  const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${init.token ?? 'joe-token'}`, 'Content-Type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })

  it('rejects unauthenticated requests', async () => {
    expect((await call('', { token: 'wrong' })).status).toBe(401)
  })

  it('requires Joe to give a reason and an idempotency key', async () => {
    const res = await call('', { method: 'POST', body: { repo, kind: 'security-audit.weekly', cronExpression: '0 9 * * 1' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/idempotencyKey/)
  })

  it('creates, conflict-checks, disables and removes an automation, attributing each change', async () => {
    const created = await call('', {
      method: 'POST',
      body: { repo, kind: 'security-audit.weekly', cronExpression: '0 9 * * 1', reason: 'user asked', idempotencyKey: 'create-001', originSessionId: 'sess-1' },
    })
    expect(created.status).toBe(200)
    const { automation } = await created.json() as { automation: { id: string; revision: number } }

    const duplicate = await call('', {
      method: 'POST',
      body: { repo, kind: 'security-audit.weekly', cronExpression: '0 10 * * 1', reason: 'again', idempotencyKey: 'create-002' },
    })
    expect(duplicate.status).toBe(409)

    const noRevision = await call(`/${automation.id}`, { method: 'PATCH', body: { enabled: false, reason: 'pause', idempotencyKey: 'upd-001' } })
    expect(noRevision.status).toBe(400)

    // The user edits it in the Automations UI meanwhile — Joe's revision is now stale.
    expect((await call(`/${automation.id}`, { method: 'PATCH', token: 'user-token', body: { cronExpression: '0 8 * * 1' } })).status).toBe(200)
    const stale = await call(`/${automation.id}`, { method: 'PATCH', body: { enabled: false, expectedRevision: 1, reason: 'pause', idempotencyKey: 'upd-002' } })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ currentRevision: 2 })

    const disabled = await call(`/${automation.id}`, { method: 'PATCH', body: { enabled: false, expectedRevision: 2, reason: 'pause', idempotencyKey: 'upd-003' } })
    expect(await disabled.json()).toMatchObject({ automation: { enabled: false, revision: 3 }, change: { action: 'disable' } })

    const removed = await call(`/${automation.id}/remove`, { method: 'POST', body: { expectedRevision: 3, reason: 'done', idempotencyKey: 'rm-001' } })
    expect(removed.status).toBe(200)

    const history = await call(`/changes?automationId=${automation.id}`)
    const actors = ((await history.json()) as { changes: { action: string; actor: string }[] }).changes.map(c => `${c.actor}:${c.action}`)
    expect(actors).toEqual(['joe:remove', 'joe:disable', 'user:update', 'joe:create'])
  })

  it('validates the definition file in the repo and says whether runs would use it', async () => {
    mkdirSync(join(repo, '.codekin', 'workflows'), { recursive: true })
    const missing = await call('/workflows/validate', { method: 'POST', body: { repo, kind: 'perf-audit' } })
    expect(await missing.json()).toMatchObject({ validation: { valid: false, errors: [expect.stringMatching(/is the change merged/)] } })

    writeFileSync(join(repo, '.codekin', 'workflows', 'perf-audit.md'), definition('perf-audit'))
    const merged = await call('/workflows/validate', { method: 'POST', body: { repo, kind: 'perf-audit' } })
    expect(await merged.json()).toMatchObject({ validation: { valid: true }, source: 'repo-file', active: true })

    const proposed = await call('/workflows/validate', { method: 'POST', body: { content: 'not a workflow' } })
    expect(await proposed.json()).toMatchObject({ validation: { valid: false }, source: 'proposed' })
  })

  it('lists workflows without their prompts and reports an unavailable engine on trigger', async () => {
    const list = await call(`/workflows?repo=${encodeURIComponent(repo)}`)
    const { workflows } = await list.json() as { workflows: { kind: string; prompt?: string }[] }
    expect(workflows.length).toBeGreaterThan(0)
    expect(workflows[0].prompt).toBeUndefined()

    const trigger = await call('/runs', { method: 'POST', body: { kind: 'security-audit.weekly', input: { repoPath: repo } } })
    expect(trigger.status).toBe(409)
  })
})
