/**
 * Regression tests for the 2026-09-28 hosted isolation audit
 * (docs/HOSTED-SECURITY-AUDIT-2026-09-28.md). Each F-numbered case was a
 * working exploit at the audited commit. All data and servers are local fixtures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import session from 'express-session'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type WebSocket from 'ws'
import { executeProxyRequest } from './connector-proxy.js'
import { StreamChannel } from './connector-stream.js'
import { canonicalizePath, checkRestPolicy, isServerFrameVisible } from './connector-policy.js'
import { createSessionRouter } from '../session-routes.js'
import type { SessionManager } from '../session-manager.js'
import { openControlPlaneDb, upsertUserFromGithub, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { createShareRouter } from './share-routes.js'
import { createPairingRouter } from './pairing-routes.js'
import type { RelayConfig } from './relay-config.js'
import { toSessionUser } from './relay-auth-routes.js'
import { signInFully } from './__fixtures__/auth.js'
import { removeMember, updateMember } from './workspaces.js'
import { resolveMachineAccess, upsertShare } from './shares.js'
import { recordAuditEvent } from './audit.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function listen(app: ReturnType<typeof express>): Promise<string> {
  let server: Server
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function localMachine() {
  const data = {
    list: () => [{ id: 'shared', name: 'Shared' }, { id: 'private', name: 'Confidential', workingDir: '/private/repo' }],
    archive: { get: () => ({ id: 'private', messages: ['PRIVATE TRANSCRIPT'] }) },
    rename: vi.fn(() => true),
    delete: vi.fn(() => true),
  }
  const app = express()
  app.use(express.json())
  app.use(createSessionRouter(
    token => token === 'fixture-token',
    req => req.headers.authorization?.replace('Bearer ', ''),
    data as unknown as SessionManager,
  ))
  return { origin: await listen(app), data }
}

const principal = { userId: 'guest', role: 'grantee' as const, grants: { shared: ['view'] } }

describe('audit: proxy isolation', () => {
  it('control: canonical session list excludes the private session', async () => {
    const { origin } = await localMachine()
    const out = await executeProxyRequest({ method: 'GET', path: '/api/sessions/list', principal }, {
      target: { origin, authToken: 'fixture-token' },
    })
    expect('response' in out).toBe(true)
    if ('response' in out) expect(Buffer.from(out.response.body!, 'base64').toString()).not.toContain('Confidential')
  })

  it('F1: encoded dot segments must not expose an unshared archived transcript', async () => {
    const { origin } = await localMachine()
    const out = await executeProxyRequest({ method: 'GET', path: '/api/sessions/list/%2e%2e/archived/private', principal }, {
      target: { origin, authToken: 'fixture-token' },
    })
    const body = 'response' in out ? Buffer.from(out.response.body ?? '', 'base64').toString() : ''
    expect(body).not.toContain('PRIVATE TRANSCRIPT')
  })

  it('F1: upload permission must not allow renaming an unshared session', async () => {
    const { origin, data } = await localMachine()
    await executeProxyRequest({
      method: 'PATCH', path: '/api/upload/%2e%2e/sessions/private/rename',
      principal: { ...principal, grants: { shared: ['view', 'upload_file'] } },
      contentType: 'application/json', body: Buffer.from(JSON.stringify({ name: 'Changed by guest' })).toString('base64'),
    }, { target: { origin, authToken: 'fixture-token' } })
    expect(data.rename).not.toHaveBeenCalled()
  })

  it('F2: a trailing slash must not expose private session metadata', async () => {
    const { origin } = await localMachine()
    const out = await executeProxyRequest({ method: 'GET', path: '/api/sessions/list/', principal }, {
      target: { origin, authToken: 'fixture-token' },
    })
    const body = 'response' in out ? Buffer.from(out.response.body ?? '', 'base64').toString() : ''
    expect(body).not.toContain('Confidential')
  })

  it('F1: a view-only grantee must not delete an unshared session', async () => {
    const { origin, data } = await localMachine()
    await executeProxyRequest({ method: 'DELETE', path: '/auth-verify/%2e%2e/api/sessions/private', principal }, {
      target: { origin, authToken: 'fixture-token' },
    })
    expect(data.delete).not.toHaveBeenCalled()
  })
})

describe('audit: outbound stream isolation', () => {
  it('F3: a global prompt from a private session must not reach a grantee', () => {
    const local = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: 1 })
    const onData = vi.fn()
    const channel = new StreamChannel(
      { origin: 'http://127.0.0.1:1', authToken: 'fixture' },
      { onData, onReady: vi.fn(), onClose: vi.fn() },
      () => local as unknown as WebSocket,
      { role: 'grantee', grants: { shared: ['view'] } },
    )
    cleanup.push(() => channel.close())
    channel.open()
    local.emit('message', JSON.stringify({ type: 'connected' }))
    // Shape emitted by PromptRouter.globalBroadcast when a private session has no clients.
    const prompt = JSON.stringify({ type: 'prompt', sessionId: 'private', sessionName: 'Confidential',
      requestId: 'request-private', toolName: 'Bash', toolInput: { command: 'echo PRIVATE_SECRET' } })
    local.emit('message', prompt)
    expect(onData).not.toHaveBeenCalledWith(prompt)
  })
})

describe('audit: canonical paths', () => {
  it('refuses every spelling that could name a second route', () => {
    for (const path of [
      '/api/sessions/list/%2e%2e/archived/private', '/api/sessions/list/%2E%2E/x', '/api/sessions/list/.%2e/x',
      '/api/sessions/list/../x', '/api/sessions/./list', '/api/sessions%2flist', '/api/sessions%5clist',
      '/api//sessions/list', '//evil.example/api', '/api/sessions/list#x', '/api/sessions list', '/api\\x',
    ]) {
      expect(canonicalizePath(path), path).toBeNull()
    }
  })

  it('keeps ordinary paths and query strings intact', () => {
    expect(canonicalizePath('/api/sessions/list?x=1')).toEqual({ pathname: '/api/sessions/list', search: '?x=1' })
    expect(canonicalizePath('/api/browse-dirs?path=%2Fhome%2F..%2Fetc')?.pathname).toBe('/api/browse-dirs')
  })

  it('holds grantees to exact routes', () => {
    const grantee = { role: 'grantee' as const, grants: { shared: ['view', 'upload_file'] as never[] } }
    expect(checkRestPolicy(grantee, 'GET', '/api/sessions/list').allowed).toBe(true)
    expect(checkRestPolicy(grantee, 'GET', '/api/sessions/list?x=1').allowed).toBe(true)
    expect(checkRestPolicy(grantee, 'POST', '/api/upload').allowed).toBe(true)
    for (const [method, path] of [
      ['GET', '/api/sessions/list/'], ['GET', '/api/sessions/LIST'], ['GET', '/api/sessions/list/x'],
      ['POST', '/api/upload/x'], ['DELETE', '/auth-verify/x'], ['DELETE', '/auth-verify'], ['GET', '/api/health/x'],
    ]) {
      expect(checkRestPolicy(grantee, method, path).allowed, `${method} ${path}`).toBe(false)
    }
  })
})

describe('audit: outbound frame visibility', () => {
  function grantee(onData = vi.fn()) {
    const local = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: 1 })
    const channel = new StreamChannel(
      { origin: 'http://127.0.0.1:1', authToken: 'fixture' },
      { onData, onReady: vi.fn(), onClose: vi.fn() },
      () => local as unknown as WebSocket,
      { role: 'grantee', grants: { shared: ['view'], other: ['view'] } },
    )
    cleanup.push(() => channel.close())
    channel.open()
    local.emit('message', JSON.stringify({ type: 'connected' }))
    return { local, channel, onData }
  }

  it('relays the joined session and untagged notices, nothing else', () => {
    const { local, channel, onData } = grantee()
    channel.send(JSON.stringify({ type: 'join_session', sessionId: 'shared' }))
    const own = JSON.stringify({ type: 'prompt', sessionId: 'shared', requestId: 'r1', toolName: 'Bash' })
    const untagged = JSON.stringify({ type: 'output', data: 'hello' })
    const notice = JSON.stringify({ type: 'sessions_updated' })
    const otherShared = JSON.stringify({ type: 'prompt', sessionId: 'other', requestId: 'r2', toolName: 'Bash' })
    const webhook = JSON.stringify({ type: 'webhook_event', repo: 'private/repo', sessionId: 'shared' })
    for (const f of [own, untagged, notice, otherShared, webhook, 'not json']) local.emit('message', f)
    expect(onData.mock.calls.map(c => c[0])).toEqual([own, untagged, notice])
  })

  it('relay-side check refuses frames for sessions outside the grant', () => {
    const grants = { shared: ['view' as const] }
    expect(isServerFrameVisible(grants, JSON.stringify({ type: 'prompt', sessionId: 'private' }))).toBe(false)
    expect(isServerFrameVisible(grants, JSON.stringify({ type: 'prompt', sessionId: 'toString' }))).toBe(false)
    expect(isServerFrameVisible(grants, JSON.stringify({ type: 'webhook_event' }))).toBe(false)
    expect(isServerFrameVisible(grants, JSON.stringify({ type: 'prompt', sessionId: 'shared' }))).toBe(true)
    expect(isServerFrameVisible(grants, JSON.stringify({ type: 'sessions_updated' }))).toBe(true)
  })
})

async function controlPlane() {
  const db = openControlPlaneDb(':memory:')
  cleanup.push(() => db.close())
  const policy = { ownerGithubId: 1, allowedGithubIds: [2, 3] }
  const users = [1, 2, 3].map(id => upsertUserFromGithub(db,
    { id, login: `user${id}`, name: null, email: null, avatarUrl: null }, policy))
  const [, owner, guest] = users
  db.prepare(`INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('machine', ?, ?, 'Box')`)
    .run(BOOTSTRAP_WORKSPACE_ID, owner.id)
  const app = express()
  app.use(express.json())
  app.use(session({ secret: 'audit-fixture-secret-only', resave: false, saveUninitialized: false }))
  app.use((req, _res, next) => {
    req.session.user = toSessionUser(owner)
    signInFully(db, req.session, owner.id)
    next()
  })
  app.use(createShareRouter(db))
  app.use(createPairingRouter(db, { ...policy, publicUrl: 'http://localhost' } as RelayConfig))
  return { db, owner, guest, origin: await listen(app) }
}

describe('audit: membership lifecycle', () => {
  it('F4: a removed member must not read other users audit events on their quarantined machine', async () => {
    const { db, owner, guest, origin } = await controlPlane()
    expect(removeMember(db, BOOTSTRAP_WORKSPACE_ID, owner.id).ok).toBe(true)
    expect(resolveMachineAccess(db, owner, 'machine').kind).toBe('none')
    recordAuditEvent(db, { kind: 'access_denied', machineId: 'machine', actorUserId: guest.id, ip: '192.0.2.42' })
    const res = await fetch(`${origin}/api/audit-events?machineId=machine`)
    expect(await res.text()).not.toContain('192.0.2.42')
  })

  it('F4: CSV export must also deny a removed member', async () => {
    const { db, owner, guest, origin } = await controlPlane()
    expect(removeMember(db, BOOTSTRAP_WORKSPACE_ID, owner.id).ok).toBe(true)
    recordAuditEvent(db, { kind: 'access_denied', machineId: 'machine', actorUserId: guest.id, ip: '192.0.2.42' })
    const res = await fetch(`${origin}/api/audit-events/export?machineId=machine`)
    expect(await res.text()).not.toContain('192.0.2.42')
  })

  it('F5: a demoted viewer must not elevate an existing session share', async () => {
    const { db, owner, guest, origin } = await controlPlane()
    const share = upsertShare(db, { machineId: 'machine', localSessionId: 'shared', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'] })
    expect(updateMember(db, BOOTSTRAP_WORKSPACE_ID, owner.id, { role: 'viewer' }).ok).toBe(true)
    expect(resolveMachineAccess(db, owner, 'machine').kind).toBe('none')
    await fetch(`${origin}/api/shares/${share.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['view', 'approve_shell'] }) })
    const access = resolveMachineAccess(db, guest, 'machine')
    expect(access.kind === 'grantee' ? access.grants.shared : []).not.toContain('approve_shell')
  })

  it('F6: a removed member must not delete a quarantined workspace machine', async () => {
    const { db, owner, origin } = await controlPlane()
    expect(removeMember(db, BOOTSTRAP_WORKSPACE_ID, owner.id).ok).toBe(true)
    const res = await fetch(`${origin}/api/machines/machine`, { method: 'DELETE' })
    expect([403, 404]).toContain(res.status)
  })

  it('control: an owner in good standing can still read audit events, update shares and remove their machine', async () => {
    const { db, owner, guest, origin } = await controlPlane()
    recordAuditEvent(db, { kind: 'access_denied', machineId: 'machine', actorUserId: guest.id, ip: '192.0.2.42' })
    expect(await (await fetch(`${origin}/api/audit-events?machineId=machine`)).text()).toContain('192.0.2.42')
    const share = upsertShare(db, { machineId: 'machine', localSessionId: 'shared', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'] })
    const patched = await fetch(`${origin}/api/shares/${share.id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: ['view', 'approve_shell'] }) })
    expect(patched.status).toBe(200)
    expect((await fetch(`${origin}/api/machines/machine`, { method: 'DELETE' })).status).toBe(200)
  })

  it('a demoted creator may still revoke their share', async () => {
    const { db, owner, guest, origin } = await controlPlane()
    const share = upsertShare(db, { machineId: 'machine', localSessionId: 'shared', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'] })
    expect(updateMember(db, BOOTSTRAP_WORKSPACE_ID, owner.id, { role: 'viewer' }).ok).toBe(true)
    expect((await fetch(`${origin}/api/shares/${share.id}`, { method: 'DELETE' })).status).toBe(200)
  })
})
