/**
 * Manages per-session tentative message queues, persisted to localStorage.
 *
 * When a new session conflicts with an active session for the same repo,
 * messages are queued here instead of being sent immediately. The queue
 * survives page reloads and is cleared on Execute or Discard.
 */

import { useState, useCallback } from 'react'

const LS_PREFIX = 'codekin-tentative-'

function loadQueue(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${sessionId}`)
    if (raw) return JSON.parse(raw) as string[]
  } catch { /* ignore parse errors */ }
  return []
}

function saveQueue(sessionId: string, queue: string[]) {
  if (queue.length === 0) {
    localStorage.removeItem(`${LS_PREFIX}${sessionId}`)
  } else {
    localStorage.setItem(`${LS_PREFIX}${sessionId}`, JSON.stringify(queue))
  }
}

function loadAllQueues(): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LS_PREFIX)) {
        const sessionId = key.slice(LS_PREFIX.length)
        const queue = loadQueue(sessionId)
        if (queue.length > 0) result[sessionId] = queue
      }
    }
  } catch { /* ignore localStorage errors */ }
  return result
}

export function useTentativeQueue() {
  const [queues, setQueues] = useState<Record<string, string[]>>(loadAllQueues)

  const addToQueue = useCallback((sessionId: string, message: string) => {
    setQueues(prev => {
      const next = { ...prev, [sessionId]: [...(prev[sessionId] ?? []), message] }
      saveQueue(sessionId, next[sessionId])
      return next
    })
  }, [])

  const clearQueue = useCallback((sessionId: string) => {
    setQueues(prev => {
      if (!prev[sessionId]) return prev
      const next = { ...prev }
      delete next[sessionId]
      saveQueue(sessionId, [])
      return next
    })
  }, [])

  return { queues, addToQueue, clearQueue }
}
