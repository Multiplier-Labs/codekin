#!/usr/bin/env node
/**
 * Staging gate suite (docs/RELAY-HARDENING.md §7): automated isolation and
 * hardening checks against a running relay, signed in with sessions minted
 * by `relay-admin-cli mint-session` (no test-login route exists).
 *
 * Identities (each a GitHub account that has signed in once):
 *   A  owns workspace WS-A and at least one machine in it
 *   B  owns workspace WS-B
 *   C  is a member of both, and owns no machine in WS-A
 *
 *   GATE_URL=https://staging.example.com \
 *   GATE_COOKIE_A="$(node server/dist/relay/relay-admin-cli.js mint-session <id-A>)" \
 *   GATE_COOKIE_B=... GATE_COOKIE_C=... \
 *   node scripts/staging/gate.mjs [--report out.md] [--no-frontend]
 *
 * Optional: GATE_WS_A / GATE_WS_B pin the workspaces (otherwise: A's
 * workspace B isn't in, and the reverse). --no-frontend skips the checks on
 * the static app (for a relay run without its reverse proxy).
 *
 * Every probe is read-only or must be refused; a probe that is wrongly
 * accepted may change staging data, which is the point of running it there.
 * Exit code 1 if any check fails.
 */

import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const WORKSPACE_HEADER = 'X-Codekin-Workspace'

