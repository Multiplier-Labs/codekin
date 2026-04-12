/**
 * GitHub API helpers for webhook discovery and management.
 *
 * Used by the integration health-check and setup-wizard endpoints.
 * Follows the same patterns as webhook-github.ts: injectable ghRunner,
 * graceful degradation, console warnings on failure.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitHubWebhook, GitHubDelivery, SetupPreview } from './webhook-types.js'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000

type GhRunner = (args: string[]) => Promise<string>

let ghRunner: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
  return stdout
}

/** @internal Test-only: override the gh CLI runner */
export function _setGhRunner(runner: GhRunner): void {
  ghRunner = runner
}

/** @internal Test-only: reset to default gh CLI runner */
export function _resetGhRunner(): void {
  ghRunner = async (args) => {
    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
    return stdout
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Discovery
// ---------------------------------------------------------------------------

/**
 * List all webhooks configured on a GitHub repository.
 * Requires admin access to the repo.
 */
export async function listRepoWebhooks(repo: string): Promise<GitHubWebhook[]> {
  try {
    const raw = await ghRunner(['api', `/repos/${repo}/hooks`, '--paginate'])
    const hooks = JSON.parse(raw) as GitHubWebhook[]
    return Array.isArray(hooks) ? hooks : []
  } catch (err) {
    console.warn(`listRepoWebhooks: failed for ${repo}:`, err)
    return []
  }
}

/**
 * Find the Codekin webhook on a repo by matching the configured URL.
 */
export async function findCodekinWebhook(
  repo: string,
  webhookUrl: string,
): Promise<GitHubWebhook | null> {
  const hooks = await listRepoWebhooks(repo)
  return hooks.find(h => h.config.url === webhookUrl) ?? null
}

/**
 * Fetch recent webhook deliveries for a specific hook.
 */
export async function getWebhookDeliveries(
  repo: string,
  hookId: number,
  count = 5,
): Promise<GitHubDelivery[]> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/hooks/${hookId}/deliveries?per_page=${count}`,
    ])
    const deliveries = JSON.parse(raw) as GitHubDelivery[]
    return Array.isArray(deliveries) ? deliveries : []
  } catch (err) {
    console.warn(`getWebhookDeliveries: failed for ${repo} hook ${hookId}:`, err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Setup & Management
// ---------------------------------------------------------------------------

/**
 * Create a new webhook on a GitHub repository.
 */
export async function createRepoWebhook(
  repo: string,
  url: string,
  secret: string,
  events: string[],
): Promise<GitHubWebhook> {
  const body = JSON.stringify({
    name: 'web',
    active: true,
    events,
    config: { url, content_type: 'json', secret, insecure_ssl: '0' },
  })
  const raw = await ghRunnerWithStdin(
    ['api', `/repos/${repo}/hooks`, '--method', 'POST', '--input', '-'],
    body,
  )
  return JSON.parse(raw) as GitHubWebhook
}

/**
 * Update an existing webhook on a GitHub repository.
 */
export async function updateRepoWebhook(
  repo: string,
  hookId: number,
  updates: {
    url?: string
    events?: string[]
    active?: boolean
    secret?: string
  },
): Promise<GitHubWebhook> {
  const body: Record<string, unknown> = {}
  if (updates.events) body.events = updates.events
  if (updates.active !== undefined) body.active = updates.active
  const config: Record<string, string> = {}
  if (updates.url) config.url = updates.url
  if (updates.secret) config.secret = updates.secret
  if (Object.keys(config).length > 0) {
    config.content_type = 'json'
    config.insecure_ssl = '0'
    body.config = config
  }

  const raw = await ghRunnerWithStdin(
    ['api', `/repos/${repo}/hooks/${hookId}`, '--method', 'PATCH', '--input', '-'],
    JSON.stringify(body),
  )
  return JSON.parse(raw) as GitHubWebhook
}

/**
 * Send a ping event to a webhook.
 */
export async function pingWebhook(repo: string, hookId: number): Promise<boolean> {
  try {
    await ghRunner([
      'api', `/repos/${repo}/hooks/${hookId}/pings`,
      '--method', 'POST',
    ])
    return true
  } catch (err) {
    console.warn(`pingWebhook: failed for ${repo} hook ${hookId}:`, err)
    return false
  }
}

/**
 * Preview what a webhook setup would do (create vs update vs nothing).
 */
export async function previewWebhookSetup(
  repo: string,
  webhookUrl: string,
): Promise<SetupPreview> {
  const existing = await findCodekinWebhook(repo, webhookUrl)
  const requiredEvents = ['pull_request', 'workflow_run']

  if (!existing) {
    return {
      action: 'create',
      proposed: { url: webhookUrl, events: requiredEvents, active: true },
    }
  }

  const changes: string[] = []
  if (!existing.active) changes.push('Activate webhook (currently inactive)')
  const missingEvents = requiredEvents.filter(e => !existing.events.includes(e))
  if (missingEvents.length > 0) {
    changes.push(`Add missing events: ${missingEvents.join(', ')}`)
  }

  if (changes.length === 0) {
    return { action: 'none', existing, proposed: { url: webhookUrl, events: existing.events, active: true } }
  }

  return {
    action: 'update',
    existing,
    proposed: {
      url: webhookUrl,
      events: [...new Set([...existing.events, ...requiredEvents])],
      active: true,
    },
    changes,
  }
}

// ---------------------------------------------------------------------------
// Internal: gh runner with stdin support (for POST/PATCH bodies)
// ---------------------------------------------------------------------------

async function ghRunnerWithStdin(args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile('gh', args, { timeout: GH_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        reject(err as Error)
        return
      }
      resolve(stdout)
    })
    proc.stdin?.write(stdin)
    proc.stdin?.end()
  })
}
