/**
 * End to end: a real relay process in staging mode, three identities signed
 * in with mint-session, and the gate suite (scripts/staging/gate.mjs) run
 * against it. Proves the suite passes on a correct relay and that the
 * minted sessions are accepted by the real server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import WebSocket from 'ws'
import type { ChildProcess } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { createWorkspace } from './workspaces.js'
import { mintSession } from './relay-admin-cli.js'
// @ts-expect-error -- plain JS script without type declarations
import { runGate, renderReport } from '../../scripts/staging/gate.mjs'

interface GateOutcome { passed: boolean; results: Array<{ name: string; ok: boolean; detail: string }> }

const SECRET = 's'.repeat(40)

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => { resolvePort(port) })
    })
    srv.on('error', reject)
  })
}

describe('staging gate against a real relay', () => {
  let dir: string
  let relay: ChildProcess
  let url: string
  const cookies: Record<string, string> = {}

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'))
    const port = await freePort()
    url = `http://127.0.0.1:${port}`

    const db = openControlPlaneDb(join(dir, 'control-plane.db'))
    const policy = { ownerGithubId: 9, allowedGithubIds: [1, 2, 3] }
    const user = (id: number, login: string) =>
      upsertUserFromGithub(db, { id, login, name: null, email: null, avatarUrl: null }, policy)
    const a = user(1, 'gate-a')
    const b = user(2, 'gate-b')
    const c = user(3, 'gate-c')
    // Workspace owners must have a second factor; stand-in authenticators.
    for (const u of [a, b]) {
      db.prepare(`INSERT INTO user_totp (user_id, secret_enc, confirmed_at, created_at) VALUES (?, 'fixture', datetime('now'), ?)`).run(u.id, Date.now())
    }
    const wsA = createWorkspace(db, 'WS-A', a.id)
    const wsB = createWorkspace(db, 'WS-B', b.id)
    const join_ = db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')`)
    join_.run(wsA.id, c.id)
    join_.run(wsB.id, c.id)
    db.prepare(`INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('machine-a', ?, ?, 'A box')`).run(wsA.id, a.id)
    const staging = { staging: true, sessionSecret: SECRET, publicUrl: url }
    cookies.A = mintSession(db, staging, 1)!.cookie
    cookies.B = mintSession(db, staging, 2)!.cookie
    cookies.C = mintSession(db, staging, 3)!.cookie
    db.close()

    const serverDir = resolve(import.meta.dirname, '..')
    relay = spawn(process.execPath, ['--import', 'tsx', 'relay/relay-server.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        RELAY_DATA_DIR: dir,
        RELAY_ENV_FILE: join(dir, 'no-env-file'),
        RELAY_PORT: String(port),
        PUBLIC_URL: url,
        SESSION_SECRET: SECRET,
        GITHUB_CLIENT_ID: 'gate', GITHUB_CLIENT_SECRET: 'gate',
        OWNER_GITHUB_ID: '9',
        ALLOWED_GITHUB_IDS: '1,2,3',
        RELAY_STAGING: '1',
        RELAY_ERROR_DSN: '', RELAY_QUOTAS_FILE: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    relay.stderr?.on('data', d => { stderr += String(d) })
    const started = Date.now()
    for (;;) {
      try {
        if ((await fetch(`${url}/api/health/ready`)).status === 200) break
      } catch { /* not up yet */ }
      if (Date.now() - started > 20_000) throw new Error(`relay did not start: ${stderr}`)
      await new Promise(r => setTimeout(r, 200))
    }
  }, 30_000)

  afterAll(() => {
    relay.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes every automated check on a correctly configured relay', async () => {
    const outcome = (await runGate({ url, cookies, frontend: false })) as GateOutcome
    const failed = outcome.results.filter(r => !r.ok)
    expect(failed).toEqual([])
    expect(outcome.results.length).toBeGreaterThan(25)
    const report = renderReport({ url, ...outcome }) as string
    expect(report).toContain('**Automated result:** PASS')
    expect(report).toContain('## Manual checklist')
  }, 60_000)

  it('fails, rather than passing vacuously, when an identity is not signed in', async () => {
    const outcome = (await runGate({ url, cookies: { ...cookies, C: 'codekin_relay_sid=forged' }, frontend: false })) as GateOutcome
    expect(outcome.passed).toBe(false)
    expect(outcome.results.find(r => r.name === 'identity C is signed in fully')?.ok).toBe(false)
  }, 60_000)

  it('rejects malformed connector hellos without affecting readiness or authenticated clients', async () => {
    for (const payload of [null, [], { machineId: 'fixture', machineSecret: 'fixture', connectorVersion: 123 }]) {
      const ws = new WebSocket(`${url.replace('http:', 'ws:')}/relay/connector`)
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      const closed = new Promise<number>(resolve => ws.once('close', resolve))
      ws.send(JSON.stringify({ version: 1, kind: 'hello', payload }))
      expect(await closed).toBe(1008)
      expect((await fetch(`${url}/api/health/ready`)).status).toBe(200)
      expect((await fetch(`${url}/api/me`, { headers: { cookie: cookies.A } })).status).toBe(200)
    }
  })

  it('does not accept validation failures as proof of authorization', async () => {
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      if (String(input).endsWith('/api/shares') && init?.method === 'POST' && headers.get('cookie') === cookies.B) {
        return Promise.resolve(new Response('{"error":"invalid grantee"}', { status: 400 }))
      }
      return fetch(input, init)
    }
    const outcome = await runGate({ url, cookies, frontend: false, fetchImpl }) as GateOutcome
    expect(outcome.passed).toBe(false)
    expect(outcome.results.find(r => r.name === "B cannot share a session on A's machine")?.ok).toBe(false)
    expect(outcome.results.find(r => r.name === 'A can share the same session with C (control)')?.ok).toBe(true)
  })

  it('fails the share gate when a fixture bypasses authorization', async () => {
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      if (String(input).includes('/api/shares') && headers.get('cookie') === cookies.B && init?.method !== 'GET') {
        headers.set('cookie', cookies.A)
        return fetch(input, { ...init, headers })
      }
      return fetch(input, init)
    }
    const outcome = await runGate({ url, cookies, frontend: false, fetchImpl }) as GateOutcome
    expect(outcome.passed).toBe(false)
    expect(outcome.results.find(r => r.name === "B cannot share a session on A's machine")?.ok).toBe(false)
  })

  it('refuses to run mutation controls on a non-staging target', async () => {
    let calls = 0
    const fetchImpl = () => { calls++; return Promise.resolve(new Response('{"staging":false}', { status: 200 })) }
    const outcome = await runGate({ url, cookies, frontend: false, fetchImpl }) as GateOutcome
    expect(outcome.passed).toBe(false)
    expect(calls).toBe(1)
  })

  it('marks itself as staging', async () => {
    const res = await fetch(`${url}/api/auth/config`)
    expect(await res.json()).toMatchObject({ staging: true })
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })
})
