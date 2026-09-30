/**
 * Checklist derivation for the first-run environment surface (audits N1, N6).
 * Pure — the component in components/EnvironmentChecklist.tsx renders it.
 *
 * Readiness policy: one usable, signed-in agent is enough; the other agents
 * and the GitHub CLI are optional and never hold the checklist open on their
 * own. The repositories row is the only other required check.
 */

import { PROVIDERS } from '../types'
import { providerAvailability, type AgentHealth } from './agentHealth'
import type { GhStatus } from '../hooks/useRepos'

export type ChecklistState = 'ready' | 'warn' | 'missing' | 'unknown'

export interface ChecklistRow {
  id: string
  label: string
  state: ChecklistState
  /** Version, caveat, or the exact fix — whatever the state needs. */
  detail: string | null
  /** Not required for readiness (other agents once one is usable; GitHub CLI). */
  optional?: boolean
}

export interface ChecklistEnv {
  ghStatus: GhStatus
  /** Server-reported gh failure detail, for the `error` state. */
  ghError?: string | null
  repoCount: number
  reposLoading?: boolean
  /** The repository fetch itself failed (network, timeout). */
  reposError?: string | null
}

const AGENT_IDS: readonly string[] = PROVIDERS.map((p) => p.id)

const INSTALL_HINTS: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  codex: 'install the Codex CLI, then run `codex login`',
  opencode: 'install the OpenCode CLI',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash, then run `grok login`',
}

function ghRow(env: ChecklistEnv): ChecklistRow {
  const base = { id: 'gh', label: 'GitHub CLI', optional: true }
  switch (env.ghStatus) {
    case 'ok':
      return { ...base, state: 'ready', detail: null }
    case 'unknown':
      return { ...base, state: 'unknown', detail: 'checking…' }
    case 'missing':
      return {
        ...base,
        state: 'missing',
        detail: 'optional — install from https://cli.github.com and run `gh auth login` to list and clone GitHub repos',
      }
    case 'unauthenticated':
      return { ...base, state: 'warn', detail: 'not signed in — run `gh auth login` on the host to list and clone GitHub repos' }
    case 'error':
      return { ...base, state: 'warn', detail: `${env.ghError || 'GitHub CLI failed'} — local repositories are still listed` }
  }
}

function reposRow(env: ChecklistEnv): ChecklistRow {
  const base = { id: 'repos', label: 'Repositories' }
  if (env.repoCount > 0) return { ...base, state: 'ready', detail: `${env.repoCount} found` }
  if (env.reposError) return { ...base, state: 'warn', detail: `${env.reposError} — retry below` }
  if (env.reposLoading) return { ...base, state: 'unknown', detail: 'loading…' }
  return {
    ...base,
    state: 'warn',
    detail: env.ghStatus === 'ok'
      ? 'none found — set the repositories path below'
      : 'no Git checkouts found under the repositories path — change it below',
  }
}

/** Derive the checklist rows. Pure — exported for tests. */
export function buildChecklist(health: AgentHealth | null, env: ChecklistEnv): ChecklistRow[] {
  const rows: ChecklistRow[] = PROVIDERS.map((p) => {
    // Each agent is individually optional; readiness needs at least one (see isEnvironmentReady).
    const base = { id: p.id, label: p.label, optional: true }
    if (!health) return { ...base, state: 'unknown' as const, detail: 'checking…' }
    const { available, hint } = providerAvailability(health, p.id)
    if (!available) return { ...base, state: 'missing' as const, detail: INSTALL_HINTS[p.id] ?? null }
    if (hint) return { ...base, state: 'warn' as const, detail: hint }
    return {
      ...base,
      state: 'ready' as const,
      detail: p.id === 'claude' && health.claudeVersion ? health.claudeVersion : null,
    }
  })

  rows.push(ghRow(env))
  rows.push(reposRow(env))
  return rows
}

function isAgentRow(row: ChecklistRow): boolean {
  return AGENT_IDS.includes(row.id)
}

/** At least one agent must be usable for Codekin to do anything at all. */
export function hasUsableAgent(rows: ChecklistRow[]): boolean {
  return rows.some((r) => isAgentRow(r) && (r.state === 'ready' || r.state === 'warn'))
}

/** Number of agents that are installed and signed in. */
export function readyAgentCount(rows: ChecklistRow[]): number {
  return rows.filter((r) => isAgentRow(r) && r.state === 'ready').length
}

/**
 * True when the environment needs no attention: at least one agent is ready
 * and every required (non-optional) row is ready. Missing optional agents or
 * an unconnected GitHub CLI don't count against it.
 */
export function isEnvironmentReady(rows: ChecklistRow[]): boolean {
  return readyAgentCount(rows) > 0 && rows.every((r) => r.optional || r.state === 'ready')
}
