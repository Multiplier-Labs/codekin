/**
 * Manages per-session tentative message queues, persisted in the prefs store.
 *
 * When a new session conflicts with an active session for the same repo,
 * messages are queued here instead of being sent immediately. The queue
 * survives page reloads and is cleared on Execute or Discard.
 *
 * Each entry stores the message text and any attached files. Because File
 * objects cannot be serialised, only the text portion is persisted — files
 * are kept in React state only and lost on page reload (an acceptable
 * trade-off; the text is the critical piece).
 */

import { useState, useCallback } from 'react'
import { getPref, setPref } from '../lib/prefs'

export interface QueueEntry {
  text: string
  files: File[]
}

/**
 * Persist only the text parts (File objects are not serialisable).
 * @param sessionId  Session UUID whose queue changed.
 * @param entries    Current queue entries. If empty, the session's entry is removed.
 */
function saveTexts(sessionId: string, entries: QueueEntry[]) {
  const next = Object.fromEntries(
    Object.entries(getPref('tentativeQueues') ?? {}).filter(([id]) => id !== sessionId),
  )
  if (entries.length > 0) next[sessionId] = entries.map(e => e.text)
  setPref('tentativeQueues', Object.keys(next).length > 0 ? next : undefined)
}

/**
 * Load all persisted tentative queues.
 * @returns Map of sessionId → QueueEntry[] for all sessions with non-empty queues.
 */
function loadAllQueues(): Record<string, QueueEntry[]> {
  const result: Record<string, QueueEntry[]> = {}
  for (const [sessionId, texts] of Object.entries(getPref('tentativeQueues') ?? {})) {
    if (Array.isArray(texts) && texts.length > 0) result[sessionId] = texts.map(text => ({ text, files: [] }))
  }
  return result
}

export function useTentativeQueue() {
  const [queues, setQueues] = useState<Record<string, QueueEntry[]>>(loadAllQueues)

  const addToQueue = useCallback((sessionId: string, text: string, files: File[] = []) => {
    setQueues(prev => {
      const next = { ...prev, [sessionId]: [...(prev[sessionId] ?? []), { text, files }] }
      saveTexts(sessionId, next[sessionId])
      return next
    })
  }, [])

  const clearQueue = useCallback((sessionId: string) => {
    setQueues(prev => {
      if (!prev[sessionId]) return prev
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => key !== sessionId)
      )
      saveTexts(sessionId, [])
      return next
    })
  }, [])

  return { queues, addToQueue, clearQueue }
}
