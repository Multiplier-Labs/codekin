/**
 * Reasoning-effort helpers for the composer's agent picker.
 *
 * A session's effort is either an explicit level id ('high') or null — "let
 * the harness decide". Models whose harness advertises a default (Codex's
 * model/list) are always given an explicit level, so their choices are just
 * the levels and null reads as that default. Models without a known default
 * (Claude) get a leading "Default" choice that omits the flag entirely.
 */

import { effortLabel, type ModelOption } from '../types'
import { getPref } from './prefs'

/** Effort choices for a model, in cycle order. null = harness default. */
export function effortChoices(model: ModelOption | undefined): (string | null)[] {
  if (!model?.efforts?.length) return []
  const levels = model.efforts.map(e => e.id)
  return model.defaultEffort ? levels : [null, ...levels]
}

/**
 * The level a session is effectively on: the explicit one, else the model's
 * advertised default, else null (unknown — the harness decides).
 */
export function effectiveEffort(effort: string | null | undefined, model: ModelOption | undefined): string | null {
  if (effort && model?.efforts?.some(e => e.id === effort)) return effort
  return model?.defaultEffort ?? null
}

/** Display label for an effort choice ('Extra high', or 'Default'). */
export function effortDisplay(effort: string | null | undefined, model: ModelOption | undefined): string {
  const level = effectiveEffort(effort, model)
  return level ? effortLabel(level) : 'Default'
}

/** The choice after `current` in the model's cycle, wrapping around. */
export function nextEffort(current: string | null | undefined, model: ModelOption | undefined): string | null {
  const choices = effortChoices(model)
  if (choices.length === 0) return null
  const at = choices.indexOf(effectiveEffort(current, model))
  return choices[(at + 1) % choices.length]
}

/**
 * The effort a model would start on if picked now: the level last chosen for
 * it, when still offered, otherwise null (its default).
 */
export function rememberedEffort(model: ModelOption): string | null {
  const saved = getPref('modelEfforts')?.[model.id]
  return saved && model.efforts?.some(e => e.id === saved) ? saved : null
}

/** True on Apple platforms, where the shortcut modifier is ⌘ rather than Ctrl. */
export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Keyboard hint for the cycle-effort shortcut (Mod+Shift+E). */
export const CYCLE_EFFORT_KEYS = IS_APPLE ? '⌘⇧E' : 'Ctrl+Shift+E'

/** Whether a keydown is the cycle-effort shortcut. */
export function isCycleEffortKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.shiftKey && !e.altKey && (IS_APPLE ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'e'
}
