/** Tests for the quota mechanism: the quotas file, limit checks and the usage counts behind them. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import {
  checkQuota,
  countInvitationsToday,
  countSessionShares,
  loadEntitlements,
  parseQuotas,
  UNLIMITED,
} from './quotas.js'

describe('quotas file', () => {
  it('applies defaults, with workspace entries overriding key by key', () => {
    const provider = parseQuotas({
      default: { machinesPerWorkspace: 2, channelsPerUser: 8 },
      workspaces: { 'ws-big': { machinesPerWorkspace: 50 } },
    })
    expect(provider.limitsFor('ws-small')).toEqual({ machinesPerWorkspace: 2, channelsPerUser: 8 })
    expect(provider.limitsFor('ws-big')).toEqual({ machinesPerWorkspace: 50, channelsPerUser: 8 })
  })

  it.each([
    [[], 'must hold a JSON object'],
    [{ defaults: {} }, 'unknown key "defaults"'],
    [{ default: { machines: 2 } }, 'unknown quota "machines"'],
    [{ default: { channelsPerUser: -1 } }, 'non-negative integer'],
    [{ default: { channelsPerUser: 1.5 } }, 'non-negative integer'],
    [{ workspaces: [] }, 'workspaces must be an object'],
  ])('rejects %j', (json, message) => {
    expect(() => parseQuotas(json)).toThrow(message)
  })

  describe('loadEntitlements', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quotas-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('is unlimited without a file', () => {
      expect(loadEntitlements(undefined)).toBe(UNLIMITED)
      expect(UNLIMITED.limitsFor('any')).toEqual({})
    })

    it('reads the file and names it in errors', () => {
      const good = join(dir, 'q.json')
      writeFileSync(good, JSON.stringify({ default: { sharesPerSession: 3 } }))
      expect(loadEntitlements(good).limitsFor('x')).toEqual({ sharesPerSession: 3 })
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{ not json')
      expect(() => loadEntitlements(bad)).toThrow(bad)
      expect(() => loadEntitlements(join(dir, 'missing.json'))).toThrow('RELAY_QUOTAS_FILE')
    })
  })
})

describe('checkQuota', () => {
  const provider = parseQuotas({ default: { channelsPerUser: 2 } })

  it('allows below the limit and refuses at it', () => {
    expect(checkQuota(provider, 'ws', 'channelsPerUser', () => 1)).toBeNull()
    expect(checkQuota(provider, 'ws', 'channelsPerUser', () => 2)).toEqual({
      error: 'quota_exceeded',
      quota: 'channelsPerUser',
      limit: 2,
      message: 'You have 2 sessions open already. Close one and try again.',
    })
  })

  it('never counts usage for a quota without a limit', () => {
    let counted = false
    expect(checkQuota(provider, 'ws', 'sharesPerSession', () => { counted = true; return 999 })).toBeNull()
    expect(counted).toBe(false)
  })
})

describe('usage counts', () => {
  let db: Database.Database
  let owner: string
  let a: string
  let b: string

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    owner = upsertUserFromGithub(db, { id: 1, login: 'o', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [] }).id
    a = upsertUserFromGithub(db, { id: 2, login: 'a', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2, 3] }).id
    b = upsertUserFromGithub(db, { id: 3, login: 'b', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [2, 3] }).id
    db.prepare(`INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('m1', ?, ?, 'box')`).run(BOOTSTRAP_WORKSPACE_ID, owner)
  })
  afterEach(() => { db.close() })

  it('counts other people a session is shared with, skipping expired shares and the grantee being edited', () => {
    const share = db.prepare(
      `INSERT INTO session_shares (id, workspace_id, machine_id, local_session_id, shared_by_user_id, grantee_user_id, permissions, expires_at)
       VALUES (?, ?, 'm1', 's1', ?, ?, 'view', ?)`,
    )
    share.run('sh1', BOOTSTRAP_WORKSPACE_ID, owner, a, null)
    share.run('sh2', BOOTSTRAP_WORKSPACE_ID, owner, b, new Date(Date.now() - 60_000).toISOString())
    expect(countSessionShares(db, 'm1', 's1', 'someone-else')).toBe(1)
    expect(countSessionShares(db, 'm1', 's1', a)).toBe(0)
    expect(countSessionShares(db, 'm1', 's2', 'x')).toBe(0)
  })

  it('counts invitations from the last 24 hours only', () => {
    const invite = db.prepare(
      `INSERT INTO workspace_invitations (id, workspace_id, role, invitee_github_id, token_hash, invited_by_user_id, created_at, expires_at)
       VALUES (?, ?, 'member', 99, ?, ?, ?, 0)`,
    )
    invite.run('i1', BOOTSTRAP_WORKSPACE_ID, 'h1', owner, new Date().toISOString().replace('T', ' ').slice(0, 19))
    invite.run('i2', BOOTSTRAP_WORKSPACE_ID, 'h2', owner, '2020-01-01 00:00:00')
    expect(countInvitationsToday(db, BOOTSTRAP_WORKSPACE_ID)).toBe(1)
  })
})
