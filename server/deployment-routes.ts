/**
 * REST API routes for the deployment registry and monitor.
 *
 * Mounted at /api/deployments on the Express app. All routes require the
 * master auth token, matching the workflow routes.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  loadDeployments,
  upsertDeployment,
  removeDeployment,
  updateDeployment,
  type DeploymentConfig,
} from './deployment-config.js'
import { tryGetDeploymentMonitor, discoverPm2Processes } from './deployment-monitor.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

const PROBE_TYPES = new Set(['http', 'pm2', 'disk'])

/** Structural validation of a probe entry; returns an error string or null. */
function validateProbe(probe: unknown): string | null {
  if (!probe || typeof probe !== 'object') return 'Probe must be an object'
  const p = probe as Record<string, unknown>
  if (!PROBE_TYPES.has(p.type as string)) return `Invalid probe type: ${String(p.type)}`
  if (p.type === 'http' && (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url))) return 'http probe requires an http(s) url'
  if (p.type === 'pm2' && (typeof p.processName !== 'string' || !p.processName)) return 'pm2 probe requires processName'
  if (p.type === 'disk' && (typeof p.path !== 'string' || !p.path.startsWith('/'))) return 'disk probe requires an absolute path'
  return null
}

function validateDeployment(body: Partial<DeploymentConfig>): string | null {
  if (!body.id || !body.name) return 'Missing required fields: id, name'
  if (!Array.isArray(body.probes) || body.probes.length === 0) return 'At least one probe is required'
  for (const probe of body.probes) {
    const err = validateProbe(probe)
    if (err) return err
  }
  return null
}

export function createDeploymentRouter(verifyToken: VerifyFn, extractToken: ExtractFn): Router {
  const router = Router()

  router.use((req: Request, res: Response, next: () => void) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  /** The registry plus the latest sample per probe — the one-call status surface. */
  router.get('/', (_req, res) => {
    const { deployments } = loadDeployments()
    const monitor = tryGetDeploymentMonitor()
    const samples = monitor?.latestSamples() ?? []
    res.json({
      deployments: deployments.map(d => ({
        ...d,
        latestSamples: samples.filter(s => s.deploymentId === d.id),
      })),
    })
  })

  router.post('/', (req: Request<Record<string, string>, unknown, Partial<DeploymentConfig>>, res) => {
    const body = req.body
    const err = validateDeployment(body)
    if (err) return res.status(400).json({ error: err })

    const config = upsertDeployment({
      id: String(body.id),
      name: String(body.name),
      repoPath: body.repoPath,
      enabled: body.enabled !== false,
      autoDiagnose: body.autoDiagnose === true,
      probes: body.probes ?? [],
    })
    res.json({ config })
  })

  router.patch('/:id', (req: Request<{ id: string }, unknown, Partial<DeploymentConfig>>, res) => {
    if (req.body.probes !== undefined) {
      const err = validateDeployment({ id: req.params.id, name: 'x', probes: req.body.probes })
      if (err) return res.status(400).json({ error: err })
    }
    try {
      const config = updateDeployment(req.params.id, req.body)
      res.json({ config })
    } catch {
      res.status(404).json({ error: 'Deployment not found' })
    }
  })

  router.delete('/:id', (req, res) => {
    const before = loadDeployments().deployments.length
    const config = removeDeployment(req.params.id)
    if (config.deployments.length === before) return res.status(404).json({ error: 'Deployment not found' })
    res.json({ config })
  })

  /** Propose monitorable pm2 processes (never auto-enrolls). */
  router.get('/discover', async (_req, res) => {
    res.json({ pm2: await discoverPm2Processes() })
  })

  /** Sample history for one probe. */
  router.get('/samples', (req, res) => {
    const monitor = tryGetDeploymentMonitor()
    if (!monitor) return res.status(503).json({ error: 'Deployment monitor not available' })
    const probeKey = typeof req.query.probeKey === 'string' ? req.query.probeKey : undefined
    if (!probeKey) return res.status(400).json({ error: 'Missing probeKey query parameter' })
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1000)
    res.json({ samples: monitor.listSamples({ probeKey, limit }) })
  })

  return router
}
