/** Tests for the passkey credential store. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import {
  listPasskeys,
  getCredentialByCredentialId,
  insertCredential,
  recordCredentialUse,
  deletePasskey,
  parseTransports,
} from './webauthn.js'

describe('webauthn credential store', () => {
  let db: Database.Database
  let userId: string
  let otherUserId: string

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    userId = upsertUserFromGithub(
      db,
      { id: 1, login: 'owner', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [] },
    ).id
    otherUserId = upsertUserFromGithub(
      db,
      { id: 2, login: 'member', name: null, email: null, avatarUrl: null },
      { ownerGithubId: 1, allowedGithubIds: [2] },
    ).id
  })

  afterEach(() => {
    db.close()
  })

  it('inserts and lists without exposing key material', () => {
    const passkey = insertCredential(db, {
      userId,
      credentialId: 'cred-1',
      publicKey: 'pk-base64url',
      counter: 0,
      transports: ['internal', 'hybrid'],
      label: 'iPhone — Safari',
    })
    expect(passkey.label).toBe('iPhone — Safari')
    expect(passkey).not.toHaveProperty('public_key')
    expect(passkey).not.toHaveProperty('publicKey')

    expect(listPasskeys(db, userId)).toHaveLength(1)
    expect(listPasskeys(db, otherUserId)).toHaveLength(0)
  })

  it('finds credentials by authenticator credential id', () => {
    insertCredential(db, { userId, credentialId: 'cred-1', publicKey: 'pk', counter: 3 })
    const row = getCredentialByCredentialId(db, 'cred-1')
    expect(row?.user_id).toBe(userId)
    expect(row?.counter).toBe(3)
    expect(getCredentialByCredentialId(db, 'missing')).toBeUndefined()
  })

  it('records use: counter and last_used_at', () => {
    const passkey = insertCredential(db, { userId, credentialId: 'cred-1', publicKey: 'pk', counter: 0 })
    expect(listPasskeys(db, userId)[0].lastUsedAt).toBeNull()
    recordCredentialUse(db, passkey.id, 7)
    const row = getCredentialByCredentialId(db, 'cred-1')
    expect(row?.counter).toBe(7)
    expect(row?.last_used_at).not.toBeNull()
  })

  it('only deletes the owner’s own passkey', () => {
    const passkey = insertCredential(db, { userId, credentialId: 'cred-1', publicKey: 'pk', counter: 0 })
    expect(deletePasskey(db, otherUserId, passkey.id)).toBe(false)
    expect(listPasskeys(db, userId)).toHaveLength(1)
    expect(deletePasskey(db, userId, passkey.id)).toBe(true)
    expect(listPasskeys(db, userId)).toHaveLength(0)
  })

  it('round-trips transports and tolerates junk', () => {
    insertCredential(db, { userId, credentialId: 'cred-1', publicKey: 'pk', counter: 0, transports: ['internal'] })
    insertCredential(db, { userId, credentialId: 'cred-2', publicKey: 'pk', counter: 0 })
    expect(parseTransports(getCredentialByCredentialId(db, 'cred-1')!)).toEqual(['internal'])
    expect(parseTransports(getCredentialByCredentialId(db, 'cred-2')!)).toBeUndefined()

    db.prepare(`UPDATE webauthn_credentials SET transports = 'not json' WHERE credential_id = 'cred-1'`).run()
    expect(parseTransports(getCredentialByCredentialId(db, 'cred-1')!)).toBeUndefined()
  })
})
