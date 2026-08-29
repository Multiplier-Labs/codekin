/**
 * Checklist derivation for the first-run environment surface (audit N1).
 * Pure — the component in components/EnvironmentChecklist.tsx renders it.
 */

import { PROVIDERS } from '../types'
import { providerAvailability, type AgentHealth } from './agentHealth'

export type ChecklistState = 'ready' | 'warn' | 'missing' | 'unknown'

export interface ChecklistRow {
  id: string
  label: string
  state: ChecklistState
  /** Version, caveat, or the exact fix — whatever the state needs. */
  detail: string | null
}

const INSTALL_HINTS: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  codex: 'install the Codex CLI, then run `codex login`',
  opencode: 'install the OpenCode CLI',
}

/** Derive the checklist rows. Pure — exported for tests. */
export function buildChecklist(health: AgentHealth | null, ghMissing: boolean, repoCount: number): ChecklistRow[] {
  const rows: ChecklistRow[] = PROVIDERS.map((p) => {
    if (!health) return { id: p.id, label: p.label, state: 'unknown' as const, detail: 'checking…' }
    const { available, hint } = providerAvailability(health, p.id)
    if (!available) return { id: p.id, label: p.label, state: 'missing' as const, detail: INSTALL_HINTS[p.id] ?? null }
    if (hint) return { id: p.id, label: p.label, state: 'warn' as const, detail: hint }
    return {
      id: p.id,
      label: p.label,
      state: 'ready' as const,
      detail: p.id === 'claude' && health.claudeVersion ? health.claudeVersion : null,
    }
  })

  rows.push(
    ghMissing
      ? { id: 'gh', label: 'GitHub CLI', state: 'missing', detail: 'install from https://cli.github.com, then run `gh auth login`' }
      : { id: 'gh', label: 'GitHub CLI', state: 'ready', detail: null },
  )
  rows.push(
    repoCount > 0
      ? { id: 'repos', label: 'Repositories', state: 'ready', detail: `${repoCount} found` }
      : { id: 'repos', label: 'Repositories', state: 'warn', detail: 'none found — set the repositories path below' },
  )
  return rows
}

/** At least one agent must be usable for Codekin to do anything at all. */
export function hasUsableAgent(rows: ChecklistRow[]): boolean {
  return rows.some((r) => ['claude', 'opencode', 'codex'].includes(r.id) && (r.state === 'ready' || r.state === 'warn'))
}

