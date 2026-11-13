/**
 * State of the new-session composer (the draft) while it is being sent.
 *
 * A send runs in two stages: setup over HTTP (scratch folder, clone, uploads),
 * then `create_session` over the WebSocket. The text being sent is captured
 * when the attempt begins, so every way the attempt can fail — a setup error,
 * a server error, a dropped connection — hands back exactly what was sent.
 * The composer clears its own textarea on send, so the live draft text can't
 * be relied on for that.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { setPref, usePref } from '../lib/prefs'
import { draftModeFor } from '../lib/startDraftSession'
import type { DraftPlace } from '../lib/places'
import type { CodingProvider, PermissionMode } from '../types'

/** What to do once the server confirms the session: send the first message, remember the place. */
export interface PendingCreate {
  firstMessage: string
  place: DraftPlace
}

export function useDraftState() {
  const [text, setText] = useState('')
  const [resetKey, setResetKey] = useState(0)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The text of the attempt in flight; null when nothing is being sent. */
  const submittedRef = useRef<string | null>(null)
  /** Set once `create_session` has gone out for the attempt in flight. */
  const pendingCreateRef = useRef<PendingCreate | null>(null)

  /** Start an attempt. False if one is already running. */
  const begin = useCallback((submitted: string): boolean => {
    if (submittedRef.current !== null) return false
    submittedRef.current = submitted
    setError(null)
    setText(submitted)
    return true
  }, [])

  /** `create_session` went out: from here the server's reply settles the attempt. */
  const awaitCreated = useCallback((pending: PendingCreate) => {
    pendingCreateRef.current = pending
  }, [])

  const isAwaitingCreate = useCallback(() => pendingCreateRef.current !== null, [])

  /** The session exists: end the attempt, clear the draft, return what to do next. */
  const takeCreated = useCallback((): PendingCreate | null => {
    const pending = pendingCreateRef.current
    if (!pending) return null
    pendingCreateRef.current = null
    submittedRef.current = null
    setText('')
    setProgress(null)
    setError(null)
    return pending
  }, [])

  /** The attempt failed: show why and put the sent text back in the composer. */
  const fail = useCallback((message: string) => {
    const submitted = submittedRef.current
    if (submitted === null) return
    submittedRef.current = null
    pendingCreateRef.current = null
    setProgress(null)
    setError(message)
    setText(submitted)
    setResetKey(k => k + 1)
  }, [])

  return useMemo(() => ({
    text, setText, resetKey, progress, setProgress, error, setError,
    begin, awaitCreated, isAwaitingCreate, takeCreated, fail,
  }), [text, resetKey, progress, error, begin, awaitCreated, isAwaitingCreate, takeCreated, fail])
}

/**
 * The permission mode a draft starts in: the saved new-session default,
 * adjusted for the chosen agent (Skip permissions is Claude-only).
 *
 * Deliberately independent of the session last joined — visiting a Bypass
 * session must not make the next new session Bypass. Choosing a mode in the
 * composer saves it as the default, as Settings does.
 */
export function useDraftPermissionMode(provider: CodingProvider): [PermissionMode, (mode: PermissionMode) => void] {
  const saved = usePref('permissionMode') ?? 'acceptEdits'
  const mode = draftModeFor(provider, saved)
  const choose = useCallback((next: PermissionMode) => { setPref('permissionMode', next) }, [])
  return [mode, choose]
}
