/**
 * Manages per-session tentative message queues, persisted to localStorage.
 *
 * When a new session conflicts with an active session for the same repo,
 * messages are queued here instead of being sent immediately. The queue
 * survives page reloads and is cleared on Execute or Discard.
 *
 * Each entry stores the message text and any attached files. Because File
 * objects cannot be serialised to localStorage, only the text portion is
 * persisted — files are kept in React state only and lost on page reload
 * (an acceptable trade-off; the text is the critical piece).
 */

import { useState, useCallback } from 'react'

export interface QueueEntry {
  text: string
  files: File[]
}

const LS_PREFIX = 'codekin-tentative-'

/** Persist only the text parts (File objects are not serialisable). */
function saveTexts(sessionId: string, entries: QueueEntry[]) {
  const key = `${LS_PREFIX}${sessionId}`
  if (entries.length === 0) {
    localStorage.removeItem(key)
  } else {
    localStorage.setItem(key, JSON.stringify(entries.map(e => e.text)))
  }
}

/** Load persisted texts (files are lost across reloads). */
function loadEntries(sessionId: string): QueueEntry[] {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${sessionId}`)
    if (raw) {
      const texts = JSON.parse(raw) as string[]
      return texts.map(text => ({ text, files: [] }))
    }
  } catch { /* ignore parse errors */ }
  return []
}

function loadAllQueues(): Record<string, QueueEntry[]> {
  const result: Record<string, QueueEntry[]> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LS_PREFIX)) {
        const sessionId = key.slice(LS_PREFIX.length)
        const entries = loadEntries(sessionId)
        if (entries.length > 0) result[sessionId] = entries
      }
    }
  } catch { /* ignore localStorage errors */ }
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
      const next = { ...prev }
      delete next[sessionId]
      saveTexts(sessionId, [])
      return next
    })
  }, [])

  return { queues, addToQueue, clearQueue }
}
