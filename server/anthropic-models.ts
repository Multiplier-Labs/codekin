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

/** Hardcoded fallback used until dynamic discovery completes.
 *  Per https://platform.claude.com/docs/en/about-claude/models/overview */
export const FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

/**
 * Candidate model IDs to probe via the CLI. We don't probe aliases (opus/sonnet/haiku)
 * because the CLI's alias resolution lags — `opus` still resolves to 4-6 even when
 * 4-8 is the latest. Instead, we probe specific version IDs spanning current and
 * likely-future releases. Failed probes return in ~2.5s at zero cost; successful
 * probes cost ~$0.04 each. Probing in parallel keeps total wall time under 5s.
 */
const CANDIDATE_MODEL_IDS: string[] = [
  // Opus family (currently 4.6, 4.7, 4.8 are live; probe ahead for new releases)
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-4-9',
  'claude-opus-5-0',
  // Sonnet family (currently 4.6 is latest; probe ahead)
  'claude-sonnet-4-6',
  'claude-sonnet-4-7',
  'claude-sonnet-4-8',
  'claude-sonnet-5-0',
  // Haiku family (currently 4.5 is latest; probe ahead — note dated suffix)
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-6',
  'claude-haiku-4-7',
  'claude-haiku-5-0',
]

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

/**
 * Probe a single model ID via the CLI. Returns the model ID if available,
 * null otherwise. Failed probes return in ~2.5s without consuming tokens;
 * successful probes take ~4.5s and cost ~$0.04 (one short turn).
 */
function probeModel(modelId: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = execFile(
      CLAUDE_BINARY,
      // Note: do NOT pass --bare — it strips the modelUsage field we need.
      ['-p', '--model', modelId, '--output-format', 'json', 'reply with only: ok'],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) { resolve(null); return }
        try {
          const result = JSON.parse(stdout) as { is_error?: boolean; modelUsage?: Record<string, unknown> }
          if (result.is_error) { resolve(null); return }
          const id = Object.keys(result.modelUsage ?? {})[0]
          resolve(id || null)
        } catch {
          resolve(null)
        }
      },
    )
    child.unref?.()
  })
}

/** Probe all candidate model IDs in parallel. */
async function fetchViaCli(): Promise<ClaudeModelInfo[] | null> {
  const results = await Promise.all(CANDIDATE_MODEL_IDS.map(probeModel))
  const models: ClaudeModelInfo[] = []
  const seen = new Set<string>()

  for (const id of results) {
    if (id && !seen.has(id)) {
      seen.add(id)
      models.push({ id, label: labelFromId(id) })
    }
  }

  // Sort newest version first within each family (opus > sonnet > haiku ordering preserved by input)
  return models.length > 0 ? models : null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronously return the best-known default Claude model ID — the first
 * (newest) entry of the discovered list, or the hardcoded fallback's first
 * entry when discovery hasn't completed yet. This matches the model the
 * frontend auto-selects (the [0] of the same list), so new sessions start on
 * it directly instead of letting the CLI pick a stale default and forcing a
 * disruptive model-switch restart that drops the user's first message.
 */
export function getDefaultClaudeModel(): string {
  return (cache?.models[0] ?? FALLBACK_MODELS[0]).id
}

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
