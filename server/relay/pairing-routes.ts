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
  removeMachine,
} from './pairing.js'
import { requireActiveUser } from './relay-auth-routes.js'
import { recordAuditEvent } from './audit.js'
import type { RelayConfig } from './relay-config.js'

/** Suggested delay between CLI completion polls. */
export const POLL_INTERVAL_MS = 3_000

export function createPairingRouter(db: Database.Database, config: RelayConfig): Router {
  const router = Router()

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

  router.post('/api/machines/pair/complete', (req, res) => {
    const body = (req.body ?? {}) as { deviceCode?: unknown }
    if (typeof body.deviceCode !== 'string' || !body.deviceCode) {
      res.status(400).json({ error: 'deviceCode required' })
      return
    }
    const result = completePairing(db, body.deviceCode)
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
    if (!removeMachine(db, machineId)) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    res.json({ success: true })
  })

  return router
}
