/**
 * Session-scoped prompt queue.
 *
 * Manages a Map<sessionId, Map<requestId, PromptEntry>> of pending prompts.
 * Each session has its own queue so prompts don't "travel" between sessions
 * when switching in the sidebar. The `waitingSessions` derived state replaces
 * the manually-tracked state that was previously in useChatSocket.
 */

import { useState, useCallback, useMemo } from 'react'
import type { PromptOption, PromptQuestion, WsServerMessage } from '../types'

export interface PromptEntry {
  requestId: string
  options: PromptOption[]
  question: string | null
  multiSelect: boolean
  promptType: 'permission' | 'question' | null
  questions?: PromptQuestion[]
  approvePattern?: string
}

export interface UsePromptStateReturn {
  /** The prompt the user should see for the given session (oldest in that session's queue). */
  getActive: (sessionId: string | null) => PromptEntry | null
  /** Total number of pending prompts for the given session. */
  getQueueSize: (sessionId: string | null) => number
  /** Derived: sessionIds with non-empty queues → { [sid]: true }. */
  waitingSessions: Record<string, boolean>
  /** Add a prompt to a session's queue. */
  enqueue: (msg: WsServerMessage & { type: 'prompt' }, sessionId: string) => void
  /** Remove a specific prompt by requestId (scans all sessions — UUIDs are globally unique). */
  dismiss: (requestId?: string) => void
  /** Remove all prompts for a single session. */
  clearForSession: (sessionId: string) => void
  /** Remove all prompts across all sessions. */
  clearAll: () => void
}

export function usePromptState(): UsePromptStateReturn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- new Map() infers Map<any,any>
  const [queues, setQueues] = useState<Map<string, Map<string, PromptEntry>>>(new Map())

  const enqueue = useCallback((msg: WsServerMessage & { type: 'prompt' }, sessionId: string) => {
    const requestId = msg.requestId
      ?? crypto?.randomUUID?.()
      ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const entry: PromptEntry = {
      requestId,
      options: msg.options,
      question: msg.question || null,
      multiSelect: msg.multiSelect ?? false,
      promptType: msg.promptType ?? null,
      questions: msg.questions,
      approvePattern: msg.approvePattern,
    }
    setQueues(prev => {
      const next = new Map(prev)
      const sessionQueue = new Map(prev.get(sessionId) ?? new Map())
      sessionQueue.set(requestId, entry)
      next.set(sessionId, sessionQueue)
      return next
    })
  }, [])

  const dismiss = useCallback((requestId?: string) => {
    setQueues(prev => {
      if (requestId) {
        // Find across all sessions
        for (const [sid, sessionQueue] of prev) {
          if (sessionQueue.has(requestId)) {
            const next = new Map(prev)
            const newSessionQueue = new Map(sessionQueue)
            newSessionQueue.delete(requestId)
            if (newSessionQueue.size === 0) {
              next.delete(sid)
            } else {
              next.set(sid, newSessionQueue)
            }
            return next
          }
        }
        return prev // not found
      }
      // No requestId — no-op (callers should always provide one now)
      return prev
    })
  }, [])

  const clearForSession = useCallback((sessionId: string) => {
    setQueues(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setQueues(prev => prev.size === 0 ? prev : new Map())
  }, [])

  const getActive = useCallback((sessionId: string | null): PromptEntry | null => {
    if (!sessionId) return null
    const sessionQueue = queues.get(sessionId)
    if (!sessionQueue || sessionQueue.size === 0) return null
    return sessionQueue.values().next().value ?? null
  }, [queues])

  const getQueueSize = useCallback((sessionId: string | null): number => {
    if (!sessionId) return 0
    return queues.get(sessionId)?.size ?? 0
  }, [queues])

  const waitingSessions = useMemo(() => {
    const result: Record<string, boolean> = {}
    for (const [sid, sessionQueue] of queues) {
      if (sessionQueue.size > 0) {
        result[sid] = true
      }
    }
    return result
  }, [queues])

  return { getActive, getQueueSize, waitingSessions, enqueue, dismiss, clearForSession, clearAll }
}
