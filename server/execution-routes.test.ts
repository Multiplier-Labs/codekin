import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExecutionStore } from './execution-store.js'
import { ExecutionService } from './execution-service.js'
import { ExecutionClients } from './execution-auth.js'
import { createExecutionRouter } from './execution-routes.js'
import type { HarnessRunner, ProbeResult, RunOutcome } from './execution-codex-runner.js'

const sha = (t: string) => createHash('sha256').update(t).digest('hex')

class SlowRunner implements HarnessRunner {
  readonly harness = 'codex'
  delayMs = 0
  async run(_spec: unknown, signal: AbortSignal): Promise<RunOutcome> {
    await new Promise((r) => { const t = setTimeout(r, this.delayMs); signal.addEventListener('abort', () => { clearTimeout(t); r(null) }) })
    if (signal.aborted) return { ok: false, canceled: true, error: { code: 'EXECUTION_INTERRUPTED', message: 'Canceled', retryable: false, retryAfter: null } }
    return { ok: true, text: '{"ok":true}', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, billingMode: 'subscription' }
  }
  async probe(): Promise<ProbeResult> {
    return { available: true, version: '1', account: { type: 'chatgpt', planType: 'plus' }, billingMode: 'subscription', models: [], inferenceProfile: true, rateLimits: null, error: null, probedAt: new Date().toISOString() }
  }
}

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
const jobBody = (over: Record<string, unknown> = {}) => ({
  userRef: 'u1', workload: 'inbox.screen', harness: 'codex', instructions: 'Classify', input: 'mail',
  output: { type: 'json', schemaName: 's', schema }, priority: 'background',
  deadlineAt: new Date(Date.now() + 60_000).toISOString(), billingPolicy: 'subscription-only', ...over,
})

let dir: string
let clientsFile: string
let base: string
let server: Server
let store: ExecutionStore
let service: ExecutionService
let runner: SlowRunner

function writeClients(entries: unknown[]): void {
  writeFileSync(clientsFile, JSON.stringify(entries))
  // mtime resolution can be coarse; force a visible change.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000))
  utimesSync(clientsFile, t, t)
}

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; key?: string; user?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  if (opts.key) headers['idempotency-key'] = opts.key
  if (opts.user) headers['x-execution-user'] = opts.user
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'exec-routes-'))
  clientsFile = join(dir, 'clients.json')
  writeClients([
    { id: 'app', tokenSha256: sha('app-token'), harnesses: ['codex'] },
    { id: 'other', tokenSha256: sha('other-token'), harnesses: ['codex'] },
  ])
  store = new ExecutionStore(':memory:')
  runner = new SlowRunner()
  service = new ExecutionService(store, { codex: runner })
  service.start()
  const app = express()
  app.use('/api/execution/v1', createExecutionRouter(new ExecutionClients(clientsFile), service))
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/execution/v1`
      resolve()
    })
  })
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await service.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('execution routes', () => {
  it('requires an execution client token', async () => {
    expect((await call('/capabilities')).status).toBe(401)
    expect((await call('/capabilities', { token: 'admin-token-is-not-accepted' })).status).toBe(401)
    const caps = await call('/capabilities', { token: 'app-token' })
    expect(caps.status).toBe(200)
    expect(caps.body.harnesses.codex.profiles).toEqual(['inference'])
  })

  it('refuses an IP after repeated bad tokens, before looking at the token', async () => {
    for (let i = 0; i < 20; i++) expect((await call('/capabilities', { token: `guess-${i}` })).status).toBe(401)
    const blocked = await call('/capabilities', { token: 'app-token' })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
  })

  it('submits, deduplicates and long-polls a job to its result', async () => {
    runner.delayMs = 300
    const first = await call('/jobs', { method: 'POST', token: 'app-token', key: 'k1', body: jobBody() })
    expect(first.status).toBe(202)
    expect(first.body.job.status).toMatch(/queued|running/)
    const again = await call('/jobs', { method: 'POST', token: 'app-token', key: 'k1', body: jobBody() })
    expect(again).toMatchObject({ status: 200, body: { job: { id: first.body.job.id } } })
    const conflict = await call('/jobs', { method: 'POST', token: 'app-token', key: 'k1', body: jobBody({ input: 'different' }) })
    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })

    const done = await call(`/jobs/${first.body.job.id}?wait=5`, { token: 'app-token', user: 'u1' })
    expect(done.body.job).toMatchObject({ status: 'succeeded', output: { ok: true }, error: null, usage: { inputTokens: 1 } })
    expect(done.body.job.execMs).toBeGreaterThanOrEqual(0)
    expect(done.body.job).not.toHaveProperty('clientId')
  })

  it('requires an Idempotency-Key and reports bad requests', async () => {
    expect((await call('/jobs', { method: 'POST', token: 'app-token', body: jobBody() })).status).toBe(400)
    const bad = await call('/jobs', { method: 'POST', token: 'app-token', key: 'x', body: jobBody({ output: { type: 'json', schemaName: 's', schema: { type: 'string', format: 'email' } } }) })
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'UNSUPPORTED_CAPABILITY' } } })
  })

  it('hides other clients\' and other users\' jobs', async () => {
    const { body } = await call('/jobs', { method: 'POST', token: 'app-token', key: 'k', body: jobBody() })
    const id = body.job.id
    expect((await call(`/jobs/${id}`, { token: 'other-token' })).status).toBe(404)
    expect((await call(`/jobs/${id}`, { token: 'app-token', user: 'u2' })).status).toBe(404)
    expect((await call(`/jobs/${id}/cancel`, { method: 'POST', token: 'other-token' })).status).toBe(404)
    expect((await call(`/jobs/${id}`, { token: 'app-token', user: 'u1' })).status).toBe(200)
  })

  it('cancels a running job', async () => {
    runner.delayMs = 10_000
    const { body } = await call('/jobs', { method: 'POST', token: 'app-token', key: 'k', body: jobBody() })
    const id = body.job.id
    for (let i = 0; i < 50 && store.get(id)!.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10))
    const c = await call(`/jobs/${id}/cancel`, { method: 'POST', token: 'app-token' })
    expect(c.status).toBe(202)
    const done = await call(`/jobs/${id}?wait=5`, { token: 'app-token' })
    expect(done.body.job).toMatchObject({ status: 'canceled', output: null })
  })

  it('revokes a client removed from the clients file', async () => {
    expect((await call('/capabilities', { token: 'other-token' })).status).toBe(200)
    writeClients([{ id: 'app', tokenSha256: sha('app-token'), harnesses: ['codex'] }])
    expect((await call('/capabilities', { token: 'other-token' })).status).toBe(401)
    expect((await call('/capabilities', { token: 'app-token' })).status).toBe(200)
  })

  it('fails closed on a broken clients file', async () => {
    writeFileSync(clientsFile, '{not json')
    const t = new Date(Date.now() + 500000)
    utimesSync(clientsFile, t, t)
    expect((await call('/capabilities', { token: 'app-token' })).status).toBe(401)
  })
})
