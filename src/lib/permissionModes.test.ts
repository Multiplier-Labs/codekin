/** Tests for the per-provider permission mode list shown in the composer. */
import { describe, it, expect } from 'vitest'
import { PERMISSION_MODES, permissionModesFor } from '../types'
import { composerTone, cycleCandidates, offeredModes, resolveEnabledModes } from './permissionModes'

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

describe('enabled modes and Shift+Tab cycling', () => {
  const ids = (modes: { id: string }[]) => modes.map(m => m.id)

  it('treats unset, empty and unknown-only values as every mode, in canonical order', () => {
    const all = PERMISSION_MODES.map(m => m.id)
    expect(resolveEnabledModes(undefined)).toEqual(all)
    expect(resolveEnabledModes([])).toEqual(all)
    expect(resolveEnabledModes(['nope'])).toEqual(all)
    expect(resolveEnabledModes(['plan', 'default'])).toEqual(['default', 'plan'])
  })

  it('offers only enabled modes, but never hides the current one', () => {
    expect(ids(offeredModes(PERMISSION_MODES, ['default', 'plan'], 'default'))).toEqual(['default', 'plan'])
    expect(ids(offeredModes(PERMISSION_MODES, ['default', 'plan'], 'acceptEdits'))).toEqual(['default', 'acceptEdits', 'plan'])
  })

  it('cycles through enabled modes after the current one and wraps', () => {
    const enabled = ['default', 'acceptEdits', 'plan'] as const
    expect(ids(cycleCandidates(PERMISSION_MODES, [...enabled], 'default'))).toEqual(['acceptEdits', 'plan'])
    expect(ids(cycleCandidates(PERMISSION_MODES, [...enabled], 'plan'))).toEqual(['default', 'acceptEdits'])
    // Current mode not in the ring: start from the first enabled one.
    expect(ids(cycleCandidates(PERMISSION_MODES, ['default', 'plan'], 'bypassPermissions'))).toEqual(['default', 'plan'])
  })

  it('respects the provider list (no skip flag outside Claude)', () => {
    const all = resolveEnabledModes(undefined)
    expect(ids(cycleCandidates(permissionModesFor('codex'), all, 'bypassPermissions'))).toEqual(['default', 'acceptEdits', 'plan'])
  })

  it('tones the composer for plan and the no-prompt modes', () => {
    expect(composerTone('plan')).toBe('plan')
    expect(composerTone('bypassPermissions')).toBe('danger')
    expect(composerTone('dangerouslySkipPermissions')).toBe('danger')
    expect(composerTone('default')).toBeUndefined()
    expect(composerTone(undefined)).toBeUndefined()
  })
})
