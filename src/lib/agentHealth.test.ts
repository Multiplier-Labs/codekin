/** Tests for the agent-health store and the provider availability policy. */
import { describe, it, expect, beforeEach } from 'vitest'
import { setAgentHealth, getAgentHealth, subscribeAgentHealth, providerAvailability, type AgentHealth } from './agentHealth'

function health(overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    claudeAvailable: true,
    claudeAuthenticated: true,
    claudeVersion: '2.0.0',
    codexAvailable: true,
    codexAuthenticated: true,
    openCodeAvailable: true,
    ...overrides,
  }
}

describe('providerAvailability', () => {
  it('fails open when health is unknown', () => {
    for (const p of ['claude', 'opencode', 'codex'] as const) {
      expect(providerAvailability(null, p)).toEqual({ available: true, hint: null })
    }
  })

  it('everything installed and signed in → no hints', () => {
    for (const p of ['claude', 'opencode', 'codex'] as const) {
      expect(providerAvailability(health(), p)).toEqual({ available: true, hint: null })
    }
  })

  it('a missing binary disables the provider', () => {
    expect(providerAvailability(health({ claudeAvailable: false }), 'claude').available).toBe(false)
    expect(providerAvailability(health({ codexAvailable: false }), 'codex').available).toBe(false)
    expect(providerAvailability(health({ openCodeAvailable: false }), 'opencode').available).toBe(false)
  })

  it('a failed auth probe warns but does not block', () => {
    const claude = providerAvailability(health({ claudeAuthenticated: false }), 'claude')
    expect(claude.available).toBe(true)
    expect(claude.hint).toContain('signed in')

    const codex = providerAvailability(health({ codexAuthenticated: false }), 'codex')
    expect(codex.available).toBe(true)
    expect(codex.hint).toContain('codex login')
  })
})

describe('store', () => {
  beforeEach(() => {
    // Reset by setting a fresh value — the module keeps a singleton.
    setAgentHealth(health())
  })

  it('stores the latest health and notifies subscribers', () => {
    let notified = 0
    const unsubscribe = subscribeAgentHealth(() => { notified += 1 })

    setAgentHealth(health({ codexAvailable: false }))
    expect(getAgentHealth()?.codexAvailable).toBe(false)
    expect(notified).toBe(1)

    unsubscribe()
    setAgentHealth(health())
    expect(notified).toBe(1)
  })
})
