/**
 * Agent availability, as reported by the server's startup probes.
 *
 * The `connected` WS frame has always carried which harness CLIs exist and
 * are authenticated on the host — and the client discarded it, so provider
 * pickers offered agents that were not installed and users discovered the
 * failure only after the session started. This module holds that frame's
 * data (a module-level store, same pattern as workflowEvents: the socket and
 * the pickers mount in different subtrees) and derives per-provider
 * availability for the pickers.
 */

import { PROVIDERS, type CodingProvider } from '../types'

export interface AgentHealth {
  claudeAvailable: boolean
  /** Claude auth (API key or subscription) — a probe, not ground truth. */
  claudeAuthenticated: boolean
  claudeVersion: string
  codexAvailable: boolean
  codexAuthenticated: boolean
  openCodeAvailable: boolean
  /** Absent from servers older than the Grok integration. */
  grokAvailable?: boolean
  grokAuthenticated?: boolean
}

/** The server's startup probes, as last received. */
let reported: AgentHealth | null = null
/** Result of the latest live Codex check (model list fetch); null = not run. */
let codexLive: boolean | null = null
/** `reported` with live checks applied; a stable reference for useSyncExternalStore. */
let current: AgentHealth | null = null
const listeners = new Set<() => void>()

/**
 * The server probes each CLI once, at boot, and keeps the answer until it
 * restarts. A CLI installed after boot (or whose `--version` probe timed out
 * at login) stays "not installed" in the pickers while the footer, which
 * lists Codex models live, says "Connected". A live model list is proof the
 * binary runs and is signed in, so it overrides a stale "not installed".
 * It never downgrades a probe: one failed fetch is weaker evidence than it.
 */
function applyLiveChecks(health: AgentHealth | null): AgentHealth | null {
  if (!health || codexLive !== true || health.codexAvailable) return health
  return { ...health, codexAvailable: true, codexAuthenticated: true }
}

function publish(): void {
  current = applyLiveChecks(reported)
  for (const listener of [...listeners]) listener()
}

export function setAgentHealth(health: AgentHealth): void {
  reported = health
  publish()
}

/**
 * Record the outcome of a live Codex check (the `/api/codex/models` fetch
 * behind the footer's Codex status), so the pickers agree with the footer.
 */
export function setCodexLiveCheck(reachable: boolean | null): void {
  if (reachable === codexLive) return
  codexLive = reachable
  publish()
}

export function getAgentHealth(): AgentHealth | null {
  return current
}

export function subscribeAgentHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export interface ProviderAvailability {
  /** False only for a hard fact (binary not installed) — the session cannot start. */
  available: boolean
  /** Soft caveat (auth not detected) or the reason for unavailability. */
  hint: string | null
}

/**
 * Availability policy: a missing binary disables the option (starting the
 * session can only fail); a failed auth probe merely warns (probes can be
 * wrong, and blocking the primary path on a heuristic is worse than one
 * failed attempt with a clear hint). Unknown health fails open.
 */
export function providerAvailability(health: AgentHealth | null, provider: CodingProvider): ProviderAvailability {
  if (!health) return { available: true, hint: null }
  switch (provider) {
    case 'claude':
      if (!health.claudeAvailable) return { available: false, hint: 'Claude CLI not found on the host — installed it since? Restart Codekin' }
      if (!health.claudeAuthenticated) return { available: true, hint: 'Claude CLI may not be signed in — run `claude` on the host' }
      return { available: true, hint: null }
    case 'codex':
      if (!health.codexAvailable) return { available: false, hint: 'Codex CLI not found on the host — installed it since? Restart Codekin' }
      if (!health.codexAuthenticated) return { available: true, hint: 'Codex not authenticated — run `codex login` on the host' }
      return { available: true, hint: null }
    case 'opencode':
      if (!health.openCodeAvailable) return { available: false, hint: 'OpenCode CLI not found on the host — installed it since? Restart Codekin' }
      return { available: true, hint: null }
    case 'grok':
      if (!health.grokAvailable) return { available: false, hint: 'Grok Build CLI not found on the host — installed it since? Restart Codekin' }
      if (!health.grokAuthenticated) return { available: true, hint: 'Grok not signed in — run `grok login` on the host' }
      return { available: true, hint: null }
    default:
      // A provider this client doesn't know: soft state, never a hard block.
      return { available: true, hint: null }
  }
}

function isProvider(value: unknown): value is CodingProvider {
  return PROVIDERS.some((p) => p.id === value)
}

/**
 * The provider a new session should start with when the caller didn't pick
 * one explicitly (audit N6).
 *
 * - `stored` is the user's saved choice (null if they never chose). A saved
 *   choice that is still installed is kept even if its auth probe warns —
 *   the user picked it, and probes can be wrong.
 * - Without a saved choice the implicit default is Claude, kept only when it
 *   is installed and signed in; otherwise the first fully healthy provider
 *   (installed, no caveat), then the first installed one.
 * - Unknown health (connected frame not received yet) never blocks: it
 *   returns the preference as-is.
 */
export function resolveDefaultProvider(health: AgentHealth | null, stored: string | null): CodingProvider {
  const explicit = isProvider(stored) ? stored : null
  const preferred: CodingProvider = explicit ?? 'claude'
  if (!health) return preferred

  const pref = providerAvailability(health, preferred)
  if (pref.available && (explicit || !pref.hint)) return preferred

  const healthy = PROVIDERS.find((p) => {
    const a = providerAvailability(health, p.id)
    return a.available && !a.hint
  })
  if (healthy) return healthy.id
  if (pref.available) return preferred
  return PROVIDERS.find((p) => providerAvailability(health, p.id).available)?.id ?? preferred
}
