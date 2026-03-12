/**
 * Prompt queue for a chat session.
 *
 * Manages a Map<requestId, PromptEntry> of pending prompts, exposing the
 * oldest entry as the "active" prompt. Replaces the previous single-slot
 * PromptState that would lose prompts when two arrived before the user
 * answered the first.
 */

import { useState, useCallback } from 'react'
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

interface UsePromptStateReturn {
  /** The prompt the user should see (oldest in queue, i.e. first-in-first-served). */
  active: PromptEntry | null
  /** Total number of pending prompts (for badge/indicator). */
  queueSize: number
  /** Add a prompt to the queue. */
  enqueue: (msg: WsServerMessage & { type: 'prompt' }) => void
  /** Remove a specific prompt by requestId. If undefined, removes the oldest entry. */
  dismiss: (requestId?: string) => void
  /** Remove all prompts (used on session leave/switch). */
  clearAll: () => void
}

export function usePromptState(): UsePromptStateReturn {
  const [queue, setQueue] = useState<Map<string, PromptEntry>>(new Map())

  const enqueue = useCallback((msg: WsServerMessage & { type: 'prompt' }) => {
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
    setQueue(prev => {
      const next = new Map(prev)
      next.set(requestId, entry)
      return next
    })
  }, [])

  const dismiss = useCallback((requestId?: string) => {
    setQueue(prev => {
      if (requestId) {
        if (!prev.has(requestId)) return prev
        const next = new Map(prev)
        next.delete(requestId)
        return next
      }
      // No requestId — delete the oldest entry (first key)
      if (prev.size === 0) return prev
      const next = new Map(prev)
      const firstKey = next.keys().next().value
      if (firstKey !== undefined) next.delete(firstKey)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setQueue(prev => prev.size === 0 ? prev : new Map())
  }, [])

  // Active prompt is the oldest entry (first in insertion order)
  const active = queue.size > 0 ? queue.values().next().value ?? null : null

  return { active, queueSize: queue.size, enqueue, dismiss, clearAll }
}
