/**
 * REST endpoints for device-code machine pairing.
 *
 * start/complete are called by the CLI on the machine being paired and are
 * unauthenticated (rate-limited; possession of the device code is the
 * credential). info/approve/deny are called by the hosted UI and require an
 * active signed-in user.
 */

import { Router } from 'express'
import type Database from 'better-sqlite3'
import {
  startPairing,
  getPairingInfo,
  approvePairing,
  denyPairing,
  completePairing,
  precreatePairing,
  removeMachine,
  discardUnclaimedMachine,
  machineHasEverHadCredential,
} from './pairing.js'
import { createRequireActiveUser } from './relay-auth-routes.js'
import { getMachine } from './control-plane-db.js'
import { recordAuditEvent } from './audit.js'
import type { RelayConfig } from './relay-config.js'
import type { ConnectorHub } from './connector-hub.js'
import type { BrowserHub } from './browser-hub.js'

/** Suggested delay between CLI completion polls. */
export const POLL_INTERVAL_MS = 3_000

/** Install commands one user may mint per window (N10.4). */
export const PRECREATE_LIMIT = { limit: 10, windowMs: 60_000 }

export interface PairingRouterOptions {
  /** Override the per-user precreate limit (tests). */
  precreateLimit?: { limit: number; windowMs: number }
}

/**
 * Per-key fixed-window counter. Keyed by the signed-in user rather than IP,
 * so one account cannot mint unbounded pairing rows from many addresses, and
 * several users behind one NAT do not share a budget.
 */
