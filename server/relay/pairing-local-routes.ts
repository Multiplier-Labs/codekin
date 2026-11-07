/**
 * Local endpoints for in-app relay pairing (desktop plan D2), used by the
 * "Pair with app.codekin.ai" control in Settings:
 *
 *   GET    /api/relay/pair    current pairing state
 *   POST   /api/relay/pair    { relayUrl? } start pairing (device-code flow)
 *   DELETE /api/relay/pair    cancel a pending pairing
 *   POST   /api/relay/unpair  remove this machine's local credential
 *
 * The connector's proxy allowlist doesn't include these paths, so the hosted
 * relay can never pair or unpair a machine; they need the local auth token.
 * Progress of the embedded connector after pairing stays on
 * GET /api/relay/status.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { PairingError, removeRelayCredential, type RelayPairing } from './pairing-client.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

const ERROR_STATUS: Record<PairingError['code'], number> = {
  already_paired: 409,
  invalid_url: 400,
  unreachable: 502,
  rejected: 502,
}

export function createRelayPairingRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  pairing: RelayPairing,
  credentialFile?: string,
): Router {
  const router = Router()
  router.use(['/api/relay/pair', '/api/relay/unpair'], (req, res, next) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  router.get('/api/relay/pair', (_req, res) => {
    res.json(pairing.status())
  })

  router.post('/api/relay/pair', async (req, res) => {
    const body = (req.body ?? {}) as { relayUrl?: unknown }
    const relayUrl = typeof body.relayUrl === 'string' ? body.relayUrl : undefined
    try {
      const { state } = await pairing.start(relayUrl)
      res.json(state)
    } catch (err) {
      if (err instanceof PairingError) {
        res.status(ERROR_STATUS[err.code]).json({ error: err.code, message: err.message })
        return
      }
      console.error('[relay] Pairing failed to start:', err)
      res.status(500).json({ error: 'internal', message: 'Pairing failed to start' })
    }
  })

  router.delete('/api/relay/pair', (_req, res) => {
    pairing.cancel()
    res.json(pairing.status())
  })

  router.post('/api/relay/unpair', (_req, res) => {
    pairing.cancel()
    const removed = removeRelayCredential(credentialFile)
    res.json({ removed })
  })

  return router
}
