/**
 * Which slice of a session's output history a client is sent.
 *
 * A session keeps up to MAX_HISTORY entries, and an `output` entry holds up
 * to 50 KB of merged text, so a busy session's newest 500 entries came to
 * 6–14 MB. That was sent whole on every `join_session`, so on a relayed
 * connection each session switch moved megabytes through two hops. The join
 * now carries a window capped by size, and the client asks for older pages
 * (`load_history`) as the reader scrolls up.
 *
 * Positions are absolute: entry `i` of `outputHistory` is number
 * `historyBase + i`, where `historyBase` counts the entries trimmed from the
 * front. A page request names the first entry the client already has, so a
 * trim between the join and the request does not shift what comes back.
 */

import type { WsServerMessage } from './types.js'

/** Max messages retained in a session's output history buffer. */
export const MAX_HISTORY = 2000

/** Serialized UTF-8 size a join or a page may carry, roughly. */
export const HISTORY_WINDOW_BYTES = 512 * 1024

/** Entry count a join or a page may carry, whatever their size. */
export const HISTORY_WINDOW_MAX_ENTRIES = 500

export interface HistoryWindow {
  entries: WsServerMessage[]
  /** Absolute position of `entries[0]`; for an empty window, of where it would start. */
  start: number
  /** Older entries exist before `start`. */
  hasMore: boolean
}

/** A turn starts here: a user message, or the first entry after a turn's result. */
function isTurnStart(history: WsServerMessage[], i: number): boolean {
  return history[i].type === 'user_echo' || (i > 0 && history[i - 1].type === 'result')
}

/**
 * The newest entries before array index `endIdx` that fit the budget.
 *
 * When older entries remain, the window starts at a turn boundary if one is
 * in its older half: rebuilding a window that starts mid-turn shows a stray
 * half answer, and the page loaded above it would show the other half as a
 * separate message.
 */
export function windowBefore(
  history: WsServerMessage[],
  endIdx: number,
  base: number,
  budgetBytes = HISTORY_WINDOW_BYTES,
  maxEntries = HISTORY_WINDOW_MAX_ENTRIES,
): HistoryWindow {
  const end = Math.max(0, Math.min(endIdx, history.length))
  let start = end
  let bytes = 0
  while (start > 0 && end - start < maxEntries) {
    // UTF-8 bytes, as sent; string length undercounts non-ASCII text up to threefold.
    const size = Buffer.byteLength(JSON.stringify(history[start - 1]), 'utf8')
    // Always take one entry, so an oversized one cannot stall paging.
    if (start < end && bytes + size > budgetBytes) break
    bytes += size
    start--
  }
  if (start > 0) {
    const half = start + Math.floor((end - start) / 2)
    for (let i = start; i < half; i++) {
      if (isTurnStart(history, i)) { start = i; break }
    }
  }
  return { entries: history.slice(start, end), start: base + start, hasMore: start > 0 }
}

/**
 * What `session_joined` carries: the newest window. The task list is
 * restored from the last `todo_update`, so when that falls before the window
 * it is put in front of it.
 */
export function joinWindow(history: WsServerMessage[], base: number): HistoryWindow {
  const win = windowBefore(history, history.length, base)
  if (!win.hasMore || win.entries.some(m => m.type === 'todo_update')) return win
  for (let i = win.start - base - 1; i >= 0; i--) {
    if (history[i].type === 'todo_update') {
      return { ...win, entries: [history[i], ...win.entries] }
    }
  }
  return win
}

/** The page of older entries ending just before absolute position `before`. */
export function pageBefore(history: WsServerMessage[], base: number, before: number): HistoryWindow {
  return windowBefore(history, before - base, base)
}
