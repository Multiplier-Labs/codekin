/** Tests for control-plane DB: access resolution and user upsert semantics. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  openControlPlaneDb,
  resolveUserAccess,
  upsertUserFromGithub,
  listMachines,
  DEFAULT_ORG_ID,
} from './control-plane-db.js'

const OWNER_ID = 1
const TEAMMATE_ID = 2
const POLICY = { ownerGithubId: OWNER_ID, allowedGithubIds: [OWNER_ID, TEAMMATE_ID] }

function profile(overrides: Partial<Parameters<typeof upsertUserFromGithub>[1]> = {}) {
  return {
    id: 1001,
    login: 'someone',
    name: 'Some One',
    email: 'someone@example.com',
    avatarUrl: 'https://example.com/a.png',
    ...overrides,
  }
}

describe('resolveUserAccess', () => {
  it('grants the owner role to the owner id', () => {
    expect(resolveUserAccess(OWNER_ID, POLICY)).toEqual({ role: 'owner', status: 'active' })
  })

  it('grants active member to allowlisted ids', () => {
    expect(resolveUserAccess(TEAMMATE_ID, POLICY)).toEqual({ role: 'member', status: 'active' })
  })

  it('puts everyone else in pending', () => {
    expect(resolveUserAccess(999, POLICY)).toEqual({ role: 'member', status: 'pending' })
  })

  it('never treats an unconfigured owner id as a match', () => {
    expect(resolveUserAccess(0, { ownerGithubId: 0, allowedGithubIds: [] })).toEqual({
      role: 'member',
      status: 'pending',
    })
  })
})

describe('upsertUserFromGithub', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('creates a pending user for a non-allowlisted account', () => {
    const user = upsertUserFromGithub(db, profile(), POLICY)
    expect(user.status).toBe('pending')
    expect(user.role).toBe('member')
    expect(user.organization_id).toBe(DEFAULT_ORG_ID)
  })

  it('creates an active owner for the owner id', () => {
    const user = upsertUserFromGithub(db, profile({ id: OWNER_ID, login: 'alari76' }), POLICY)
    expect(user.status).toBe('active')
    expect(user.role).toBe('owner')
  })

  it('does not activate a different account that claims the owner login', () => {
    // The owner renamed on GitHub; an attacker registered the freed login.
    // Their github_id differs, so they must land in pending, not owner.
    const attacker = upsertUserFromGithub(db, profile({ id: 666, login: 'alari76' }), POLICY)
    expect(attacker.role).toBe('member')
    expect(attacker.status).toBe('pending')
  })

  it('clears a stale duplicate login when the current holder signs in', () => {
    upsertUserFromGithub(db, profile({ id: 10, login: 'bob' }), POLICY)
    // github_id 10 renamed away from "bob"; github_id 11 now legitimately
    // holds it. Signing in must leave exactly one row answering to "bob".
    const current = upsertUserFromGithub(db, profile({ id: 11, login: 'bob' }), POLICY)
    expect(current.login).toBe('bob')
    const matches = db.prepare("SELECT github_id FROM users WHERE lower(login) = 'bob'").all() as Array<{
      github_id: number
    }>
    expect(matches).toEqual([{ github_id: 11 }])
    const stale = db.prepare('SELECT login FROM users WHERE github_id = 10').get() as { login: string }
    expect(stale.login).toBe('formerly-bob-10')
  })

  it('updates profile fields on repeat login without duplicating the row', () => {
    upsertUserFromGithub(db, profile(), POLICY)
    const updated = upsertUserFromGithub(db, profile({ name: 'New Name' }), POLICY)
    expect(updated.display_name).toBe('New Name')
    const count = db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('promotes a pending user to active once allowlisted', () => {
    const before = upsertUserFromGithub(db, profile(), POLICY)
    expect(before.status).toBe('pending')
    const after = upsertUserFromGithub(db, profile(), {
      ...POLICY,
      allowedGithubIds: [...POLICY.allowedGithubIds, 1001],
    })
    expect(after.status).toBe('active')
  })

  it('does not demote a manually activated user missing from the allowlist', () => {
    upsertUserFromGithub(db, profile(), POLICY)
    db.prepare("UPDATE users SET status = 'active' WHERE github_id = ?").run(1001)
    const after = upsertUserFromGithub(db, profile(), POLICY)
    expect(after.status).toBe('active')
  })

  it('keeps a disabled user disabled even when allowlisted', () => {
    upsertUserFromGithub(db, profile({ id: TEAMMATE_ID, login: 'teammate' }), POLICY)
    db.prepare("UPDATE users SET status = 'disabled' WHERE github_id = ?").run(TEAMMATE_ID)
    const after = upsertUserFromGithub(db, profile({ id: TEAMMATE_ID, login: 'teammate' }), POLICY)
    expect(after.status).toBe('disabled')
  })
})

describe('listMachines', () => {
  it('returns an empty list on a fresh database', () => {
    const db = openControlPlaneDb(':memory:')
    expect(listMachines(db)).toEqual([])
    db.close()
  })
})
