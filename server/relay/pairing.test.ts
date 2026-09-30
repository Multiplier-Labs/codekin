/** Tests for the device-code pairing lifecycle and machine credentials. */
import { BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
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
  getMachineSetupStates,
  isSetupPending,
  sweepOrphanMachines,
  discardUnclaimedMachine,
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
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)

    const complete = completePairing(db, pre.pairingToken, { hostname: 'fresh-laptop', platform: 'darwin' })
    expect(complete.status).toBe('complete')
    if (complete.status !== 'complete') return
    expect(complete.machineId).toBe(pre.machineId)
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(true)

    // The machine row was created blind at precreate — the claim named it.
    const machines = listMachines(db, BOOTSTRAP_WORKSPACE_ID)
    expect(machines[0].hostname).toBe('fresh-laptop')
    expect(machines[0].display_name).toBe('fresh-laptop')

    // Single use — a stolen token replay mints nothing.
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'not_found' })
  })

  it('a precreated token honors the explicit display name and the pairing TTL', () => {
    vi.useFakeTimers()
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID, 'Build server')

    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'expired' })

    vi.useRealTimers()
    const fresh = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID, 'Build server')
    const complete = completePairing(db, fresh.pairingToken, { hostname: 'ci-01' })
    expect(complete.status).toBe('complete')
    const named = listMachines(db, BOOTSTRAP_WORKSPACE_ID).find((m) => m.id === fresh.machineId)
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

    const approval = approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID, 'Dev box')
    expect(approval.ok).toBe(true)

    const complete = completePairing(db, deviceCode)
    expect(complete.status).toBe('complete')
    if (complete.status !== 'complete') return
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(true)
    expect(verifyMachineCredential(db, complete.machineId, 'wrong-secret')).toBe(false)

    // Replay must not mint a second credential
    expect(completePairing(db, deviceCode)).toEqual({ status: 'not_found' })

    const machines = listMachines(db, BOOTSTRAP_WORKSPACE_ID)
    expect(machines).toHaveLength(1)
    expect(machines[0].display_name).toBe('Dev box')
    expect(machines[0].hostname).toBe('devbox')
  })

  it('denied pairing reports denied to the device', () => {
    const { userCode, deviceCode } = startPairing(db, {})
    expect(denyPairing(db, userCode, userId)).toBe(true)
    expect(completePairing(db, deviceCode)).toEqual({ status: 'denied' })
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(0)
  })

  it('expired requests cannot be approved or completed', () => {
    vi.useFakeTimers()
    const { userCode, deviceCode } = startPairing(db, {})
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(getPairingInfo(db, userCode)?.status).toBe('expired')
    expect(approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID)).toEqual({ ok: false, reason: 'expired' })
    expect(completePairing(db, deviceCode)).toEqual({ status: 'expired' })
  })

  it('approving twice fails', () => {
    const { userCode } = startPairing(db, {})
    expect(approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID).ok).toBe(true)
    expect(approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID)).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('unknown device codes are not found', () => {
    expect(completePairing(db, 'no-such-code')).toEqual({ status: 'not_found' })
  })

  it('removeMachine revokes credentials and deletes the machine', () => {
    const { userCode, deviceCode } = startPairing(db, {})
    approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID)
    const complete = completePairing(db, deviceCode)
    if (complete.status !== 'complete') throw new Error('expected complete')

    expect(removeMachine(db, complete.machineId)).toBe(true)
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(0)
    expect(verifyMachineCredential(db, complete.machineId, complete.machineSecret)).toBe(false)
    expect(removeMachine(db, complete.machineId)).toBe(false)
  })
})

describe('unclaimed machine hygiene', () => {
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

  it('reports a precreated machine as setup-pending until its installer claims it', () => {
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)
    const before = getMachineSetupStates(db).get(pre.machineId)
    expect(isSetupPending(before)).toBe(true)
    expect(before?.pendingPairingExpiresAt).toBe(pre.expiresAt)

    completePairing(db, pre.pairingToken, { hostname: 'laptop' })
    const after = getMachineSetupStates(db).get(pre.machineId)
    expect(after).toEqual({ hasCredential: true, pendingPairingExpiresAt: null })
    expect(isSetupPending(after)).toBe(false)
  })

  it('an expired, unclaimed precreate is no longer setup-pending and is swept', () => {
    vi.useFakeTimers()
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)
    // Still claimable: the sweep leaves it alone
    expect(sweepOrphanMachines(db)).toEqual([])

    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(isSetupPending(getMachineSetupStates(db).get(pre.machineId))).toBe(false)
    expect(sweepOrphanMachines(db)).toEqual([pre.machineId])
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(0)
    // The stale token still reads as expired, not as an unexplained miss
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'expired' })
  })

  it('never sweeps a machine that has held a credential, even long after its pairing expired', () => {
    vi.useFakeTimers()
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)
    const complete = completePairing(db, pre.pairingToken, { hostname: 'laptop' })
    expect(complete.status).toBe('complete')
    // A revoked credential still counts as "had one"
    db.prepare(`UPDATE machine_credentials SET revoked_at = datetime('now')`).run()

    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(sweepOrphanMachines(db)).toEqual([])
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(1)
  })

  it('never sweeps a machine with no linked pairing request', () => {
    db.prepare(
      `INSERT INTO machines (id, workspace_id, owner_user_id, display_name, status)
       VALUES ('legacy', 'org-default', ?, 'Legacy', 'offline')`,
    ).run(userId)
    expect(sweepOrphanMachines(db, Date.now() + 365 * 24 * 60 * 60 * 1000)).toEqual([])
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(1)
  })

  it('sweeps a device-code approval whose CLI never came back', () => {
    vi.useFakeTimers()
    const { userCode } = startPairing(db, { hostname: 'devbox' })
    const approved = approvePairing(db, userCode, userId, BOOTSTRAP_WORKSPACE_ID)
    if (!approved.ok) throw new Error('expected approval')
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(sweepOrphanMachines(db)).toEqual([approved.machineId])
  })

  it('discardUnclaimedMachine invalidates the pending token immediately', () => {
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)
    expect(discardUnclaimedMachine(db, pre.machineId)).toBe(true)
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(0)
    expect(completePairing(db, pre.pairingToken)).toEqual({ status: 'expired' })
  })

  it('discardUnclaimedMachine refuses a machine that has been claimed', () => {
    const pre = precreatePairing(db, userId, BOOTSTRAP_WORKSPACE_ID)
    completePairing(db, pre.pairingToken)
    expect(discardUnclaimedMachine(db, pre.machineId)).toBe(false)
    expect(listMachines(db, BOOTSTRAP_WORKSPACE_ID)).toHaveLength(1)
  })
})