export async function runGate({ url, cookies, wsA, wsB, frontend = true, fetchImpl = fetch }) {
  const base = url.replace(/\/$/, '')
  const origin = new URL(base).origin
  const results = []
  const record = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

  const call = async (path, { as, method = 'GET', workspace, body, headers = {} } = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(as ? { cookie: cookies[as] } : {}),
        ...(workspace ? { [WORKSPACE_HEADER]: workspace } : {}),
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json = null
    try { json = await res.clone().json() } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json }
  }
  const refused = status => status === 401 || status === 403 || status === 404

  // ── Positive controls: every identity is signed in fully ────────────────
  const me = {}
  for (const who of ['A', 'B', 'C']) {
    const r = await call('/api/me', { as: who })
    const ok = r.status === 200 && r.json?.user && r.json.authLevel === 'full'
    record(`identity ${who} is signed in fully`, Boolean(ok), ok ? r.json.user.login : `status ${r.status}, authLevel ${r.json?.authLevel}`)
    me[who] = ok ? r.json : null
  }
  if (!me.A || !me.B || !me.C) return finish(results)

  const memberOf = who => new Set(me[who].workspaces.map(w => w.id))
  wsA ??= me.A.workspaces.find(w => w.role === 'owner' && !memberOf('B').has(w.id))?.id
  wsB ??= me.B.workspaces.find(w => w.role === 'owner' && !memberOf('A').has(w.id))?.id
  record('WS-A and WS-B found and disjoint for A and B', Boolean(wsA && wsB), `WS-A=${wsA} WS-B=${wsB}`)
  if (!wsA || !wsB) return finish(results)
  record('C is a member of both workspaces', memberOf('C').has(wsA) && memberOf('C').has(wsB))

  const machinesOf = async (who, workspace) => {
    const r = await call('/api/machines', { as: who, workspace })
    return r.status === 200 ? r.json.machines.map(m => m.id) : null
  }
  const machinesA = await machinesOf('A', wsA)
  record('A lists machines in WS-A (control)', Array.isArray(machinesA) && machinesA.length > 0, `${machinesA?.length ?? 0} machine(s)`)
  const ma = machinesA?.[0]

  // ── Public surface ──────────────────────────────────────────────────────
  for (const path of ['/api/health', '/api/health/live', '/api/health/ready']) {
    const r = await call(path)
    record(`${path} reports no counts`, r.status === 200 && JSON.stringify(r.json) === '{"ok":true}', JSON.stringify(r.json))
  }
  const apiCsp = (await call('/api/health')).headers.get('content-security-policy') ?? ''
  record('API responses carry a deny-all CSP', apiCsp.includes("default-src 'none'") && apiCsp.includes("frame-ancestors 'none'"), apiCsp)
  if (frontend) {
    const r = await fetchImpl(`${base}/`, { redirect: 'manual' })
    const csp = r.headers.get('content-security-policy') ?? ''
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? ''
    record('app CSP: no inline or eval script', csp.includes("default-src 'none'") && scriptSrc !== '' && !/unsafe-inline|unsafe-eval/.test(scriptSrc), csp)
    record('app CSP: cannot be framed', /frame-ancestors 'none'/.test(csp))
    record('app sends HSTS', /max-age=\d{6,}/.test(r.headers.get('strict-transport-security') ?? ''), r.headers.get('strict-transport-security') ?? 'missing')
  }

  for (const path of ['/api/machines', '/api/shares', '/api/workspaces', '/api/users', '/api/admin/stats']) {
    const r = await call(path)
    record(`anonymous ${path} is refused`, r.status === 401, `status ${r.status}`)
  }
  {
    const r = await call('/api/admin/stats', { as: 'B' })
    record('a non-operator cannot read relay stats', r.status === 403 || r.status === 401, `status ${r.status}`)
  }

  // ── Workspace isolation (REST) ──────────────────────────────────────────
  for (const path of [`/api/workspaces/${wsA}`, `/api/workspaces/${wsA}/members`, `/api/workspaces/${wsA}/machines`, `/api/workspaces/${wsA}/audit`, `/api/workspaces/${wsA}/invitations`]) {
    const r = await call(path, { as: 'B' })
    record(`B cannot read ${path.replace(wsA, 'WS-A')}`, refused(r.status), `status ${r.status}`)
  }
  {
    const r = await call('/api/machines', { as: 'B', workspace: wsA })
    record("B cannot list WS-A's machines by naming it", refused(r.status), `status ${r.status}`)
  }
  if (ma) {
    const inB = await machinesOf('B', wsB)
    record("B's WS-B machine list has none of WS-A's machines", Array.isArray(inB) && !inB.includes(ma))
    const cInB = await machinesOf('C', wsB)
    record("C's WS-B machine list has none of WS-A's machines", Array.isArray(cInB) && !cInB.includes(ma))
    const cInA = await machinesOf('C', wsA)
    record("C (member, not owner) doesn't see A's unshared machine", Array.isArray(cInA) && !cInA.includes(ma))

    const share = await call('/api/shares', {
      as: 'B', method: 'POST',
      body: { machineId: ma, localSessionId: 'gate-probe', granteeLogin: me.B.user.login, role: 'viewer' },
    })
    record("B cannot share a session on A's machine", refused(share.status) || share.status === 400, `status ${share.status}`)
    const remove = await call(`/api/machines/${encodeURIComponent(ma)}`, { as: 'B', method: 'DELETE' })
    record("B cannot remove A's machine", refused(remove.status), `status ${remove.status}`)
  }
  {
    const r = await call('/api/machines/pair/approve', { as: 'B', method: 'POST', workspace: wsA, body: { code: 'GATE-PROBE' } })
    record('B cannot pair a machine into WS-A', refused(r.status), `status ${r.status}`)
    const inv = await call(`/api/workspaces/${wsA}/invitations`, { as: 'B', method: 'POST', body: { role: 'admin', githubLogin: me.B.user.login } })
    record('B cannot invite into WS-A', refused(inv.status), `status ${inv.status}`)
  }
  {
    const r = await call('/api/shares', { as: 'A', method: 'POST', headers: { origin: 'https://evil.example' }, body: {} })
    record('a cross-origin mutation is refused (origin guard)', r.status === 403, `status ${r.status}`)
  }

  // ── Machine isolation (WebSocket) ───────────────────────────────────────
  if (ma) {
    const wsUrl = `${base.replace(/^http/, 'ws')}/relay/browser`
    const control = await helloOutcome(wsUrl, cookies.A, origin, ma)
    record("A reaches A's machine over the relay (control)", control.kind === 'hello_ack', JSON.stringify(control))
    for (const who of ['B', 'C']) {
      const r = await helloOutcome(wsUrl, cookies[who], origin, ma)
      record(`${who} cannot open A's machine over the relay`, r.kind === 'close' && r.code === 4003, JSON.stringify(r))
    }
    const crossSite = await helloOutcome(wsUrl, cookies.A, 'https://evil.example', ma)
    record('a cross-origin relay socket is refused', crossSite.kind === 'rejected' || (crossSite.kind === 'close' && crossSite.code !== 1000), JSON.stringify(crossSite))
  }

  return finish(results)
}

