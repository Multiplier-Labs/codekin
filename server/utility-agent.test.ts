/** Tests for the utility agent — provider ordering, fallback chain, and per-harness one-shot command mapping. */
import { describe, it, expect, beforeEach } from 'vitest'
import { runUtilityPrompt, utilityOrder, seedUtilityProbe, resetUtilityProbeCache } from './utility-agent.js'
import { getHarness } from './harness-registry.js'

function seedAll(overrides: Partial<Record<'claude' | 'opencode' | 'codex', boolean>> = {}) {
  for (const id of ['claude', 'opencode', 'codex'] as const) {
    const usable = overrides[id] ?? true
    seedUtilityProbe(id, { available: usable, version: usable ? 'v' : '', authenticated: usable })
  }
}

beforeEach(() => {
  resetUtilityProbeCache()
})

describe('utilityOrder', () => {
  it('prefers the requested provider, then registry order', () => {
    seedAll()
    expect(utilityOrder('codex').map((h) => h.id)).toEqual(['codex', 'claude', 'opencode'])
    expect(utilityOrder().map((h) => h.id)).toEqual(['claude', 'opencode', 'codex'])
  })

  it('drops harnesses that are missing or unauthenticated', () => {
    seedAll({ claude: false })
    expect(utilityOrder('claude').map((h) => h.id)).toEqual(['opencode', 'codex'])
  })
})

describe('runUtilityPrompt', () => {
  it('uses the preferred harness when it succeeds', async () => {
    seedAll()
    const result = await runUtilityPrompt(
      { prompt: 'name this', prefer: 'opencode', timeoutMs: 1000 },
      async (cmd) => `${cmd.binary} said hi`,
    )
    expect(result.provider).toBe('opencode')
  })

  it('falls back down the chain and reports every failure when all fail', async () => {
    seedAll()
    const tried: string[] = []
    await expect(
      runUtilityPrompt({ prompt: 'p', timeoutMs: 1000 }, async (cmd) => {
        tried.push(cmd.binary)
        throw new Error('nope')
      }),
    ).rejects.toThrow(/claude.*opencode.*codex/s)
    expect(tried).toHaveLength(3)
  })

  it('a mid-chain success stops the fallback', async () => {
    seedAll({ claude: false })
    const result = await runUtilityPrompt({ prompt: 'p', timeoutMs: 1000 }, async (cmd) =>
      cmd.args[0] === 'run' ? 'from opencode' : Promise.reject(new Error('x')),
    )
    expect(result).toEqual({ text: 'from opencode', provider: 'opencode' })
  })

  it('throws immediately when no harness is usable', async () => {
    seedAll({ claude: false, opencode: false, codex: false })
    await expect(runUtilityPrompt({ prompt: 'p', timeoutMs: 1000 })).rejects.toThrow(/No usable coding agent/)
  })
})

describe('oneShotCommand mapping', () => {
  const opts = { prompt: 'the prompt', systemPrompt: 'be terse', fast: true }

  it('claude: -p one-shot with system prompt, fast model, prompt on stdin', () => {
    const cmd = getHarness('claude').oneShotCommand(opts)
    expect(cmd.args).toEqual(['-p', '--max-turns', '1', '--tools', '', '--system-prompt', 'be terse', '--model', 'haiku'])
    expect(cmd.stdin).toBe('the prompt')
  })

  it('codex: exec with the system prompt leading the piped text', () => {
    const cmd = getHarness('codex').oneShotCommand(opts)
    expect(cmd.args).toEqual(['exec'])
    expect(cmd.stdin).toBe('be terse\n\nthe prompt')
  })

  it('opencode: run --pure with the combined message as the argument', () => {
    const cmd = getHarness('opencode').oneShotCommand(opts)
    expect(cmd.args).toEqual(['run', '--pure', 'be terse\n\nthe prompt'])
    expect(cmd.stdin).toBe('')
  })
})
