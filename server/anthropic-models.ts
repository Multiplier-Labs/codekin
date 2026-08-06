/**
 * Discovers available Claude models via two strategies:
 *
 * 1. **Anthropic API** — `GET /v1/models` using ANTHROPIC_API_KEY (if set).
 *    Returns the full catalog, cached for 1 hour.
 *
 * 2. **CLI probing** — Spawns `claude -p --model <id> "ok"` for each candidate
 *    ID and reads the resolved model ID from the JSON output's `modelUsage`
 *    field. Runs once per day, triggered on first session creation. Works with
 *    OAuth/subscription auth (no API key).
 *
 * Probe failures are classified: a 404/403 from the API means the model
 * genuinely doesn't exist (or isn't accessible) and it is dropped; any other
 * failure (rate limit, overload, timeout) is transient — it is retried once,
 * and a model already in the cache survives it. Without this, one bad probe
 * run silently evicted live models for a full cache TTL.
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
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-fable-5', label: 'Fable 5' },
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
 * probes cost ~$0.04 each.
 */
const CANDIDATE_MODEL_IDS: string[] = [
  // 5th-generation IDs are dateless and single-number — `claude-opus-5`, NOT
  // `claude-opus-5-0`. The `-0` guesses probed here originally never matched
  // anything, which is why Opus 5 stayed invisible in the UI.
  // Fable family (GA 2026-06-09).
  'claude-fable-5',
  'claude-fable-6',
  // Opus family (4.6/4.7/4.8 and 5 are live; probe ahead for new releases)
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-6',
  // Sonnet family (4.6 and 5 are live; probe ahead)
  'claude-sonnet-4-6',
  'claude-sonnet-4-7',
  'claude-sonnet-5',
  'claude-sonnet-6',
  // Haiku family (currently 4.5 is latest — note dated suffix; probe ahead)
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-6',
  'claude-haiku-5',
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
 *      "claude-fable-5" → "Fable 5"  (single-version, dateless IDs)
 */
function labelFromId(id: string): string {
  const rest = id.replace(/^claude-/, '')
  const m = rest.match(/^(\w+?)-(\d+)(?:-(\d+))?/)
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
  }
  return id
}

/**
 * Preference order for model families at the same version. Consumers treat
 * entry [0] of the discovered list as "the default model", so the list has to
 * be ordered by preference, not by probe order or by release date — Fable is
 * the newest family but is a specialised model, not the general default.
 */
const FAMILY_RANK: Record<string, number> = { opus: 0, sonnet: 1, fable: 2, haiku: 3 }

/** Parse `claude-opus-4-8` → { family: 'opus', version: 4.8 } for ranking. */
function rankKey(id: string): { family: number; version: number } {
  const m = id.replace(/^claude-/, '').match(/^(\w+?)-(\d+)(?:-(\d+))?/)
  if (!m) return { family: FAMILY_RANK.haiku + 1, version: 0 }
  const family = FAMILY_RANK[m[1]] ?? Object.keys(FAMILY_RANK).length
  // Ignore dated suffixes (haiku-4-5-20251001 → 4.5): a 4-digit third group is a date.
  const minor = m[3] && m[3].length <= 2 ? Number(m[3]) : 0
  return { family, version: Number(m[2]) + minor / 10 }
}

/** Newest version first; ties broken by family preference (opus > sonnet > fable > haiku). */
function sortByPreference<T extends { id: string }>(models: T[]): T[] {
  return [...models].sort((a, b) => {
    const ka = rankKey(a.id)
    const kb = rankKey(b.id)
    return kb.version - ka.version || ka.family - kb.family || a.id.localeCompare(b.id)
  })
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

  const models = sortByPreference(
    data.data
      .filter(m => m.id.startsWith('claude-') && !m.id.includes('embed'))
      .map(m => ({ id: m.id, label: m.display_name || labelFromId(m.id) })),
  )

  return models.length > 0 ? models : null
}

// ---------------------------------------------------------------------------
// Strategy 2: CLI alias probing
// ---------------------------------------------------------------------------

/** Max concurrent CLI probes — 15 simultaneous spawns can trip rate limits,
 *  and a rate-limited probe is indistinguishable from a slow one. */
const PROBE_CONCURRENCY = 4
/** Delay before retrying probes that failed transiently. */
const PROBE_RETRY_DELAY_MS = 5_000

/** Shape every legitimate model ID takes. `execFile` passes an argument array
 *  (no shell), so this is a tripwire against a future refactor feeding
 *  user-supplied IDs into the probe, not a fix for a live injection. */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/

type ProbeResult =
  | { status: 'available'; id: string }
  /** Definitive 404/403 — the model doesn't exist or this account can't use it. */
  | { status: 'unavailable' }
  /** Transient failure (rate limit, overload, timeout, unparsable output). */
  | { status: 'error' }

/**
 * Probe a single model ID via the CLI. Failed probes return in ~2.5s without
 * consuming tokens; successful probes take ~4.5s and cost ~$0.04 (one short turn).
 *
 * The CLI exits non-zero on API errors but still writes the result JSON to
 * stdout, so parse it regardless of the exit code — `api_error_status` is the
 * only way to tell "model doesn't exist" (404) from "API had a bad moment".
 */
