/**
 * Which permission modes the user has switched on, and how Shift+Tab steps
 * through them in the composer.
 *
 * The set is one stored preference (`enabledPermissionModes`). It filters the
 * composer's mode menu and the Shift+Tab cycle alike; unset means every mode.
 */

import { PERMISSION_MODES, type PermissionMode } from '../types'

type ModeEntry = (typeof PERMISSION_MODES)[number]

const ALL_IDS = PERMISSION_MODES.map(m => m.id)

/** Normalise a stored value: known ids only, in canonical order; unset or empty means all. */
export function resolveEnabledModes(stored: readonly string[] | undefined): PermissionMode[] {
  if (!stored) return ALL_IDS
  const set = new Set(stored)
  const enabled = ALL_IDS.filter(id => set.has(id))
  return enabled.length > 0 ? enabled : ALL_IDS
}

/**
 * Modes to offer in the composer: the provider's modes that are enabled.
 * The current mode always stays listed so the menu never hides where you are.
 */
export function offeredModes(providerModes: readonly ModeEntry[], enabled: readonly PermissionMode[], current: PermissionMode | undefined): ModeEntry[] {
  return providerModes.filter(m => enabled.includes(m.id) || m.id === current)
}

/**
 * The modes Shift+Tab would land on next, in order, starting after `current`
 * and wrapping around. The caller takes the first it can activate — a
 * dangerous mode needs confirmation, and declining moves on to the next.
 */
export function cycleCandidates(modes: readonly ModeEntry[], enabled: readonly PermissionMode[], current: PermissionMode): ModeEntry[] {
  const ring = modes.filter(m => enabled.includes(m.id))
  if (ring.length === 0) return []
  const at = ring.findIndex(m => m.id === current)
  // Not in the ring (e.g. current mode was switched off): start from the top.
  const ordered = at === -1 ? ring : [...ring.slice(at + 1), ...ring.slice(0, at)]
  return ordered.filter(m => m.id !== current)
}

/** Visual tone of the composer for a mode: plan reads darker, the no-prompt modes read as a warning. */
export function composerTone(mode: PermissionMode | undefined): 'plan' | 'danger' | undefined {
  if (mode === 'plan') return 'plan'
  return PERMISSION_MODES.find(m => m.id === mode)?.dangerous ? 'danger' : undefined
}
