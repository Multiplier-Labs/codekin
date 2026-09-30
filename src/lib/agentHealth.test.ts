/** Tests for the agent-health store and the provider availability policy. */
import { describe, it, expect, beforeEach } from 'vitest'
import { setAgentHealth, getAgentHealth, subscribeAgentHealth, providerAvailability, resolveDefaultProvider, type AgentHealth } from './agentHealth'

function health(overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    claudeAvailable: true,
    claudeAuthenticated: true,
    claudeVersion: '2.0.0',
    codexAvailable: true,
    codexAuthenticated: true,
    openCodeAvailable: true,
    grokAvailable: true,
    grokAuthenticated: true,
    ...overrides,
  }
}

describe('providerAvailability', () => {
  it('fails open when health is unknown', () => {
    for (const p of ['claude', 'opencode', 'codex', 'grok'] as const) {
      expect(providerAvailability(null, p)).toEqual({ available: true, hint: null })
    }
  })

  it('everything installed and signed in → no hints', () => {
    for (const p of ['claude', 'opencode', 'codex', 'grok'] as const) {
      expect(providerAvailability(health(), p)).toEqual({ available: true, hint: null })
    }
  })

  it('a missing binary disables the provider', () => {
    expect(providerAvailability(health({ claudeAvailable: false }), 'claude').available).toBe(false)
    expect(providerAvailability(health({ codexAvailable: false }), 'codex').available).toBe(false)
    expect(providerAvailability(health({ openCodeAvailable: false }), 'opencode').available).toBe(false)
    expect(providerAvailability(health({ grokAvailable: false }), 'grok').available).toBe(false)
  })

  it('a failed auth probe warns but does not block', () => {
    const claude = providerAvailability(health({ claudeAuthenticated: false }), 'claude')
    expect(claude.available).toBe(true)
    expect(claude.hint).toContain('signed in')

    const codex = providerAvailability(health({ codexAuthenticated: false }), 'codex')
    expect(codex.available).toBe(true)
    expect(codex.hint).toContain('codex login')

    const grok = providerAvailability(health({ grokAuthenticated: false }), 'grok')
    expect(grok.available).toBe(true)
    expect(grok.hint).toContain('grok login')
  })

  it('Grok is unavailable when the server predates the Grok health fields', () => {
    const legacy = health()
    delete legacy.grokAvailable
    delete legacy.grokAuthenticated
    expect(providerAvailability(legacy, 'grok').available).toBe(false)
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

describe('resolveDefaultProvider (audit N6)', () => {
  const noClaude = { claudeAvailable: false, claudeAuthenticated: false }

  it('returns the preference unchanged while health is unknown (never blocks)', () => {
    expect(resolveDefaultProvider(null, null)).toBe('claude')
    expect(resolveDefaultProvider(null, 'codex')).toBe('codex')
  })

  it('keeps the implicit Claude default when it is installed and signed in', () => {
    expect(resolveDefaultProvider(health(), null)).toBe('claude')
  })

  it('falls back to the first healthy agent when Claude is not installed', () => {
    expect(resolveDefaultProvider(health(noClaude), null)).toBe('opencode')
    expect(resolveDefaultProvider(health({ ...noClaude, openCodeAvailable: false }), null)).toBe('codex')
  })

  it('prefers a healthy agent over an implicit Claude default whose auth probe failed', () => {
    expect(resolveDefaultProvider(health({ claudeAuthenticated: false, openCodeAvailable: false }), null)).toBe('codex')
  })

  it('keeps implicit Claude with a caveat when nothing healthier exists', () => {
    const h = health({ claudeAuthenticated: false, openCodeAvailable: false, codexAuthenticated: false, grokAvailable: false })
    expect(resolveDefaultProvider(h, null)).toBe('claude')
  })

  it('respects an explicit, installed choice even if its auth probe warns', () => {
    expect(resolveDefaultProvider(health({ codexAuthenticated: false }), 'codex')).toBe('codex')
    expect(resolveDefaultProvider(health(), 'opencode')).toBe('opencode')
  })

  it('overrides an explicit choice whose binary is gone', () => {
    expect(resolveDefaultProvider(health({ codexAvailable: false }), 'codex')).toBe('claude')
  })

  it('treats an unrecognized stored value as no choice', () => {
    expect(resolveDefaultProvider(health(noClaude), 'bogus')).toBe('opencode')
  })

  it('falls back to an installed-but-warned agent, then to the preference, when none are healthy', () => {
    const onlyCodexUnauthed = health({ ...noClaude, openCodeAvailable: false, codexAuthenticated: false, grokAvailable: false })
    expect(resolveDefaultProvider(onlyCodexUnauthed, null)).toBe('codex')
    const none = health({ ...noClaude, openCodeAvailable: false, codexAvailable: false, grokAvailable: false })
    expect(resolveDefaultProvider(none, null)).toBe('claude')
  })
})