function probeModel(modelId: string): Promise<ProbeResult> {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    console.warn(`[model-probe] refusing to probe malformed model ID: ${modelId}`)
    return Promise.resolve({ status: 'unavailable' })
  }
  return new Promise(resolve => {
    const child = execFile(
      CLAUDE_BINARY,
      // Note: do NOT pass --bare — it strips the modelUsage field we need.
      ['-p', '--model', modelId, '--output-format', 'json', 'reply with only: ok'],
      { timeout: 30_000 },
      (err, stdout) => {
        try {
          const result = JSON.parse(stdout) as {
            is_error?: boolean
            api_error_status?: number | null
            modelUsage?: Record<string, unknown>
          }
          if (result.is_error || err) {
            const status = result.api_error_status
            resolve(status === 404 || status === 403 ? { status: 'unavailable' } : { status: 'error' })
            return
          }
          const id = Object.keys(result.modelUsage ?? {})[0]
          resolve(id ? { status: 'available', id } : { status: 'error' })
        } catch {
          resolve({ status: 'error' })
        }
      },
    )
    child.unref?.()
  })
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Probe all candidate model IDs. Transient failures are retried once; if a
 * candidate still can't be probed, its previously-cached entry (if any) is
 * carried over so a flaky probe run never shrinks the model list. Only a
 * definitive 404/403 removes a model.
 */
async function fetchViaCli(): Promise<ClaudeModelInfo[] | null> {
  const results = await mapWithConcurrency(CANDIDATE_MODEL_IDS, PROBE_CONCURRENCY, probeModel)

  const failedIdx = results.flatMap((r, i) => (r.status === 'error' ? [i] : []))
  if (failedIdx.length > 0) {
    await delay(PROBE_RETRY_DELAY_MS)
    const retried = await mapWithConcurrency(
      failedIdx.map(i => CANDIDATE_MODEL_IDS[i]),
      PROBE_CONCURRENCY,
      probeModel,
    )
    failedIdx.forEach((idx, j) => {
      if (retried[j].status !== 'error') results[idx] = retried[j]
    })
  }

  const previous = new Map((cache?.models ?? []).map(m => [m.id, m]))
  const models: ClaudeModelInfo[] = []
  const seen = new Set<string>()
  let carriedOver = 0

  results.forEach((result, i) => {
    if (result.status === 'available') {
      if (!seen.has(result.id)) {
        seen.add(result.id)
        models.push({ id: result.id, label: labelFromId(result.id) })
      }
    } else if (result.status === 'error') {
      // Transient failure — keep the last-known-good entry for this candidate.
      const kept = previous.get(CANDIDATE_MODEL_IDS[i])
      if (kept && !seen.has(kept.id)) {
        seen.add(kept.id)
        models.push(kept)
        carriedOver++
      }
    }
  })

  const errors = results.filter(r => r.status === 'error').length
  if (errors > 0) {
    console.warn(`[model-probe] ${errors} probe(s) failed transiently after retry, ${carriedOver} model(s) carried over from previous run`)
  }

  return models.length > 0 ? sortByPreference(models) : null
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

/** Start a CLI probe and update the cache when it completes. */
function startCliProbe(): Promise<void> {
  return fetchViaCli()
    .then(models => {
      if (models) {
        cache = { models, expiresAt: Date.now() + CLI_CACHE_TTL_MS }
      }
    })
    .catch(() => { /* keep fallback */ })
    .finally(() => { probeInFlight = null })
}

/**
 * Trigger a background CLI probe if the cache is stale or empty.
 * Call this on first session creation of the day. Non-blocking — returns
 * immediately and updates the cache when the probe finishes.
 */
export function triggerCliProbeIfNeeded(): void {
  // Skip if cache is still valid or a probe is already running
  if (cache && Date.now() < cache.expiresAt) return
  if (probeInFlight) return

  // Skip if API key is available (fetchAnthropicModels will use the API instead)
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY) return

  probeInFlight = startCliProbe()
}

/** Minimum gap between two completed forced refreshes. Concurrent callers
 *  already share one `probeInFlight` promise, so the cost that needs bounding
 *  is *sequential* hammering: each finished probe spawns a fresh round of CLI
 *  processes at ~$0.04 per live model. */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000
let lastRefreshAt = 0

/**
 * Milliseconds until another forced refresh is allowed, or 0 when one may run
 * now. A refresh already in flight is not throttled — the caller just joins it.
 */
export function refreshCooldownRemainingMs(): number {
  if (probeInFlight) return 0
  return Math.max(0, lastRefreshAt + REFRESH_COOLDOWN_MS - Date.now())
}

/**
 * Force a rediscovery, bypassing the cache TTL, and return the fresh list.
 * The expired cache is kept (not cleared) so the probe's last-known-good
 * carry-over still works. Called by POST /api/claude/models/refresh, which
 * gates on `refreshCooldownRemainingMs()` first.
 */
export async function refreshAnthropicModels(): Promise<ClaudeModelInfo[]> {
  if (cache) cache.expiresAt = 0

  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY) {
    // The API path costs nothing per call, but keep the clock honest so a
    // later key-less refresh still sees a sane cooldown.
    lastRefreshAt = Date.now()
    return fetchAnthropicModels()
  }

  if (!probeInFlight) probeInFlight = startCliProbe()
  await probeInFlight
  lastRefreshAt = Date.now()
  return cache ? cache.models : FALLBACK_MODELS
}
