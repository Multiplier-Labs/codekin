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

const POLICY = { ownerGithubLogin: 'alari76', allowedGithubLogins: ['alari76', 'teammate'] }

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
  it('grants the owner role to the owner login, case-insensitively', () => {
    expect(resolveUserAccess('alari76', POLICY)).toEqual({ role: 'owner', status: 'active' })
    expect(resolveUserAccess('Alari76', POLICY)).toEqual({ role: 'owner', status: 'active' })
  })

  it('grants active member to allowlisted logins', () => {
    expect(resolveUserAccess('Teammate', POLICY)).toEqual({ role: 'member', status: 'active' })
  })

  it('puts everyone else in pending', () => {
    expect(resolveUserAccess('randomuser', POLICY)).toEqual({ role: 'member', status: 'pending' })
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

  it('creates a pending user for a non-allowlisted login', () => {
    const user = upsertUserFromGithub(db, profile(), POLICY)
    expect(user.status).toBe('pending')
    expect(user.role).toBe('member')
    expect(user.organization_id).toBe(DEFAULT_ORG_ID)
  })

  it('creates an active owner for the owner login', () => {
    const user = upsertUserFromGithub(db, profile({ id: 1, login: 'alari76' }), POLICY)
    expect(user.status).toBe('active')
    expect(user.role).toBe('owner')
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
      allowedGithubLogins: [...POLICY.allowedGithubLogins, 'someone'],
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
    upsertUserFromGithub(db, profile({ id: 2, login: 'teammate' }), POLICY)
    db.prepare("UPDATE users SET status = 'disabled' WHERE github_id = ?").run(2)
    const after = upsertUserFromGithub(db, profile({ id: 2, login: 'teammate' }), POLICY)
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
