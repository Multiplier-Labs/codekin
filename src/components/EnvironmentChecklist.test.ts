/** Tests for the checklist derivation — states, fix hints, and the no-usable-agent gate. */
import { describe, it, expect } from 'vitest'
import { buildChecklist, hasUsableAgent } from '../lib/environmentChecklist'
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

describe('buildChecklist', () => {
  it('marks everything ready in a healthy environment, with the Claude version as detail', () => {
    const rows = buildChecklist(health(), false, 12)
    expect(rows.every((r) => r.state === 'ready')).toBe(true)
    expect(rows.find((r) => r.id === 'claude')?.detail).toContain('2.1.220')
    expect(rows.find((r) => r.id === 'repos')?.detail).toBe('12 found')
  })

  it('shows unknown rows (not failures) before the connected frame arrives', () => {
    const rows = buildChecklist(null, false, 3)
    for (const id of ['claude', 'opencode', 'codex']) {
      expect(rows.find((r) => r.id === id)?.state).toBe('unknown')
    }
  })

  it('a missing binary gets an install hint; a failed auth probe warns', () => {
    const rows = buildChecklist(health({ codexAvailable: false, claudeAuthenticated: false }), false, 3)
    const codex = rows.find((r) => r.id === 'codex')
    expect(codex?.state).toBe('missing')
    expect(codex?.detail).toContain('codex login')
    const claude = rows.find((r) => r.id === 'claude')
    expect(claude?.state).toBe('warn')
  })

  it('surfaces gh and empty-repos problems with fixes', () => {
    const rows = buildChecklist(health(), true, 0)
    expect(rows.find((r) => r.id === 'gh')).toMatchObject({ state: 'missing' })
    expect(rows.find((r) => r.id === 'repos')?.state).toBe('warn')
  })
})

describe('hasUsableAgent', () => {
  it('true when at least one agent is ready or merely warned', () => {
    expect(hasUsableAgent(buildChecklist(health({ codexAvailable: false, openCodeAvailable: false }), false, 1))).toBe(true)
    expect(hasUsableAgent(buildChecklist(health({ claudeAuthenticated: false, codexAvailable: false, openCodeAvailable: false }), false, 1))).toBe(true)
  })

  it('false when every agent binary is missing', () => {
    const none = health({ claudeAvailable: false, codexAvailable: false, openCodeAvailable: false })
    expect(hasUsableAgent(buildChecklist(none, false, 1))).toBe(false)
  })
})
