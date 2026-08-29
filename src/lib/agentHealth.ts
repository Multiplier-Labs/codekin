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

import type { CodingProvider } from '../types'

export interface AgentHealth {
  claudeAvailable: boolean
  /** Claude auth (API key or subscription) — a probe, not ground truth. */
  claudeAuthenticated: boolean
  claudeVersion: string
  codexAvailable: boolean
  codexAuthenticated: boolean
  openCodeAvailable: boolean
}

let current: AgentHealth | null = null
const listeners = new Set<() => void>()

export function setAgentHealth(health: AgentHealth): void {
  current = health
  for (const listener of [...listeners]) listener()
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
      if (!health.claudeAvailable) return { available: false, hint: 'Claude CLI not installed on the host' }
      if (!health.claudeAuthenticated) return { available: true, hint: 'Claude CLI may not be signed in — run `claude` on the host' }
      return { available: true, hint: null }
    case 'codex':
      if (!health.codexAvailable) return { available: false, hint: 'Codex CLI not installed on the host' }
      if (!health.codexAuthenticated) return { available: true, hint: 'Codex not authenticated — run `codex login` on the host' }
      return { available: true, hint: null }
    case 'opencode':
      if (!health.openCodeAvailable) return { available: false, hint: 'OpenCode CLI not installed on the host' }
      return { available: true, hint: null }
  }
}
