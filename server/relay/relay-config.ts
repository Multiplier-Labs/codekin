/**
 * Configuration for the hosted relay / control plane server.
 *
 * Loaded from environment variables, with a fallback env file at
 * ~/.codekin-relay/env (KEY=VALUE lines) so pm2 and manual runs share one
 * source of truth. process.env always wins over the file.
 */

import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

export interface RelayConfig {
  /** Port the relay server listens on (bound to 127.0.0.1; nginx proxies to it). */
  port: number
  /** Public origin of the hosted app, e.g. https://app.codekin.ai */
  publicUrl: string
  githubClientId: string
  githubClientSecret: string
  sessionSecret: string
  /** GitHub login that gets the owner role. */
  ownerGithubLogin: string
  /** GitHub logins allowed in as active members (owner is always allowed). */
  allowedGithubLogins: string[]
  /** Data directory for the control-plane SQLite DB. */
  dataDir: string
  /** Days to keep audit events; 0 disables pruning (spec §12). */
  auditRetentionDays: number
  /** True when running behind TLS in production (secure cookies). */
  isProduction: boolean
}

/** Parse a KEY=VALUE env file. Ignores blank lines and # comments. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}

/**
 * Load config from process.env, falling back to the env file for any key
 * not set in the environment. Throws on missing required keys so the
 * process fails fast at boot instead of at first login.
 */
export function loadRelayConfig(opts: { envFile?: string; requireSecrets?: boolean } = {}): RelayConfig {
  const dataDir = process.env.RELAY_DATA_DIR || join(homedir(), '.codekin-relay')
  const envFile = opts.envFile ?? process.env.RELAY_ENV_FILE ?? join(dataDir, 'env')

  let fileEnv: Record<string, string | undefined> = {}
  if (existsSync(envFile)) {
    fileEnv = parseEnvFile(readFileSync(envFile, 'utf-8'))
  }

  const get = (key: string): string => process.env[key] ?? fileEnv[key] ?? ''

  const isProduction = (process.env.NODE_ENV ?? fileEnv['NODE_ENV']) === 'production'
  const requireSecrets = opts.requireSecrets ?? true

  const config: RelayConfig = {
    port: parseInt(get('RELAY_PORT') || '32360', 10),
    publicUrl: (get('PUBLIC_URL') || 'http://localhost:5173').replace(/\/$/, ''),
    githubClientId: get('GITHUB_CLIENT_ID'),
    githubClientSecret: get('GITHUB_CLIENT_SECRET'),
    sessionSecret: get('SESSION_SECRET'),
    ownerGithubLogin: get('OWNER_GITHUB_LOGIN'),
    allowedGithubLogins: get('ALLOWED_GITHUB_LOGINS')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    dataDir,
    auditRetentionDays: Math.max(0, parseInt(get('AUDIT_RETENTION_DAYS') || '90', 10) || 0),
    isProduction,
  }

  if (requireSecrets) {
    const missing: string[] = []
    if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (>= 32 chars)')
    if (!config.githubClientId || config.githubClientId === 'REPLACE_ME') missing.push('GITHUB_CLIENT_ID')
    if (!config.githubClientSecret || config.githubClientSecret === 'REPLACE_ME') missing.push('GITHUB_CLIENT_SECRET')
    if (!config.ownerGithubLogin) missing.push('OWNER_GITHUB_LOGIN')
    if (missing.length > 0) {
      throw new Error(`[relay-config] Missing required configuration: ${missing.join(', ')} (env file: ${envFile})`)
    }
  }

  return config
}
