/**
 * Local endpoints for the machine's device list
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.5), used by Settings →
 * Remote access → "Devices that can control this computer":
 *
 *   GET    /api/relay/devices          identity key, device list, policy
 *   DELETE /api/relay/devices/:keyId   remove a device
 *   PUT    /api/relay/devices/policy   { policy: off | warn | required }
 *
 * Like the other /api/relay/* routes these need the local auth token and are
 * on neither of the connector's proxy allowlists, so the relay can never
 * read or change the list (a test in connector-proxy.test.ts pins this).
 * Adding devices comes with the enrolment ceremony (slice 3); nothing
 * enforces the policy yet.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { readRelayCredentialIdentity, relayCredentialPath } from './relay-credential.js'
import { readMachineIdentity } from './machine-identity.js'
import { trustPathsFor } from './machine-trust.js'
import {
  describeTrustStore, readTrustStore, revokeCredential, setIntentPolicy, TrustStoreError,
} from './trust-store.js'
import type { IntentPolicy, TrustStoreView } from './trust-store.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/** GET /api/relay/devices */
export interface RelayDevicesResponse {
  paired: boolean
  machineId: string | null
  /** The machine identity key, once the connector or pairing has made it. */
  identity: { keyId: string; createdAt: string } | null
  /** Null until the connector or pairing has created the list for this pairing. */
  devices: TrustStoreView | null
  /** Set when relay-devices.json exists but can't be read. */
  error?: string
}

const ERROR_STATUS: Record<TrustStoreError['code'], number> = {
  unreadable: 500,
  not_found: 404,
  no_credentials: 409,
  invalid_policy: 400,
  wrong_machine: 409,
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof TrustStoreError) {
    res.status(ERROR_STATUS[err.code]).json({ error: err.code, message: err.message })
    return
  }
  console.error('[relay] Device list update failed:', err)
  res.status(500).json({ error: 'internal', message: 'Could not update the device list' })
}

export function createRelayDevicesRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  credentialFile = relayCredentialPath(),
): Router {
  const router = Router()
  const { identityFile, devicesFile } = trustPathsFor(credentialFile)

  router.use('/api/relay/devices', (req, res, next) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  /** The machine the current pairing names, or a 404 response. */
  const pairedMachine = (res: Response): string | null => {
    const paired = readRelayCredentialIdentity(credentialFile)
    if (!paired) {
      res.status(404).json({ error: 'not_paired', message: 'This machine is not paired with a relay' })
      return null
    }
    return paired.machineId
  }

  router.get('/api/relay/devices', (_req, res) => {
    const paired = readRelayCredentialIdentity(credentialFile)
    const body: RelayDevicesResponse = { paired: !!paired, machineId: paired?.machineId ?? null, identity: null, devices: null }
    if (!paired) {
      res.json(body)
      return
    }
    const identity = readMachineIdentity(identityFile)
    if (identity?.machineId === paired.machineId) body.identity = { keyId: identity.keyId, createdAt: identity.createdAt }
    try {
      const store = readTrustStore(devicesFile)
      // A list from an earlier pairing is replaced when the connector starts.
      if (store?.machineId === paired.machineId) body.devices = describeTrustStore(store)
    } catch (err) {
      body.error = err instanceof Error ? err.message : String(err)
    }
    res.json(body)
  })

  router.put('/api/relay/devices/policy', (req, res) => {
    const machineId = pairedMachine(res)
    if (!machineId) return
    const policy = (req.body as { policy?: unknown } | undefined)?.policy as IntentPolicy
    try {
      res.json(describeTrustStore(setIntentPolicy(policy, devicesFile, machineId)))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/relay/devices/:keyId', (req, res) => {
    const machineId = pairedMachine(res)
    if (!machineId) return
    try {
      const removed = revokeCredential(req.params.keyId, devicesFile, machineId)
      res.json({ removed: { keyId: removed.keyId, label: removed.label } })
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
