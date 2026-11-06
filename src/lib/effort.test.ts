import { describe, it, expect, vi } from 'vitest'

const prefs = vi.hoisted(() => ({ modelEfforts: {} as Record<string, string> }))
vi.mock('./prefs', () => ({ getPref: (key: 'modelEfforts') => prefs[key] }))

import { effectiveEffort, effortChoices, effortDisplay, isCycleEffortKey, nextEffort, rememberedEffort } from './effort'
import { CLAUDE_EFFORTS, effortLabel, type ModelOption } from '../types'

const claude: ModelOption = { id: 'claude-opus-5', label: 'Opus 5', efforts: CLAUDE_EFFORTS }
const codex: ModelOption = {
  id: 'gpt-6-luna', label: 'GPT-6 Luna',
  efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
  defaultEffort: 'medium',
}
const plain: ModelOption = { id: 'glm', label: 'GLM' }

describe('effortChoices', () => {
  it('leads with Default when the harness default is unknown', () => {
    expect(effortChoices(claude)).toEqual([null, 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('lists only the levels when the model names its default', () => {
    expect(effortChoices(codex)).toEqual(['low', 'medium', 'high'])
  })
  it('is empty for models without effort control', () => {
    expect(effortChoices(plain)).toEqual([])
    expect(effortChoices(undefined)).toEqual([])
  })
})

describe('effectiveEffort / effortDisplay', () => {
  it('reads null as the advertised default', () => {
    expect(effectiveEffort(null, codex)).toBe('medium')
    expect(effortDisplay(null, codex)).toBe('Medium')
  })
  it('shows Default when no default is known', () => {
    expect(effortDisplay(null, claude)).toBe('Default')
  })
  it('ignores a level the model does not offer', () => {
    expect(effectiveEffort('max', codex)).toBe('medium')
  })
  it('labels xhigh as Extra high', () => {
    expect(effortDisplay('xhigh', claude)).toBe('Extra high')
    expect(effortLabel('ultra')).toBe('Ultra')
    expect(effortLabel('turbo')).toBe('Turbo')
  })
})

describe('nextEffort', () => {
  it('cycles through Default and every level, wrapping', () => {
    const seen: (string | null)[] = []
    let e: string | null = null
    for (let i = 0; i < 6; i++) { e = nextEffort(e, claude); seen.push(e) }
    expect(seen).toEqual(['low', 'medium', 'high', 'xhigh', 'max', null])
  })
  it('starts from the effective default for Codex models', () => {
    expect(nextEffort(null, codex)).toBe('high')
    expect(nextEffort('high', codex)).toBe('low')
  })
})

describe('rememberedEffort', () => {
  it('returns the saved level only while the model still offers it', () => {
    prefs.modelEfforts = { 'claude-opus-5': 'max', 'gpt-6-luna': 'max' }
    expect(rememberedEffort(claude)).toBe('max')
    expect(rememberedEffort(codex)).toBeNull()
  })
})

describe('isCycleEffortKey', () => {
  const base = { key: 'E', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false }
  it('matches Mod+Shift+E and nothing looser', () => {
    const hit = isCycleEffortKey({ ...base, metaKey: true }) || isCycleEffortKey({ ...base, ctrlKey: true })
    expect(hit).toBe(true)
    expect(isCycleEffortKey({ ...base })).toBe(false)
    expect(isCycleEffortKey({ ...base, metaKey: true, ctrlKey: true, shiftKey: false })).toBe(false)
    expect(isCycleEffortKey({ ...base, metaKey: true, ctrlKey: true, altKey: true })).toBe(false)
  })
})
