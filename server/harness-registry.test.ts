/** Tests for the harness registry — coverage of every provider, dispatch to the right adapter, and the claude fallback. */
import { describe, it, expect } from 'vitest'
import { HARNESSES, getHarness, type CreateProcessContext } from './harness-registry.js'
import type { Session } from './types.js'

const ctx: CreateProcessContext = {
  sessionId: 'sess-1',
  extraEnv: { CODEKIN_PORT: '32352' },
  mergedAllowedTools: ['Read'],
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    workingDir: '/repo',
    claudeSessionId: null,
    model: undefined,
    permissionMode: 'acceptEdits',
    outputHistory: [],
    ...overrides,
  } as unknown as Session
}

describe('registry coverage', () => {
  it('defines every provider exactly once, with an install hint and label', () => {
    expect(HARNESSES.map((h) => h.id).sort()).toEqual(['claude', 'codex', 'opencode'])
    for (const h of HARNESSES) {
      expect(h.label.length).toBeGreaterThan(0)
      expect(h.installHint.length).toBeGreaterThan(0)
    }
  })
})

describe('getHarness', () => {
  it('resolves each provider to its own definition', () => {
    for (const id of ['claude', 'opencode', 'codex'] as const) {
      expect(getHarness(id).id).toBe(id)
    }
  })

  it('falls back to claude for sessions with no recorded provider', () => {
    expect(getHarness(undefined).id).toBe('claude')
  })
})

describe('createProcess dispatch', () => {
  it('builds a process of the matching provider without starting it', () => {
    for (const h of HARNESSES) {
      const cp = h.createProcess(session(), ctx)
      expect(cp.provider).toBe(h.id)
      expect(cp.isAlive()).toBe(false)
    }
  })
})
