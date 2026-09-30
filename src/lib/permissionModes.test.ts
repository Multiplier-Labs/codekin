/** Tests for the per-provider permission mode list shown in the composer. */
import { describe, it, expect } from 'vitest'
import { PERMISSION_MODES, permissionModesFor } from '../types'

describe('permissionModesFor', () => {
  it('offers every mode for Claude (and before a provider is known)', () => {
    expect(permissionModesFor('claude')).toBe(PERMISSION_MODES)
    expect(permissionModesFor(undefined)).toBe(PERMISSION_MODES)
  })

  it('drops the Claude-only skip flag for the other harnesses, with stable references', () => {
    for (const p of ['opencode', 'codex', 'grok'] as const) {
      const ids = permissionModesFor(p).map(m => m.id)
      expect(ids).not.toContain('dangerouslySkipPermissions')
      expect(ids).toContain('bypassPermissions')
      expect(permissionModesFor(p)).toBe(permissionModesFor(p))
    }
  })

  it('describes what Grok actually enforces in ask and plan mode', () => {
    const grok = permissionModesFor('grok')
    expect(grok.find(m => m.id === 'default')?.description).toMatch(/considers safe/)
    expect(grok.find(m => m.id === 'plan')?.description).not.toMatch(/read-only/i)
    // Other providers keep the shared wording.
    expect(permissionModesFor('codex').find(m => m.id === 'default')?.description).toBe('Always ask before making changes')
  })
})
