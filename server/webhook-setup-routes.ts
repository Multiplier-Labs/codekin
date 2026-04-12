/**
 * REST routes for webhook integration health checks and setup.
 *
 * Mounted at the Express app root (routes carry their own /api/ prefixes).
 * Provides health-check, auto-setup, and test-delivery endpoints for the
 * GitHub PR review integration.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { checkGhHealth } from './webhook-github.js'
import {
  findCodekinWebhook,
  getWebhookDeliveries,
  createRepoWebhook,
  updateRepoWebhook,
  pingWebhook,
  previewWebhookSetup as previewSetup,
} from './webhook-github-setup.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { generateWebhookSecret, saveWebhookConfig } from './webhook-config.js'
import type { HealthCheckResult } from './webhook-types.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createWebhookSetupRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  getConfig: () => FullWebhookConfig,
): Router {
  const router = Router()

  const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

  // --- Health check endpoint ---

  router.get('/api/integrations/github/pr-review/health', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const repo = req.query.repo as string | undefined
    const webhookUrl = req.query.webhookUrl as string | undefined

    if (!repo || !webhookUrl) {
      return res.status(400).json({ error: 'Missing required query params: repo, webhookUrl' })
    }
    if (!REPO_PATTERN.test(repo)) {
      return res.status(400).json({ error: 'Invalid repo format. Expected owner/repo.' })
    }

    const config = getConfig()

    const result: HealthCheckResult = {
      overall: 'healthy',
      checks: {
        ghCli: { ok: false, message: '' },
        config: { ok: false, message: '' },
        webhook: { ok: false, message: '' },
        deliveries: { ok: false, message: '' },
      },
    }

    // Check 1: Config
    const secretSet = config.secret.length > 0
    if (!config.enabled) {
      result.checks.config = {
        ok: false,
        message: 'Webhooks are disabled. Set GITHUB_WEBHOOK_ENABLED=true to enable.',
        details: { enabled: false, secretSet },
      }
      result.overall = 'unconfigured'
      // Still run other checks for diagnostic value
    } else if (!secretSet) {
      result.checks.config = {
        ok: false,
        message: 'No webhook secret configured. Set GITHUB_WEBHOOK_SECRET to secure the endpoint.',
        details: { enabled: true, secretSet: false },
      }
      result.overall = 'unconfigured'
    } else {
      result.checks.config = {
        ok: true,
        message: 'Webhooks enabled with secret configured.',
        details: { enabled: true, secretSet: true },
      }
    }

    // Check 2: gh CLI
    const ghHealth = await checkGhHealth()
    if (!ghHealth.available) {
      result.checks.ghCli = { ok: false, message: ghHealth.reason || 'gh CLI unavailable' }
      result.checks.webhook = { ok: false, message: 'Skipped — gh CLI unavailable' }
      result.checks.deliveries = { ok: false, message: 'Skipped — gh CLI unavailable' }
      if (result.overall !== 'unconfigured') result.overall = 'broken'
      return res.json(result)
    }
    result.checks.ghCli = { ok: true, message: 'gh CLI authenticated and connected.' }

    // Check 3: Webhook exists on GitHub
    const hook = await findCodekinWebhook(repo, webhookUrl)
    if (!hook) {
      result.checks.webhook = { ok: false, message: `No webhook found on ${repo} pointing to this server.` }
      result.checks.deliveries = { ok: false, message: 'Skipped — no webhook found' }
      if (result.overall !== 'unconfigured') result.overall = 'broken'
      return res.json(result)
    }

    const requiredEvents = ['pull_request', 'workflow_run']
    const missingEvents = requiredEvents.filter(e => !hook.events.includes(e))

    if (!hook.active) {
      result.checks.webhook = {
        ok: false,
        message: 'Webhook exists but is inactive.',
        details: { id: hook.id, active: false, events: hook.events, url: hook.config.url },
      }
      if (result.overall === 'healthy') result.overall = 'degraded'
    } else if (missingEvents.length > 0) {
      result.checks.webhook = {
        ok: false,
        message: `Webhook is missing events: ${missingEvents.join(', ')}.`,
        details: { id: hook.id, active: true, events: hook.events, url: hook.config.url },
      }
      if (result.overall === 'healthy') result.overall = 'degraded'
    } else {
      result.checks.webhook = {
        ok: true,
        message: 'Webhook active with correct events.',
        details: { id: hook.id, active: true, events: hook.events, url: hook.config.url },
      }
    }

    // Check 4: Recent deliveries
    const rawDeliveries = await getWebhookDeliveries(repo, hook.id, 5)
    const deliveries = rawDeliveries.map(d => ({
      id: d.id,
      status: d.status,
      statusCode: d.status_code,
      deliveredAt: d.delivered_at,
      event: d.event,
    }))
    if (deliveries.length === 0) {
      result.checks.deliveries = {
        ok: true,
        message: 'No deliveries yet — webhook was recently created or no matching events have occurred.',
        details: { recent: [] },
      }
    } else {
      const failures = deliveries.filter(d => d.statusCode >= 400 || d.status === 'error')
      if (failures.length > 0) {
        result.checks.deliveries = {
          ok: false,
          message: `${failures.length} of ${deliveries.length} recent deliveries failed.`,
          details: { recent: deliveries },
        }
        if (result.overall === 'healthy') result.overall = 'degraded'
      } else {
        result.checks.deliveries = {
          ok: true,
          message: `All ${deliveries.length} recent deliveries succeeded.`,
          details: { recent: deliveries },
        }
      }
    }

    res.json(result)
  })

  // --- Preview setup endpoint ---

  router.post('/api/integrations/github/pr-review/setup', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { repo, webhookUrl, dryRun } = req.body as {
      repo?: string
      webhookUrl?: string
      dryRun?: boolean
    }

    if (!repo || !webhookUrl) {
      return res.status(400).json({ error: 'Missing required fields: repo, webhookUrl' })
    }
    if (!REPO_PATTERN.test(repo)) {
      return res.status(400).json({ error: 'Invalid repo format. Expected owner/repo.' })
    }

    // Preview first
    const preview = await previewSetup(repo, webhookUrl)

    if (dryRun || preview.action === 'none') {
      return res.json({ preview, secretGenerated: false })
    }

    // Ensure server is configured: generate secret if needed, enable if needed
    let config = getConfig()
    let secretGenerated = false
    const configUpdates: Record<string, unknown> = {}

    if (!config.secret) {
      configUpdates.secret = generateWebhookSecret()
      secretGenerated = true
    }
    if (!config.enabled) {
      configUpdates.enabled = true
    }

    if (Object.keys(configUpdates).length > 0) {
      saveWebhookConfig(configUpdates)
      config = getConfig()
    }

    try {
      let webhook
      if (preview.action === 'create') {
        webhook = await createRepoWebhook(
          repo,
          webhookUrl,
          config.secret,
          preview.proposed.events,
        )
      } else {
        // update
        webhook = await updateRepoWebhook(
          repo,
          preview.existing!.id,
          {
            events: preview.proposed.events,
            active: true,
            secret: secretGenerated ? config.secret : undefined,
          },
        )
      }

      res.json({ preview, webhook, secretGenerated })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.warn(`[webhook-setup] Failed to ${preview.action} webhook on ${repo}:`, err)
      res.status(500).json({ error: `Failed to ${preview.action} webhook: ${message}`, preview })
    }
  })

  // --- Test delivery endpoint ---

  router.post('/api/integrations/github/pr-review/test', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' })

    const { repo, webhookUrl } = req.body as { repo?: string; webhookUrl?: string }

    if (!repo || !webhookUrl) {
      return res.status(400).json({ error: 'Missing required fields: repo, webhookUrl' })
    }
    if (!REPO_PATTERN.test(repo)) {
      return res.status(400).json({ error: 'Invalid repo format. Expected owner/repo.' })
    }

    const hook = await findCodekinWebhook(repo, webhookUrl)
    if (!hook) {
      return res.status(404).json({ error: `No Codekin webhook found on ${repo}` })
    }

    const success = await pingWebhook(repo, hook.id)
    if (!success) {
      return res.json({ success: false, message: 'Ping failed — check GitHub API access and repo permissions.' })
    }

    // Brief pause then fetch latest delivery to confirm receipt
    await new Promise(r => setTimeout(r, 2000))
    const deliveries = await getWebhookDeliveries(repo, hook.id, 1)
    const latest = deliveries[0]

    res.json({
      success: true,
      message: 'Ping sent successfully.',
      delivery: latest ? { id: latest.id, statusCode: latest.status_code, event: latest.event } : undefined,
    })
  })

  return router
}