function createKeyedWindow(limit: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (key: string) => {
    const now = Date.now()
    for (const [k, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(k)
    }
    const entry = hits.get(key)
    if (!entry) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    entry.count += 1
    return entry.count <= limit
  }
}

export function createPairingRouter(
  db: Database.Database,
  config: RelayConfig,
  hubs: { connectorHub?: ConnectorHub; browserHub?: BrowserHub } = {},
  options: PairingRouterOptions = {},
): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)
  const precreateLimit = options.precreateLimit ?? PRECREATE_LIMIT
  const allowPrecreate = createKeyedWindow(precreateLimit.limit, precreateLimit.windowMs)

  router.post('/api/machines/pair/start', (req, res) => {
    const body = (req.body ?? {}) as { hostname?: unknown; platform?: unknown }
    const hostname = typeof body.hostname === 'string' ? body.hostname.slice(0, 128) : undefined
    const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : undefined
    const result = startPairing(db, { hostname, platform })
    res.json({
      userCode: result.userCode,
      deviceCode: result.deviceCode,
      expiresAt: result.expiresAt,
      verificationUrl: `${config.publicUrl}/pair?code=${encodeURIComponent(result.userCode)}`,
      pollIntervalMs: POLL_INTERVAL_MS,
    })
  })

  // Browser-first pairing for the install-command funnel: a signed-in user
  // mints a pre-approved pairing token, embeds it in the one-line installer
  // command, and the installer claims it via pair/complete — no approval
  // round-trip. Single-use, normal TTL.
  // Browser-first pairing for the install-command funnel: a signed-in user
  // mints a pre-approved pairing token, embeds it in the one-line installer
  // command, and the installer claims it via pair/complete — no approval
  // round-trip. Single-use, normal TTL.
  //
  // `replaceMachineId` regenerates a command: the caller's own machine that
  // has never held a credential is removed and its token invalidated first,
  // so repeated regeneration leaves at most one pending record.
  router.post('/api/machines/pair/precreate', requireActiveUser, (req, res) => {
    const body = (req.body ?? {}) as { displayName?: unknown; replaceMachineId?: unknown }
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined
    const userId = req.session.user?.id ?? ''
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (body.replaceMachineId !== undefined && typeof body.replaceMachineId !== 'string') {
      res.status(400).json({ error: 'invalid_replace_machine_id' })
      return
    }
    if (!allowPrecreate(userId)) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }

    const replaceMachineId = body.replaceMachineId
    if (replaceMachineId) {
      const existing = getMachine(db, replaceMachineId)
      // Not revealing whether someone else's machine id exists: not-owned
      // reads the same as missing.
      if (!existing || existing.owner_user_id !== userId) {
        res.status(404).json({ error: 'machine_not_found' })
        return
      }
      if (machineHasEverHadCredential(db, replaceMachineId)) {
        res.status(409).json({ error: 'machine_already_paired' })
        return
      }
      discardUnclaimedMachine(db, replaceMachineId)
      recordAuditEvent(db, {
        kind: 'machine_removed',
        actorUserId: userId,
        machineId: replaceMachineId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata: { reason: 'pairing_regenerated' },
      })
    }

    const result = precreatePairing(db, userId, displayName)
    recordAuditEvent(db, {
      kind: 'machine_pairing_created',
      actorUserId: userId,
      machineId: result.machineId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: replaceMachineId ? { replacedMachineId: replaceMachineId } : undefined,
    })
    res.json({ pairingToken: result.pairingToken, machineId: result.machineId, expiresAt: result.expiresAt })
  })

  router.post('/api/machines/pair/complete', (req, res) => {
    const body = (req.body ?? {}) as { deviceCode?: unknown; hostname?: unknown; platform?: unknown }
    if (typeof body.deviceCode !== 'string' || !body.deviceCode) {
      res.status(400).json({ error: 'deviceCode required' })
      return
    }
    const result = completePairing(db, body.deviceCode, {
      hostname: typeof body.hostname === 'string' ? body.hostname.slice(0, 128) : undefined,
      platform: typeof body.platform === 'string' ? body.platform.slice(0, 32) : undefined,
    })
    switch (result.status) {
      case 'pending':
        res.status(202).json({ status: 'pending' })
        return
      case 'complete':
        res.json({ status: 'complete', machineId: result.machineId, machineSecret: result.machineSecret })
        return
      case 'denied':
        res.status(403).json({ status: 'denied' })
        return
      case 'expired':
        res.status(410).json({ status: 'expired' })
        return
      default:
        res.status(404).json({ status: 'not_found' })
    }
  })

  router.get('/api/machines/pair/info', requireActiveUser, (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    const info = code ? getPairingInfo(db, code) : null
    if (!info) {
      res.status(404).json({ error: 'Pairing request not found' })
      return
    }
    res.json({ request: info })
  })

  router.post('/api/machines/pair/approve', requireActiveUser, (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; displayName?: unknown }
    const code = typeof body.code === 'string' ? body.code : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 128) : undefined
    // requireActiveUser guarantees the session user exists
    const userId = req.session.user?.id ?? ''
    const result = approvePairing(db, code, userId, displayName)
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 410
      res.status(status).json({ error: result.reason })
      return
    }
    recordAuditEvent(db, {
      kind: 'machine_paired',
      actorUserId: userId,
      machineId: result.machineId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })
    res.json({ machineId: result.machineId })
  })

  router.post('/api/machines/pair/deny', requireActiveUser, (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code : ''
    const userId = req.session.user?.id ?? ''
    if (!denyPairing(db, code, userId)) {
      res.status(404).json({ error: 'Pairing request not found or not pending' })
      return
    }
    res.json({ success: true })
  })

  router.delete('/api/machines/:machineId', requireActiveUser, (req, res) => {
    const machineId = typeof req.params.machineId === 'string' ? req.params.machineId : ''
    const userId = req.session.user?.id ?? ''
    const machine = getMachine(db, machineId)
    if (!machine) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    // Being able to name a machine is not authority over it: anyone holding a
    // share reads its id from GET /api/machines, and removing it deletes the
    // connector's credential. Only the owner may do that.
    if (machine.owner_user_id !== userId) {
      recordAuditEvent(db, {
        kind: 'access_denied',
        actorUserId: userId,
        machineId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        metadata: { action: 'machine_removed' },
      })
      res.status(403).json({ error: 'Only the machine owner can remove it' })
      return
    }
    if (!removeMachine(db, machineId)) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    // The credential is gone from the DB, but credential checks happen at
    // connect time — drop the live sockets too, on both sides of the relay.
    hubs.connectorHub?.disconnectMachine(machineId)
    hubs.browserHub?.reauthorize({ machineId })
    recordAuditEvent(db, {
      kind: 'machine_removed',
      actorUserId: userId,
      machineId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })
    res.json({ success: true })
  })

  return router
}
