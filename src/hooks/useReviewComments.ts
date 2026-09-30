/**
 * Review comments for the session shown in the Changes panel.
 *
 * Comments live on the server (so drafts survive reconnects and appear on
 * every device); every change is broadcast back as `review_comments`, which
 * replaces the local list. Errors from this client's own actions arrive as
 * `review_error`.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { DiffView, ReviewComment, WsClientMessage, WsServerMessage } from '../types'

export interface NewCommentInput {
  path: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  view: DiffView
  baseCommit?: string
  headCommit?: string
  body: string
}

interface UseReviewCommentsOptions {
  send: (msg: WsClientMessage) => void
  isOpen: boolean
  sessionId: string | null
}

export function useReviewComments({ send, isOpen, sessionId }: UseReviewCommentsOptions) {
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const sessionIdRef = useRef(sessionId)
  const isOpenRef = useRef(isOpen)

  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])

  const load = useCallback(() => {
    if (isOpenRef.current && sessionIdRef.current) send({ type: 'review_comments_get' })
  }, [send])

  useEffect(() => {
    sessionIdRef.current = sessionId
    setComments([]) // eslint-disable-line react-hooks/set-state-in-effect -- reset on session switch
    setError(null)
    setSending(false)
    load()
  }, [sessionId, load])

  // Starts at the initial value: the session effect covers the first open.
  const prevOpenRef = useRef(isOpen)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) load()
    prevOpenRef.current = isOpen
  }, [isOpen, load])

  const handleMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'review_comments') {
      if (msg.sessionId !== sessionIdRef.current) return
      setComments(msg.comments)
      setSending(false)
    } else if (msg.type === 'review_error') {
      if (msg.sessionId && msg.sessionId !== sessionIdRef.current) return
      setError(msg.message)
      setSending(false)
    }
  }, [])

  const add = useCallback((input: NewCommentInput) => {
    setError(null)
    send({ type: 'review_comment_add', ...input })
  }, [send])

  const update = useCallback((id: string, body: string) => {
    setError(null)
    send({ type: 'review_comment_update', id, body })
  }, [send])

  const remove = useCallback((id: string) => {
    setError(null)
    send({ type: 'review_comment_delete', id })
  }, [send])

  /** Send the given drafts to the agent as one prompt; stale ones go with their original code. */
  const sendToAgent = useCallback((ids: string[], includeStale: boolean) => {
    if (ids.length === 0) return
    setError(null)
    setSending(true)
    send({ type: 'review_feedback_send', ids, includeStale })
  }, [send])

  return { comments, error, sending, add, update, remove, sendToAgent, handleMessage, clearError: () => { setError(null) } }
}
