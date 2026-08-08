/** Share persistence, expiry, and machine access resolution. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import { startPairing, approvePairing, completePairing } from './pairing.js'
import {
  SHARE_ROLES,
  deleteShare,
  grantsForMachine,
  listSharesFor,
  normalizePermissions,
  resolveMachineAccess,
  updateSharePermissions,
  upsertShare,
} from './shares.js'
import type { UserRow } from './control-plane-db.js'

describe('permission normalization', () => {
  it('drops unknown entries and implies view', () => {
    expect(normalizePermissions(['send_prompt', 'fly_to_the_moon'])).toEqual(['view', 'send_prompt'])
    expect(normalizePermissions(['view', 'view'])).toEqual(['view'])
    expect(normalizePermissions('nonsense')).toEqual([])
    expect(normalizePermissions([])).toEqual([])
  })

  it('keeps the spec presets free of the dangerous approvals', () => {
    for (const role of ['viewer', 'editor'] as const) {
      expect(SHARE_ROLES[role]).not.toContain('approve_mutating_tool')
      expect(SHARE_ROLES[role]).not.toContain('approve_shell')
    }
    expect(SHARE_ROLES.editor).toContain('send_prompt')
    expect(SHARE_ROLES.viewer).not.toContain('send_prompt')
  })
})

describe('access resolution', () => {
  let db: Database.Database
  let owner: UserRow
  let guest: UserRow
  let machineId: string

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    owner = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubLogin: 'owner', allowedGithubLogins: [] },
    )
    guest = upsertUserFromGithub(
      db,
      { id: 2, login: 'guest', name: null, email: null, avatarUrl: null },
      { ownerGithubLogin: 'owner', allowedGithubLogins: ['guest'] },
    )

    const { userCode, deviceCode } = startPairing(db, { hostname: 'box', platform: 'linux' })
    approvePairing(db, userCode, owner.id, 'Box')
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('pairing failed')
    machineId = complete.machineId
  })

  afterEach(() => { db.close() })

  it('gives the machine owner unrestricted access', () => {
    expect(resolveMachineAccess(db, owner, machineId)).toEqual({ kind: 'owner' })
  })

  it('refuses a user with no share', () => {
    expect(resolveMachineAccess(db, guest, machineId).kind).toBe('none')
  })

  it('admits a grantee with exactly their granted sessions', () => {
    upsertShare(db, {
      machineId,
      localSessionId: 's1',
      sharedByUserId: owner.id,
      granteeUserId: guest.id,
      permissions: [...SHARE_ROLES.editor],
    })

    const access = resolveMachineAccess(db, guest, machineId)
    expect(access.kind).toBe('grantee')
    if (access.kind !== 'grantee') throw new Error('expected grantee')
    expect(Object.keys(access.grants)).toEqual(['s1'])
    expect(access.grants.s1).toContain('send_prompt')
  })

  it('refuses a disabled or pending user even with a share', () => {
    upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
    })
    expect(resolveMachineAccess(db, { ...guest, status: 'disabled' }, machineId).kind).toBe('none')
    expect(resolveMachineAccess(db, { ...guest, status: 'pending' }, machineId).kind).toBe('none')
  })

  it('ignores an expired share', () => {
    upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
      expiresAt: '2020-01-01T00:00:00.000Z',
    })
    expect(listSharesFor(db, guest.id)).toHaveLength(0)
    expect(resolveMachineAccess(db, guest, machineId).kind).toBe('none')
  })

  it('does not leak grants from another machine', () => {
    upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
    })
    expect(grantsForMachine(db, guest.id, 'some-other-machine')).toEqual({})
  })

  it('replaces rather than stacks a repeated share', () => {
    const first = upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: [...SHARE_ROLES.editor],
    })
    const second = upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
    })

    expect(second.id).toBe(first.id)
    expect(listSharesFor(db, guest.id)).toHaveLength(1)
    // Downgrading must actually remove the permission, not union with it
    expect(grantsForMachine(db, guest.id, machineId).s1).toEqual(['view'])
  })

  it('revokes access when the share is deleted', () => {
    const share = upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
    })
    expect(deleteShare(db, share.id)).toBe(true)
    expect(resolveMachineAccess(db, guest, machineId).kind).toBe('none')
  })

  it('applies a permission update to resolved grants', () => {
    const share = upsertShare(db, {
      machineId, localSessionId: 's1', sharedByUserId: owner.id,
      granteeUserId: guest.id, permissions: ['view'],
    })
    updateSharePermissions(db, share.id, ['view', 'send_prompt'])
    expect(grantsForMachine(db, guest.id, machineId).s1).toEqual(['view', 'send_prompt'])
  })
})