/** Open a browser relay socket and say hello: hello_ack, a close code, or a refused upgrade. */
function helloOutcome(wsUrl, cookie, origin, machineId) {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin } })
    const done = outcome => {
      clearTimeout(timer)
      ws.removeAllListeners()
      // terminate() on a socket still connecting emits an error; swallow it.
      ws.on('error', () => {})
      ws.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => { done({ kind: 'timeout' }) }, 10_000)
    ws.on('unexpected-response', (_req, res) => { done({ kind: 'rejected', status: res.statusCode }) })
    ws.on('open', () => { ws.send(JSON.stringify({ version: 1, kind: 'hello', payload: { machineId } })) })
    ws.on('message', data => {
      const msg = JSON.parse(String(data))
      if (msg.kind === 'hello_ack') done({ kind: 'hello_ack' })
    })
    ws.on('close', code => { done({ kind: 'close', code }) })
    ws.on('error', err => { done({ kind: 'error', message: err.message }) })
  })
}

function finish(results) {
  return { results, passed: results.every(r => r.ok) }
}

export const MANUAL_CHECKLIST = [
  'Pair a real macOS machine and a real Linux machine; open a session on each from the hosted app',
  'Invitation misuse: wrong recipient, expired, revoked and replayed links are refused',
  'Concurrent single-use: an invitation, a recovery code and a TOTP code each work once when submitted twice at the same time',
  'A viewer holding an editor share still cannot execute',
  'The last owner of a workspace cannot leave or be demoted',
  'Demote and then remove C while C has a session stream open on a WS-A machine: the stream closes within the reauthorisation interval',
  'Revoked sessions and device links do not restore access; suspension applies everywhere, removal from one workspace only there',
  'MFA recovery with a recovery code; a passkey on a phone',
]

export function renderReport({ url, results, passed, date = new Date() }) {
  const day = date.toISOString().slice(0, 10)
  const rows = results.map(r => `| ${r.ok ? 'PASS' : '**FAIL**'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 160)} |`)
  return [
    `# Staging gate — ${day}`,
    '',
    `**Relay:** ${url}`,
    `**Automated result:** ${passed ? 'PASS' : 'FAIL'} (${results.filter(r => r.ok).length}/${results.length} checks)`,
    '',
    '## Automated checks',
    '',
    '| Result | Check | Detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Manual checklist',
    '',
    'Sign off each item with initials and date.',
    '',
    ...MANUAL_CHECKLIST.map(item => `- [ ] ${item}`),
    '',
  ].join('\n')
}

async function main(argv) {
  const url = process.env.GATE_URL
  const cookies = { A: process.env.GATE_COOKIE_A, B: process.env.GATE_COOKIE_B, C: process.env.GATE_COOKIE_C }
  if (!url || !cookies.A || !cookies.B || !cookies.C) {
    console.error('Set GATE_URL and GATE_COOKIE_A/B/C (from relay-admin-cli mint-session). See the header of this file.')
    return 2
  }
  const reportFlag = argv.indexOf('--report')
  const outcome = await runGate({
    url, cookies,
    wsA: process.env.GATE_WS_A || undefined,
    wsB: process.env.GATE_WS_B || undefined,
    frontend: !argv.includes('--no-frontend'),
  })
  for (const r of outcome.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`)
  const report = renderReport({ url, ...outcome })
  if (reportFlag >= 0 && argv[reportFlag + 1]) {
    writeFileSync(argv[reportFlag + 1], report)
    console.log(`Report written to ${argv[reportFlag + 1]}`)
  }
  console.log(outcome.passed ? 'Gate: PASS (manual checklist still to sign off)' : 'Gate: FAIL')
  return outcome.passed ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, err => {
    console.error(err)
    process.exitCode = 1
  })
}
