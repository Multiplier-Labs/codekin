/** Tests for the device-code pairing lifecycle and machine credentials. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, listMachines } from './control-plane-db.js'
import {
  startPairing,
  getPairingInfo,
  approvePairing,
  denyPairing,
  completePairing,
  precreatePairing,
  verifyMachineCredential,
  removeMachine,
} from './pairing.js'

const POLICY = { ownerGithubId: 1, allowedGithubIds: [] }

describe('pairing lifecycle', () => {
  let db: Database.Database
  let userId: string

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    userId = upsertUserFromGithub(
      db,
      { id: 1, login: 'alari76', name: null, email: null, avatarUrl: null },
      POLICY,
    ).id
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('precreate mints a pre-approved token the installer claims in one step, with hostname backfill', () => {
    const pre = precreatePairing(db, userId)

    const complete = completePairing(db, pre.pairingToken, { hostname: 'fresh-laptop', platform: 'darwin' })
    expect(complete.status).toBe('complete')
    if (complete.status !== 'complete') return
    expect(complete.machineId).toBe(pre.machineId)
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(true)

    // The machine row was created blind at precreate — the claim named it.
    const machines = listMachines(db)
    expect(machines[0].hostname).toBe('fresh-laptop')
    expect(machines[0].display_name).toBe('fresh-laptop')

    // Single use — a stolen token replay mints nothing.
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'not_found' })
  })

  it('a precreated token honors the explicit display name and the pairing TTL', () => {
    vi.useFakeTimers()
    const pre = precreatePairing(db, userId, 'Build server')

    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'expired' })

    vi.useRealTimers()
    const fresh = precreatePairing(db, userId, 'Build server')
    const complete = completePairing(db, fresh.pairingToken, { hostname: 'ci-01' })
    expect(complete.status).toBe('complete')
    const named = listMachines(db).find((m) => m.id === fresh.machineId)
    expect(named?.display_name).toBe('Build server')
    expect(named?.hostname).toBe('ci-01')
  })

  it('start issues an unambiguous user code and a device code', () => {
    const result = startPairing(db, { hostname: 'devbox', platform: 'linux' })
    expect(result.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(result.userCode).not.toMatch(/[01OIL]/)
    expect(result.deviceCode.length).toBeGreaterThan(40)
    expect(getPairingInfo(db, result.userCode)?.status).toBe('pending')
  })

  it('user code lookup is case-insensitive', () => {
    const { userCode } = startPairing(db, {})
    expect(getPairingInfo(db, userCode.toLowerCase())?.userCode).toBe(userCode)
  })

  it('completes only after approval, returns the secret exactly once', () => {
    const { userCode, deviceCode } = startPairing(db, { hostname: 'devbox' })

    expect(completePairing(db, deviceCode)).toEqual({ status: 'pending' })

    const approval = approvePairing(db, userCode, userId, 'Dev box')
    expect(approval.ok).toBe(true)

    const complete = completePairing(db, deviceCode)
    expect(complete.status).toBe('complete')
    if (complete.status !== 'complete') return
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(true)
    expect(verifyMachineCredential(db, complete.machineId, 'wrong-secret')).toBe(false)

    // Replay must not mint a second credential
    expect(completePairing(db, deviceCode)).toEqual({ status: 'not_found' })

    const machines = listMachines(db)
    expect(machines).toHaveLength(1)
    expect(machines[0].display_name).toBe('Dev box')
    expect(machines[0].hostname).toBe('devbox')
  })

  it('denied pairing reports denied to the device', () => {
    const { userCode, deviceCode } = startPairing(db, {})
    expect(denyPairing(db, userCode, userId)).toBe(true)
    expect(completePairing(db, deviceCode)).toEqual({ status: 'denied' })
    expect(listMachines(db)).toHaveLength(0)
  })

  it('expired requests cannot be approved or completed', () => {
    vi.useFakeTimers()
    const { userCode, deviceCode } = startPairing(db, {})
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(getPairingInfo(db, userCode)?.status).toBe('expired')
    expect(approvePairing(db, userCode, userId)).toEqual({ ok: false, reason: 'expired' })
    expect(completePairing(db, deviceCode)).toEqual({ status: 'expired' })
  })

  it('approving twice fails', () => {
    const { userCode } = startPairing(db, {})
    expect(approvePairing(db, userCode, userId).ok).toBe(true)
    expect(approvePairing(db, userCode, userId)).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('unknown device codes are not found', () => {
    expect(completePairing(db, 'no-such-code')).toEqual({ status: 'not_found' })
  })

  it('removeMachine revokes credentials and deletes the machine', () => {
    const { userCode, deviceCode } = startPairing(db, {})
    approvePairing(db, userCode, userId)
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('expected complete')

    expect(removeMachine(db, complete.machineId)).toBe(true)
    expect(listMachines(db)).toHaveLength(0)
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(false)
    expect(removeMachine(db, complete.machineId)).toBe(false)
  })
})
