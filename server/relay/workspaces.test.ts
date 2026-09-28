/**
 * Workspace boundary (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 1):
 * migration of a single-org database, the capability matrix, cross-workspace
 * isolation, and the membership lifecycle (last owner, removal, quarantine).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import express from 'express'
import session from 'express-session'
import BetterSqlite3 from 'better-sqlite3'
import type Database from 'better-sqlite3'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BOOTSTRAP_WORKSPACE_ID, getUserById, openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import type { UserRow, WorkspaceRole } from './control-plane-db.js'
import { can, createWorkspace, getActiveMembership, listUserWorkspaces, updateMember } from './workspaces.js'
import type { WorkspaceAction } from './workspaces.js'
import { createWorkspaceRouter, WORKSPACE_HEADER } from './workspace-routes.js'
import { createMachineRouter } from './machine-routes.js'
import { createShareRouter } from './share-routes.js'
import { createPairingRouter } from './pairing-routes.js'
import { toSessionUser } from './relay-auth-routes.js'
import { resolveMachineAccess, upsertShare } from './shares.js'
import { listAuditEvents, recordAuditEvent } from './audit.js'
import { BrowserHub } from './browser-hub.js'
import type { RelayConfig } from './relay-config.js'

const config = { publicUrl: 'https://relay.test', ownerGithubId: 1, allowedGithubIds: [] } as unknown as RelayConfig

describe('migration to workspaces', () => {
  it('turns the organization into a workspace and global roles into memberships', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-ws-'))
    const path = join(dir, 'control-plane.db')
    // A version-0 database as the relay wrote it before workspaces.
    openControlPlaneDb(':memory:').close()
    const legacy = new BetterSqlite3(path)
    legacy.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE users (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        github_id INTEGER UNIQUE NOT NULL, login TEXT NOT NULL, display_name TEXT, email TEXT, avatar_url TEXT,
        role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE web_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
      CREATE TABLE machines (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        owner_user_id TEXT NOT NULL REFERENCES users(id), display_name TEXT NOT NULL, hostname TEXT, platform TEXT,
        connector_version TEXT, local_codekin_version TEXT, status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE session_shares (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
        machine_id TEXT NOT NULL REFERENCES machines(id), local_session_id TEXT NOT NULL,
        shared_by_user_id TEXT NOT NULL REFERENCES users(id), grantee_user_id TEXT REFERENCES users(id),
        permissions TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT);
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, kind TEXT NOT NULL,
        actor_user_id TEXT, machine_id TEXT, local_session_id TEXT, ip TEXT, user_agent TEXT, metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO organizations (id, name) VALUES ('org-default', 'Multiplier Labs');
      INSERT INTO users (id, organization_id, github_id, login, role, status) VALUES
        ('u-owner', 'org-default', 1, 'owner', 'owner', 'active'),
        ('u-admin', 'org-default', 2, 'admin', 'admin', 'active'),
        ('u-viewer', 'org-default', 3, 'viewer', 'viewer', 'active'),
        ('u-off', 'org-default', 4, 'off', 'member', 'disabled'),
        ('u-pending', 'org-default', 5, 'pending', 'member', 'pending');
      INSERT INTO machines (id, organization_id, owner_user_id, display_name) VALUES ('m1', 'org-default', 'u-owner', 'Box');
      INSERT INTO session_shares (id, organization_id, machine_id, local_session_id, shared_by_user_id, grantee_user_id, permissions)
        VALUES ('s1', 'org-default', 'm1', 'sess', 'u-owner', 'u-admin', '["view"]');
      INSERT INTO audit_events (organization_id, kind, actor_user_id) VALUES ('org-default', 'machine_paired', 'u-owner');
    `)
    legacy.close()

    const db = openControlPlaneDb(path)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(db.prepare('SELECT user_id, role FROM workspace_memberships ORDER BY user_id').all()).toEqual([
      { user_id: 'u-admin', role: 'admin' },
      { user_id: 'u-off', role: 'member' },
      { user_id: 'u-owner', role: 'owner' },
      { user_id: 'u-viewer', role: 'viewer' },
    ])
    const userColumns = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(c => c.name)
    expect(userColumns).not.toContain('role')
    expect(userColumns).not.toContain('organization_id')
    expect(db.prepare('SELECT workspace_id FROM machines').get()).toEqual({ workspace_id: 'org-default' })
    expect(db.prepare('SELECT workspace_id FROM session_shares').get()).toEqual({ workspace_id: 'org-default' })
    expect(listAuditEvents(db, { workspaceId: 'org-default' }).map(e => e.kind)).toEqual(['machine_paired'])
    expect(db.pragma('foreign_key_check')).toEqual([])
    // Existing access survives the move.
    expect(resolveMachineAccess(db, getUserById(db, 'u-owner')!, 'm1').kind).toBe('owner')
    expect(resolveMachineAccess(db, getUserById(db, 'u-admin')!, 'm1').kind).toBe('grantee')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('capability matrix', () => {
  const cases: Array<[WorkspaceAction, WorkspaceRole[]]> = [
    ['machine.pair', ['owner', 'admin', 'member']],
    ['machine.oversee', ['owner', 'admin']],
    ['member.manage', ['owner', 'admin']],
    ['member.manage_privileged', ['owner']],
    ['workspace.delete', ['owner']],
  ]
  it.each(cases)('%s is granted to exactly %j', (action, allowed) => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as WorkspaceRole[]) {
      expect(can(role, action)).toBe(allowed.includes(role))
    }
    expect(can(undefined, action)).toBe(false)
  })
})

class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  closeCode: number | null = null
  send(): void {}
  close(code?: number): void {
    this.closeCode = code ?? 1000
    this.readyState = 3
    this.emit('close')
  }
}

describe('workspace boundary', () => {
  let db: Database.Database
  let server: Server
  let base: string
  let hub: BrowserHub
  const reauthorize = vi.fn()
  // Personas: alice owns workspace A (bootstrap), bob owns B, carol is in both.
  let alice: UserRow
  let bob: UserRow
  let carol: UserRow
  let dave: UserRow
  let wsA: string
  let wsB: string

  const addUser = (id: number, login: string) =>
    upsertUserFromGithub(db, { id, login, name: null, email: null, avatarUrl: null }, {
      ownerGithubId: 1,
      allowedGithubIds: [],
    })
  const addMember = (workspaceId: string, user: UserRow, role: WorkspaceRole) =>
    db.prepare('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (?, ?, ?)').run(workspaceId, user.id, role)
  const addMachine = (id: string, workspaceId: string, owner: UserRow) =>
    db.prepare('INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES (?, ?, ?, ?)').run(id, workspaceId, owner.id, id)

  async function call(
    who: UserRow,
    path: string,
    opts: { method?: string; body?: unknown; workspace?: string } = {},
  ): Promise<Response> {
    return fetch(base + path, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': who.id,
        ...(opts.workspace ? { [WORKSPACE_HEADER]: opts.workspace } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
  }

  beforeEach(async () => {
    reauthorize.mockClear()
    db = openControlPlaneDb(':memory:')
    alice = addUser(1, 'alice') // operator; owner of the bootstrap workspace
    bob = addUser(2, 'bob')
    carol = addUser(3, 'carol')
    dave = addUser(4, 'dave')
    db.prepare(`UPDATE users SET status = 'active'`).run()
    ;[alice, bob, carol, dave] = [alice, bob, carol, dave].map(u => getUserById(db, u.id)!)
    wsA = BOOTSTRAP_WORKSPACE_ID
    wsB = createWorkspace(db, 'Bob Co', bob.id).id
    addMember(wsA, carol, 'member')
    addMember(wsB, carol, 'member')
    addMember(wsA, dave, 'admin')
    addMachine('mA', wsA, alice)
    addMachine('mB', wsB, bob)
    addMachine('mCarolA', wsA, carol)

    hub = new BrowserHub(db, { isOnline: () => true, sendRequest: () => Promise.resolve({ response: { status: 200, body: '{}' } }), closeChannel: () => {} } as never)
    const hubSpy = { reauthorize: (f: unknown) => { reauthorize(f); hub.reauthorize(f as never) } } as unknown as BrowserHub

    const app = express()
    app.use(express.json())
    app.use(session({ secret: 's'.repeat(32), resave: false, saveUninitialized: false }))
    app.use((req, _res, next) => {
      const id = req.headers['x-test-user']
      if (typeof id === 'string') req.session.user = toSessionUser(getUserById(db, id)!)
      next()
    })
    app.use(createWorkspaceRouter({ db, config, browserHub: hubSpy }))
    app.use(createMachineRouter(db))
    app.use(createShareRouter(db, hubSpy))
    app.use(createPairingRouter(db, config))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    hub.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    db.close()
  })

  describe('isolation', () => {
    it('lists only the current workspace’s machines, chosen by header', async () => {
      const inA = (await (await call(carol, '/api/machines', { workspace: wsA })).json()) as { machines: Array<{ id: string }> }
      expect(inA.machines.map(m => m.id)).toEqual(['mCarolA'])
      const inB = (await (await call(bob, '/api/machines', { workspace: wsB })).json()) as { machines: Array<{ id: string }> }
      expect(inB.machines.map(m => m.id)).toEqual(['mB'])
    })

    it('refuses a workspace header the caller is not a member of', async () => {
      expect((await call(alice, '/api/machines', { workspace: wsB })).status).toBe(403)
      expect((await call(alice, '/api/shares', { workspace: wsB })).status).toBe(403)
    })

    it('falls back to the default workspace without a header', async () => {
      const res = (await (await call(bob, '/api/machines')).json()) as { workspaceId: string }
      expect(res.workspaceId).toBe(wsB)
    })

    it('never grants access to a machine in a workspace the user is not in', () => {
      // A share row pointing across the boundary (e.g. from before
      // workspaces, or written by a bug) confers nothing.
      upsertShare(db, { machineId: 'mB', localSessionId: 's', sharedByUserId: bob.id, granteeUserId: alice.id, permissions: ['view'] })
      expect(resolveMachineAccess(db, alice, 'mB').kind).toBe('none')
    })

    it('resolves share grantees only among the machine’s workspace members', async () => {
      const res = await call(bob, '/api/shares', {
        method: 'POST',
        body: { machineId: 'mB', localSessionId: 's', granteeLogin: 'alice', role: 'viewer' },
      })
      expect(res.status).toBe(404)
      const ok = await call(bob, '/api/shares', {
        method: 'POST',
        body: { machineId: 'mB', localSessionId: 's', granteeUserId: carol.id, role: 'viewer' },
      })
      expect(ok.status).toBe(201)
      expect(resolveMachineAccess(db, carol, 'mB').kind).toBe('grantee')
    })

    it('creates paired machines in the header’s workspace', async () => {
      const res = await call(carol, '/api/machines/pair/precreate', { method: 'POST', body: {}, workspace: wsB })
      const { machineId } = (await res.json()) as { machineId: string }
      expect(db.prepare('SELECT workspace_id FROM machines WHERE id = ?').get(machineId)).toEqual({ workspace_id: wsB })
    })

    it('hides workspaces the caller does not belong to', async () => {
      expect((await call(alice, `/api/workspaces/${wsB}`)).status).toBe(404)
      expect((await call(alice, `/api/workspaces/${wsB}/members`)).status).toBe(404)
      expect((await call(alice, `/api/workspaces/${wsB}/audit`)).status).toBe(404)
    })

    it('scopes the workspace audit log', async () => {
      recordAuditEvent(db, { kind: 'machine_connected', machineId: 'mA' })
      recordAuditEvent(db, { kind: 'machine_connected', machineId: 'mB' })
      const res = (await (await call(alice, `/api/workspaces/${wsA}/audit`)).json()) as { events: Array<{ machineId: string }> }
      expect(res.events.map(e => e.machineId)).toEqual(['mA'])
      expect((await call(carol, `/api/workspaces/${wsA}/audit`)).status).toBe(403)
    })

    it('closes a browser socket for a machine outside the user’s workspaces', () => {
      const socket = new FakeSocket()
      hub.handleConnection(socket as never, toSessionUser(alice), null)
      socket.emit('message', JSON.stringify({ version: 1, kind: 'hello', payload: { machineId: 'mB' } }))
      expect(socket.closeCode).toBe(4003)
    })
  })

  describe('workspaces', () => {
    it('lets only permitted accounts create workspaces; the creator owns it', async () => {
      expect((await call(carol, '/api/workspaces', { method: 'POST', body: { name: 'Carol' } })).status).toBe(403)
      db.prepare('UPDATE users SET can_create_workspaces = 1 WHERE id = ?').run(carol.id)
      const res = await call(carol, '/api/workspaces', { method: 'POST', body: { name: '  Carol  Labs ' } })
      expect(res.status).toBe(201)
      const { workspace } = (await res.json()) as { workspace: { id: string; name: string } }
      expect(workspace.name).toBe('Carol Labs')
      expect(getActiveMembership(db, workspace.id, carol.id)?.role).toBe('owner')
      expect((await call(alice, '/api/workspaces', { method: 'POST', body: { name: '' } })).status).toBe(400)
    })

    it('lists the caller’s workspaces, bootstrap first', () => {
      expect(listUserWorkspaces(db, carol.id).map(w => w.id)).toEqual([wsA, wsB])
    })

    it('deletes a workspace, cutting off its members, but never the bootstrap one', async () => {
      addMember(wsB, alice, 'viewer')
      expect((await call(bob, `/api/workspaces/${wsB}`, { method: 'DELETE' })).status).toBe(200)
      expect(resolveMachineAccess(db, bob, 'mB').kind).toBe('none')
      expect(listUserWorkspaces(db, carol.id).map(w => w.id)).toEqual([wsA])
      expect((await call(alice, `/api/workspaces/${wsA}`, { method: 'DELETE' })).status).toBe(400)
      expect((await call(dave, `/api/workspaces/${wsA}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(403)
    })
  })

  describe('member management', () => {
    const patchMember = (who: UserRow, ws: string, target: UserRow, body: unknown) =>
      call(who, `/api/workspaces/${ws}/members/${target.id}`, { method: 'PATCH', body })
    const removeMember = (who: UserRow, ws: string, target: UserRow) =>
      call(who, `/api/workspaces/${ws}/members/${target.id}`, { method: 'DELETE' })

    it('lets an admin manage members but not admins, owners, or privileged roles', async () => {
      expect((await patchMember(dave, wsA, carol, { role: 'viewer' })).status).toBe(200)
      expect(getActiveMembership(db, wsA, carol.id)?.role).toBe('viewer')
      expect(reauthorize).toHaveBeenCalledWith({ userId: carol.id })
      expect((await patchMember(dave, wsA, carol, { role: 'admin' })).status).toBe(403)
      expect((await patchMember(dave, wsA, alice, { status: 'suspended' })).status).toBe(403)
      expect((await patchMember(carol, wsA, dave, { role: 'member' })).status).toBe(403)
    })

    it('refuses to leave a workspace without an active owner', async () => {
      expect((await patchMember(alice, wsA, alice, { role: 'member' })).status).toBe(400)
      expect((await removeMember(alice, wsA, alice)).status).toBe(409)
      // With a second owner, the first may step down or leave.
      expect((await patchMember(alice, wsA, dave, { role: 'owner' })).status).toBe(200)
      expect((await removeMember(alice, wsA, alice)).status).toBe(200)
      expect((await patchMember(dave, wsA, carol, { role: 'owner' })).status).toBe(200)
      expect((await patchMember(carol, wsA, dave, { status: 'suspended' })).status).toBe(200)
      expect((await patchMember(dave, wsA, carol, { role: 'member' })).status).toBe(404)
    })

    it('guards the last owner in updateMember itself, not only in the routes', () => {
      expect(updateMember(db, wsA, alice.id, { role: 'admin' })).toEqual({ ok: false, reason: 'last_owner' })
      expect(updateMember(db, wsA, alice.id, { status: 'suspended' })).toEqual({ ok: false, reason: 'last_owner' })
      expect(updateMember(db, wsA, dave.id, { role: 'owner' }).ok).toBe(true)
      expect(updateMember(db, wsA, alice.id, { role: 'admin' }).ok).toBe(true)
    })

    it('does not count a disabled account as the remaining owner', async () => {
      expect((await patchMember(alice, wsA, dave, { role: 'owner' })).status).toBe(200)
      db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(dave.id)
      expect((await removeMember(alice, wsA, alice)).status).toBe(409)
    })

    it('suspending a member removes their standing in that workspace only', async () => {
      upsertShare(db, { machineId: 'mB', localSessionId: 's', sharedByUserId: bob.id, granteeUserId: carol.id, permissions: ['view'] })
      expect((await patchMember(alice, wsA, carol, { status: 'suspended' })).status).toBe(200)
      expect(resolveMachineAccess(db, carol, 'mCarolA').kind).toBe('none')
      expect(resolveMachineAccess(db, carol, 'mB').kind).toBe('grantee')
    })

    it('removal quarantines the member’s machines and drops their shares', async () => {
      upsertShare(db, { machineId: 'mCarolA', localSessionId: 's', sharedByUserId: carol.id, granteeUserId: dave.id, permissions: ['view'] })
      expect(resolveMachineAccess(db, dave, 'mCarolA').kind).toBe('grantee')

      const res = await removeMember(alice, wsA, carol)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { quarantinedMachineIds: string[] }).quarantinedMachineIds).toEqual(['mCarolA'])
      expect(resolveMachineAccess(db, carol, 'mCarolA').kind).toBe('none')
      expect(resolveMachineAccess(db, dave, 'mCarolA').kind).toBe('none')
      expect(db.prepare('SELECT COUNT(*) AS n FROM session_shares').get()).toEqual({ n: 0 })
      expect(reauthorize).toHaveBeenCalledWith({ machineId: 'mCarolA' })
      // Their other workspace is untouched.
      expect(getActiveMembership(db, wsB, carol.id)?.role).toBe('member')
      expect(listAuditEvents(db, { workspaceId: wsA }).map(e => e.kind)).toContain('member_removed')
    })

    it('an admin sees every machine and can transfer a quarantined one, but cannot drive it', async () => {
      await removeMember(alice, wsA, carol)
      const list = (await (await call(dave, `/api/workspaces/${wsA}/machines`)).json()) as {
        machines: Array<{ id: string; ownerLogin: string; quarantined: boolean }>
      }
      expect(list.machines.find(m => m.id === 'mCarolA')).toMatchObject({ ownerLogin: 'carol', quarantined: true })
      expect(resolveMachineAccess(db, dave, 'mA').kind).toBe('none')

      const toCarol = await call(dave, `/api/workspaces/${wsA}/machines/mCarolA/transfer`, { method: 'POST', body: { userId: carol.id } })
      expect(toCarol.status).toBe(400)
      const toDave = await call(dave, `/api/workspaces/${wsA}/machines/mCarolA/transfer`, { method: 'POST', body: { userId: dave.id } })
      expect(toDave.status).toBe(200)
      expect(resolveMachineAccess(db, dave, 'mCarolA').kind).toBe('owner')
      expect((await call(carol, `/api/workspaces/${wsB}/machines`)).status).toBe(403)
      expect((await call(dave, `/api/workspaces/${wsA}/machines/mB`, { method: 'DELETE' })).status).toBe(404)
      expect((await call(dave, `/api/workspaces/${wsA}/machines/mCarolA`, { method: 'DELETE' })).status).toBe(200)
    })

    it('a viewer is read-only even on a machine they own', async () => {
      expect((await patchMember(alice, wsA, carol, { role: 'viewer' })).status).toBe(200)
      expect(resolveMachineAccess(db, carol, 'mCarolA').kind).toBe('none')
    })

    it('disabling the account cuts access in every workspace', () => {
      db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(carol.id)
      const disabled = getUserById(db, carol.id)!
      expect(resolveMachineAccess(db, disabled, 'mCarolA').kind).toBe('none')
      expect(listUserWorkspaces(db, carol.id).length).toBe(2) // memberships intact, standing gone
    })
  })
})
