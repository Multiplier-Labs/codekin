/** Tests for device-link code lifecycle: mint, claim, expiry, replay. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub } from './control-plane-db.js'
import {
  startDeviceLink,
  getDeviceLinkStatus,
  completeDeviceLink,
  DEVICE_LINK_TTL_MS,
  type DeviceLinkRequestRow,
} from './device-link.js'

describe('device link', () => {
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
    vi.useRealTimers()
  })

  it('stores only the hash of the code', () => {
    const { code, requestId } = startDeviceLink(db, userId)
    const row = db
      .prepare('SELECT * FROM device_link_requests WHERE id = ?')
      .get(requestId) as DeviceLinkRequestRow
    expect(row.code_hash).not.toContain(code)
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.status).toBe('pending')
  })

  it('claims exactly once and reports who minted the code', () => {
    const { code, requestId } = startDeviceLink(db, userId)

    const first = completeDeviceLink(db, code, { ip: '10.0.0.1', userAgent: 'phone' })
    expect(first).toEqual({ status: 'complete', requestId, createdByUserId: userId })

    // A replayed code reads as unknown, not as expired or claimed
    expect(completeDeviceLink(db, code)).toEqual({ status: 'not_found' })

    const row = db
      .prepare('SELECT * FROM device_link_requests WHERE id = ?')
      .get(requestId) as DeviceLinkRequestRow
    expect(row.status).toBe('claimed')
    expect(row.claimed_ip).toBe('10.0.0.1')
    expect(row.claimed_user_agent).toBe('phone')
  })

  it('rejects unknown codes', () => {
    expect(completeDeviceLink(db, 'nope')).toEqual({ status: 'not_found' })
  })

  it('expires after the TTL', () => {
    vi.useFakeTimers()
    const { code } = startDeviceLink(db, userId)
    vi.advanceTimersByTime(DEVICE_LINK_TTL_MS + 1)
    expect(completeDeviceLink(db, code)).toEqual({ status: 'expired' })
  })

  it('reports status to the creator only', () => {
    const { code, requestId } = startDeviceLink(db, userId)
    expect(getDeviceLinkStatus(db, requestId, userId)).toBe('pending')
    expect(getDeviceLinkStatus(db, requestId, otherUserId)).toBeNull()
    expect(getDeviceLinkStatus(db, 'unknown', userId)).toBeNull()

    completeDeviceLink(db, code)
    expect(getDeviceLinkStatus(db, requestId, userId)).toBe('claimed')
  })

  it('reports expired to the polling dialog', () => {
    vi.useFakeTimers()
    const { requestId } = startDeviceLink(db, userId)
    vi.advanceTimersByTime(DEVICE_LINK_TTL_MS + 1)
    expect(getDeviceLinkStatus(db, requestId, userId)).toBe('expired')
  })

  it('sweeps expired pending rows on start but keeps claimed ones', () => {
    vi.useFakeTimers()
    const stale = startDeviceLink(db, userId)
    const claimed = startDeviceLink(db, userId)
    completeDeviceLink(db, claimed.code)

    vi.advanceTimersByTime(DEVICE_LINK_TTL_MS + 1)
    startDeviceLink(db, userId)

    const ids = (db.prepare('SELECT id FROM device_link_requests').all() as Array<{ id: string }>).map(
      r => r.id,
    )
    expect(ids).not.toContain(stale.requestId)
    expect(ids).toContain(claimed.requestId)
  })
})
