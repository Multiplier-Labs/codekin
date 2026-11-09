/**
 * Tells the user, quietly, when sessions need them.
 *
 * - The page title starts with the count, `(2) Codekin`: visible in a
 *   browser tab, and the desktop app mirrors it on its Dock icon.
 * - When a session newly needs you and you aren't looking at it (the page is
 *   in the background, or another session is open), one silent browser
 *   notification, if the user allowed them. Several at once become one.
 *   Never repeated for the same wait.
 *
 * "Needs you" is a pending prompt (approval or question). A finished turn
 * (the agent stopped and waits for the next message) counts too, unless the
 * user turned that off. Opening the session, or the agent working again,
 * clears it.
 */

import { useEffect, useRef, useState } from 'react'
import type { Session } from '../types'
import { usePref } from '../lib/prefs'

export type AttentionReason = 'input' | 'finished'

export interface AttentionItem {
  id: string
  name: string
  reason: AttentionReason
}

export interface AttentionState {
  /** Sessions that finished a turn and haven't been looked at since. */
  finished: ReadonlySet<string>
  /** Whether each session was working at the last look. */
  processing: ReadonlyMap<string, boolean>
  /** What needed the user at the last look, keyed `id:reason`. */
  shown: ReadonlySet<string>
  /** False until the first look: what is pending at page load isn't news. */
  primed: boolean
}

export const EMPTY_ATTENTION: AttentionState = { finished: new Set(), processing: new Map(), shown: new Set(), primed: false }

export interface AttentionInput {
  sessions: ReadonlyArray<Pick<Session, 'id' | 'name' | 'isProcessing'>>
  waiting: Readonly<Record<string, boolean>>
  activeSessionId: string | null
  /** The page is visible and focused. */
  focused: boolean
  /** Count finished turns too. */
  includeFinished: boolean
}

const key = (item: AttentionItem) => `${item.id}:${item.reason}`

/** What needs the user now, and what is new since the last look. */
export function nextAttention(prev: AttentionState, input: AttentionInput): { state: AttentionState; items: AttentionItem[]; fresh: AttentionItem[] } {
  const finished = new Set(prev.finished)
  const processing = new Map<string, boolean>()
  const looking = (id: string) => input.focused && id === input.activeSessionId
  const items: AttentionItem[] = []
  for (const s of input.sessions) {
    const working = s.isProcessing === true
    processing.set(s.id, working)
    const waiting = input.waiting[s.id] === true
    if (working || waiting) finished.delete(s.id)
    else if (prev.processing.get(s.id) === true) finished.add(s.id)
    if (looking(s.id)) finished.delete(s.id)
    if (waiting && !looking(s.id)) items.push({ id: s.id, name: s.name, reason: 'input' })
    else if (input.includeFinished && finished.has(s.id)) items.push({ id: s.id, name: s.name, reason: 'finished' })
  }
  // Sessions that went away (archived, deleted) stop counting.
  const ids = new Set(input.sessions.map(s => s.id))
  for (const id of finished) if (!ids.has(id)) finished.delete(id)
  const shown = new Set(items.map(key))
  const fresh = prev.primed ? items.filter(i => !prev.shown.has(key(i))) : []
  return { state: { finished, processing, shown, primed: true }, items, fresh }
}

/** The title with the count in front, or without one at zero. */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\)\s+/, '')
  return count > 0 ? `(${count}) ${base}` : base
}

/** What one notification says for the items that are new. */
export function notificationText(fresh: AttentionItem[]): { title: string; body: string } {
  if (fresh.length === 1) {
    const [item] = fresh
    return { title: item.name || 'A session', body: item.reason === 'input' ? 'Needs your input' : 'Finished and waiting for you' }
  }
  const needs = fresh.filter(i => i.reason === 'input').length
  return {
    title: `${fresh.length} sessions are waiting for you`,
    body: needs > 0 ? `${needs} need${needs === 1 ? 's' : ''} your input` : 'They finished and are waiting for you',
  }
}

/** The desktop app (its web view has no Web Notifications; the app itself notifies). */
function inDesktopApp(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('CodekinDesktop/')
}

function pageFocused(): boolean {
  return typeof document !== 'undefined' && !document.hidden && document.hasFocus()
}

export function useAttentionNotifications(args: {
  sessions: Session[]
  waitingSessions: Record<string, boolean>
  activeSessionId: string | null
  onOpenSession: (id: string) => void
}): void {
  const notifyPref = usePref('notifyNeedsInput')
  const finishedPref = usePref('notifyTurnFinished')
  const notify = notifyPref !== false
  const includeFinished = finishedPref !== false
  const state = useRef<AttentionState>(EMPTY_ATTENTION)
  const [focused, setFocused] = useState(pageFocused)
  const open = useRef(args.onOpenSession)
  useEffect(() => { open.current = args.onOpenSession }, [args.onOpenSession])

  useEffect(() => {
    const update = () => { setFocused(pageFocused()) }
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    const { state: next, items, fresh } = nextAttention(state.current, {
      sessions: args.sessions, waiting: args.waitingSessions, activeSessionId: args.activeSessionId, focused, includeFinished,
    })
    state.current = next
    document.title = titleWithCount(document.title, notify ? items.length : 0)
    if (!notify || fresh.length === 0 || inDesktopApp()) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const { title, body } = notificationText(fresh)
    try {
      // One tag: a newer notification replaces the last instead of stacking.
      const n = new Notification(title, { body, tag: 'codekin-attention', silent: true })
      n.onclick = () => {
        window.focus()
        open.current(fresh[0].id)
        n.close()
      }
    } catch {
      // Some browsers only allow notifications from a service worker: the title count still shows.
    }
  }, [args.sessions, args.waitingSessions, args.activeSessionId, focused, notify, includeFinished])
}
