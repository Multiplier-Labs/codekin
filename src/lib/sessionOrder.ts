/** Sidebar ordering: sessions by when they last did something. */

import type { Session } from '../types'

/** When a session last did something: its last turn, else its creation. */
export function sessionActivityMs(s: Session): number {
  const t = new Date(s.lastTurnAt ?? s.created).getTime()
  return isNaN(t) ? 0 : t
}

/**
 * Most recent first, with sessions mid-turn above all of them — a long turn
 * started an hour ago is still the most current thing in the repo. Viewing a
 * session does not move it; only starting or finishing a turn does.
 */
export function byLatestActivity(a: Session, b: Session): number {
  const running = Number(!!b.isProcessing) - Number(!!a.isProcessing)
  return running || sessionActivityMs(b) - sessionActivityMs(a)
}
