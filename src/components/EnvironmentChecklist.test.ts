/** Tests for the checklist derivation — states, fix hints, readiness, and the no-usable-agent gate. */
import { describe, it, expect } from 'vitest'
import {
  buildChecklist,
  hasUsableAgent,
  isEnvironmentReady,
  readyAgentCount,
  type ChecklistEnv,
} from '../lib/environmentChecklist'
import type { AgentHealth } from '../lib/agentHealth'

function health(overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    claudeAvailable: true,
    claudeAuthenticated: true,
    claudeVersion: '2.1.220 (Claude Code)',
    codexAvailable: true,
    codexAuthenticated: true,
    openCodeAvailable: true,
    ...overrides,
  }
}

function env(overrides: Partial<ChecklistEnv> = {}): ChecklistEnv {
  return { ghStatus: 'ok', repoCount: 3, ...overrides }
}

const onlyCodex = { claudeAvailable: false, claudeAuthenticated: false, openCodeAvailable: false }

describe('buildChecklist', () => {
  it('marks everything ready in a healthy environment, with the Claude version as detail', () => {
    const rows = buildChecklist(health(), env({ repoCount: 12 }))
    expect(rows.every((r) => r.state === 'ready')).toBe(true)
    expect(rows.find((r) => r.id === 'claude')?.detail).toContain('2.1.220')
    expect(rows.find((r) => r.id === 'repos')?.detail).toBe('12 found')
  })

  it('shows unknown rows (not failures) before the connected frame arrives', () => {
    const rows = buildChecklist(null, env())
    for (const id of ['claude', 'opencode', 'codex']) {
      expect(rows.find((r) => r.id === id)?.state).toBe('unknown')
    }
  })

  it('a missing binary gets an install hint; a failed auth probe warns', () => {
    const rows = buildChecklist(health({ codexAvailable: false, claudeAuthenticated: false }), env())
    const codex = rows.find((r) => r.id === 'codex')
    expect(codex?.state).toBe('missing')
    expect(codex?.detail).toContain('codex login')
    const claude = rows.find((r) => r.id === 'claude')
    expect(claude?.state).toBe('warn')
  })

  it('gh missing: optional row with an install hint, never "set the repositories path"', () => {
    const gh = buildChecklist(health(), env({ ghStatus: 'missing' })).find((r) => r.id === 'gh')
    expect(gh).toMatchObject({ state: 'missing', optional: true })
    expect(gh?.detail).toContain('cli.github.com')
    expect(gh?.detail).not.toContain('repositories path')
  })

  it('gh unauthenticated: warns "not signed in — run gh auth login", not ready', () => {
    const gh = buildChecklist(health(), env({ ghStatus: 'unauthenticated' })).find((r) => r.id === 'gh')
    expect(gh?.state).toBe('warn')
    expect(gh?.detail).toMatch(/^not signed in — run `gh auth login`/)
    expect(gh?.detail).not.toContain('repositories path')
  })

  it('gh error: shows the server detail and reassures local repos still list', () => {
    const gh = buildChecklist(health(), env({ ghStatus: 'error', ghError: 'GitHub CLI timed out' })).find((r) => r.id === 'gh')
    expect(gh?.state).toBe('warn')
    expect(gh?.detail).toContain('GitHub CLI timed out')
  })

  it('gh unknown before the first response', () => {
    expect(buildChecklist(health(), env({ ghStatus: 'unknown' })).find((r) => r.id === 'gh')?.state).toBe('unknown')
  })

  it('repos row distinguishes loading, fetch failure, and a truly empty root', () => {
    const loading = buildChecklist(health(), env({ repoCount: 0, reposLoading: true })).find((r) => r.id === 'repos')
    expect(loading?.state).toBe('unknown')

    const failed = buildChecklist(health(), env({ repoCount: 0, reposError: 'Timed out loading repositories' })).find((r) => r.id === 'repos')
    expect(failed?.state).toBe('warn')
    expect(failed?.detail).toContain('Timed out')
    expect(failed?.detail).not.toContain('repositories path')

    const empty = buildChecklist(health(), env({ repoCount: 0 })).find((r) => r.id === 'repos')
    expect(empty?.state).toBe('warn')
    expect(empty?.detail).toContain('repositories path')
  })
})

describe('isEnvironmentReady', () => {
  it('true with one signed-in agent even when the others are missing', () => {
    const rows = buildChecklist(health(onlyCodex), env())
    expect(readyAgentCount(rows)).toBe(1)
    expect(isEnvironmentReady(rows)).toBe(true)
  })

  it('an unconnected GitHub CLI (any state) does not hold it open', () => {
    for (const ghStatus of ['missing', 'unauthenticated', 'error'] as const) {
      expect(isEnvironmentReady(buildChecklist(health(), env({ ghStatus })))).toBe(true)
    }
  })

  it('false when no agent is signed in, even if one is installed', () => {
    const rows = buildChecklist(health({ ...onlyCodex, codexAuthenticated: false }), env())
    expect(hasUsableAgent(rows)).toBe(true)
    expect(isEnvironmentReady(rows)).toBe(false)
  })

  it('false with no repositories, while loading, or before agent health arrives', () => {
    expect(isEnvironmentReady(buildChecklist(health(), env({ repoCount: 0 })))).toBe(false)
    expect(isEnvironmentReady(buildChecklist(health(), env({ repoCount: 0, reposLoading: true })))).toBe(false)
    expect(isEnvironmentReady(buildChecklist(null, env()))).toBe(false)
  })
})

describe('hasUsableAgent', () => {
  it('true when at least one agent is ready or merely warned', () => {
    expect(hasUsableAgent(buildChecklist(health({ codexAvailable: false, openCodeAvailable: false }), env()))).toBe(true)
    expect(hasUsableAgent(buildChecklist(health({ claudeAuthenticated: false, codexAvailable: false, openCodeAvailable: false }), env()))).toBe(true)
  })

  it('false when every agent binary is missing', () => {
    const none = health({ claudeAvailable: false, codexAvailable: false, openCodeAvailable: false })
    expect(hasUsableAgent(buildChecklist(none, env()))).toBe(false)
  })
})
