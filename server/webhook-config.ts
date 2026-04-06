import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { WebhookConfig } from './webhook-types.js'

const CONFIG_FILE = join(homedir(), '.codekin', 'webhook-config.json')

export interface FullWebhookConfig extends WebhookConfig {
  secret: string
}

/**
 * Load webhook configuration from environment variables and optional config file.
 * Env vars take precedence over config file values.
 */
export function loadWebhookConfig(): FullWebhookConfig {
  // Defaults
  let enabled = false
  let maxConcurrentSessions = 15
  let logLinesToInclude = 200
  let actorAllowlist: string[] = []

  // Try loading config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      const file = JSON.parse(raw) as Partial<WebhookConfig>
      if (typeof file.enabled === 'boolean') enabled = file.enabled
      if (typeof file.maxConcurrentSessions === 'number') maxConcurrentSessions = file.maxConcurrentSessions
      if (typeof file.logLinesToInclude === 'number') logLinesToInclude = file.logLinesToInclude
      if (Array.isArray(file.actorAllowlist) && file.actorAllowlist.every(v => typeof v === 'string')) {
        actorAllowlist = file.actorAllowlist
      }
    } catch (err) {
      console.warn('[webhook] Failed to parse config file:', err)
    }
  }

  // Env vars override config file
  const envEnabled = process.env.GITHUB_WEBHOOK_ENABLED
  if (envEnabled !== undefined) {
    enabled = envEnabled === 'true' || envEnabled === '1'
  }

  const envMaxSessions = process.env.GITHUB_WEBHOOK_MAX_SESSIONS
  if (envMaxSessions !== undefined) {
    const n = parseInt(envMaxSessions, 10)
    if (!isNaN(n) && n > 0) maxConcurrentSessions = n
  }

  const envLogLines = process.env.GITHUB_WEBHOOK_LOG_LINES
  if (envLogLines !== undefined) {
    const n = parseInt(envLogLines, 10)
    if (!isNaN(n) && n > 0) logLinesToInclude = n
  }

  const envActorAllowlist = process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST
  if (envActorAllowlist !== undefined) {
    actorAllowlist = envActorAllowlist.split(',').map(s => s.trim()).filter(Boolean)
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET || ''

  return {
    enabled,
    secret,
    maxConcurrentSessions,
    logLinesToInclude,
    actorAllowlist,
  }
}
