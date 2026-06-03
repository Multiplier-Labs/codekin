/**
 * Discovers available Claude models via two strategies:
 *
 * 1. **Anthropic API** — `GET /v1/models` using ANTHROPIC_API_KEY (if set).
 *    Returns the full catalog, cached for 1 hour.
 *
 * 2. **CLI alias probing** — Spawns `claude -p --model <alias> "ok"` for each
 *    known alias (opus, sonnet, haiku) and reads the resolved model ID from
 *    the JSON output's `modelUsage` field. Runs once per day, triggered on
 *    first session creation. Works with OAuth/subscription auth (no API key).
 *
 * Falls back to a hardcoded list when neither strategy has completed yet.
 */

import { execFile } from 'child_process'
import { CLAUDE_BINARY } from './config.js'

export interface ClaudeModelInfo {
  id: string
  label: string
}

/** Hardcoded fallback used until dynamic discovery completes. */
export const FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

/** Known CLI aliases to probe. The CLI resolves these to the latest model IDs. */
const CLI_ALIASES = ['opus', 'sonnet', 'haiku'] as const

// ---------------------------------------------------------------------------
// Shared cache
// ---------------------------------------------------------------------------

let cache: { models: ClaudeModelInfo[]; expiresAt: number } | null = null
const API_CACHE_TTL_MS = 60 * 60 * 1000     // 1 hour  (API is cheap, refresh often)
const CLI_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours (CLI probing costs tokens)

/** In-flight probe promise — prevents duplicate concurrent probes. */
let probeInFlight: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Label helper
// ---------------------------------------------------------------------------

/**
 * Build a human-friendly label from a model ID.
 * e.g. "claude-opus-4-8" → "Opus 4.8"
 *      "claude-haiku-4-5-20251001" → "Haiku 4.5"
 */
function labelFromId(id: string): string {
  const rest = id.replace(/^claude-/, '')
  const m = rest.match(/^(\w+?)-(\d+)-(\d+)/)
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return `${family} ${m[2]}.${m[3]}`
  }
  return id
}

// ---------------------------------------------------------------------------
// Strategy 1: Anthropic API
// ---------------------------------------------------------------------------

interface AnthropicModelsResponse {
  data: Array<{
    id: string
    display_name?: string
    created_at?: string
  }>
}

async function fetchViaApi(): Promise<ClaudeModelInfo[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY
  if (!apiKey) return null

  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null

  const data = (await res.json()) as AnthropicModelsResponse
  if (!Array.isArray(data.data) || data.data.length === 0) return null

  const models = data.data
    .filter(m => m.id.startsWith('claude-') && !m.id.includes('embed'))
    .sort((a, b) => {
      if (a.created_at && b.created_at) return b.created_at.localeCompare(a.created_at)
      return 0
    })
    .map(m => ({ id: m.id, label: m.display_name || labelFromId(m.id) }))

  return models.length > 0 ? models : null
}

// ---------------------------------------------------------------------------
// Strategy 2: CLI alias probing
// ---------------------------------------------------------------------------

/** Probe a single CLI alias and return the resolved model ID, or null on failure. */
function probeAlias(alias: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      CLAUDE_BINARY,
      ['-p', '--model', alias, '--output-format', 'json', '--bare', 'reply with only: ok'],
      { timeout: 30_000, env: { ...process.env, CLAUDE_CODE_SIMPLE: '1' } },
      (err, stdout) => {
        if (err) { resolve(null); return }
        try {
          const result = JSON.parse(stdout)
          // modelUsage is { "claude-opus-4-8": { ... } } — grab the first key
          const modelId = Object.keys(result.modelUsage || {})[0]
          resolve(modelId || null)
        } catch {
          resolve(null)
        }
      },
    )
    // Ensure we don't leak the child if something goes wrong
    child.unref?.()
  })
}

/** Probe all known aliases in parallel. Returns discovered models. */
async function fetchViaCli(): Promise<ClaudeModelInfo[] | null> {
  const results = await Promise.all(CLI_ALIASES.map(probeAlias))
  const models: ClaudeModelInfo[] = []
  const seen = new Set<string>()

  for (const id of results) {
    if (id && !seen.has(id)) {
      seen.add(id)
      models.push({ id, label: labelFromId(id) })
    }
  }

  return models.length > 0 ? models : null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return available Claude models. Uses cached results when valid.
 * Called by the GET /api/claude/models endpoint.
 */
export async function fetchAnthropicModels(): Promise<ClaudeModelInfo[]> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.models
  }

  // Strategy 1: Anthropic API (fast, full catalog)
  try {
    const apiModels = await fetchViaApi()
    if (apiModels) {
      cache = { models: apiModels, expiresAt: Date.now() + API_CACHE_TTL_MS }
      return apiModels
    }
  } catch { /* fall through */ }

  // If CLI probe has already cached results, use those
  if (cache) return cache.models

  return FALLBACK_MODELS
}

/**
 * Trigger a background CLI alias probe if the cache is stale or empty.
 * Call this on first session creation of the day. Non-blocking — returns
 * immediately and updates the cache when the probe finishes.
 */
export function triggerCliProbeIfNeeded(): void {
  // Skip if cache is still valid or a probe is already running
  if (cache && Date.now() < cache.expiresAt) return
  if (probeInFlight) return

  // Skip if API key is available (fetchAnthropicModels will use the API instead)
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY) return

  probeInFlight = fetchViaCli()
    .then(models => {
      if (models) {
        cache = { models, expiresAt: Date.now() + CLI_CACHE_TTL_MS }
      }
    })
    .catch(() => { /* keep fallback */ })
    .finally(() => { probeInFlight = null })
}
