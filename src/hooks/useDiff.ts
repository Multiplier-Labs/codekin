/**
 * Hook for managing diff viewer state.
 *
 * Sends get_diff/set_review_base/discard_changes over WebSocket, receives
 * diff_result/diff_error, and refreshes after file-mutating tool_done events
 * and at the end of each agent turn.
 *
 * Every request carries an increasing requestId, and responses carry the
 * session they answer; a response for another session or an older request is
 * dropped, so switching session or view never shows stale results.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { DiffFile, DiffSummary, DiffScope, DiffView, DiffReview, DiffFileStatus, WsClientMessage, WsServerMessage } from '../types'

/** Read-only commands whose tool_done should NOT trigger a diff refresh. */
const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'echo', 'grep', 'git log', 'git status', 'pwd', 'which', 'node -e',
  'head', 'tail', 'wc', 'file', 'stat', 'find', 'type', 'env', 'printenv',
]

const EMPTY_SUMMARY: DiffSummary = { filesChanged: 0, insertions: 0, deletions: 0, truncated: false }

/** Views whose changes can be discarded; branch views are read-only history. */
export function isDiscardableView(view: DiffView): view is DiffScope {
  return view === 'all' || view === 'staged' || view === 'unstaged'
}

interface UseDiffOptions {
  send: (msg: WsClientMessage) => void
  isOpen: boolean
  /** Session the panel shows; results for any other session are ignored. */
  sessionId: string | null
  /** View to start each session on ('branch' for isolated sessions). */
  defaultView: DiffView
}

export function useDiff({ send, isOpen, sessionId, defaultView }: UseDiffOptions) {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [summary, setSummary] = useState(EMPTY_SUMMARY)
  const [branch, setBranch] = useState('')
  const [scope, setScope] = useState<DiffView>(defaultView)
  const [review, setReview] = useState<DiffReview | null>(null)
  const [incomplete, setIncomplete] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scopeRef = useRef(scope)
  const isOpenRef = useRef(isOpen)
  const sessionIdRef = useRef(sessionId)
  const lastRequestIdRef = useRef(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])

  /** Send a diff request for `view`; only its response will be accepted. */
  const request = useCallback((view: DiffView, reviewBase?: string | null) => {
    const requestId = ++lastRequestIdRef.current
    setLoading(true)
    setError(null)
    if (reviewBase !== undefined) send({ type: 'set_review_base', base: reviewBase, scope: view, requestId })
    else send({ type: 'get_diff', scope: view, requestId })
  }, [send])

  const refresh = useCallback(() => {
    if (!isOpenRef.current) return
    request(scopeRef.current)
  }, [request])

  const changeScope = useCallback((newScope: DiffView) => {
    setScope(newScope)
    scopeRef.current = newScope
    setIncomplete([])
    if (isOpenRef.current) request(newScope)
  }, [request])

  /** Choose the ref branch views compare against; null returns to automatic. */
  const changeReviewBase = useCallback((base: string | null) => {
    request(scopeRef.current, base)
  }, [request])

  const discard = useCallback((paths?: string[], statuses?: Record<string, DiffFileStatus>) => {
    const view = scopeRef.current
    if (!isDiscardableView(view)) return
    // The discard reply is a fresh diff for this view; newer requests still win.
    lastRequestIdRef.current++
    setLoading(true)
    send({ type: 'discard_changes', scope: view, paths, statuses })
  }, [send])

  // Each session starts on its default view with a clean slate.
  useEffect(() => {
    sessionIdRef.current = sessionId
    setFiles([]) // eslint-disable-line react-hooks/set-state-in-effect -- reset on session switch
    setSummary(EMPTY_SUMMARY)
    setBranch('')
    setReview(null)
    setIncomplete([])
    setError(null)
    setScope(defaultView)
    scopeRef.current = defaultView
    if (isOpenRef.current && sessionId) request(defaultView)
  }, [sessionId, defaultView, request])

  /** Handle incoming diff_result / diff_error messages. */
  const handleMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type !== 'diff_result' && msg.type !== 'diff_error') return
    if (msg.sessionId && msg.sessionId !== sessionIdRef.current) return
    if (msg.requestId !== undefined && msg.requestId !== lastRequestIdRef.current) return
    if (msg.type === 'diff_result') {
      setFiles(msg.files)
      setSummary(msg.summary)
      setBranch(msg.branch)
      setReview(msg.review ?? null)
      setIncomplete(msg.incomplete ?? [])
      setLoading(false)
      setError(null)
    } else {
      // Don't leave the previous result on screen as if it were current.
      setFiles([])
      setSummary(EMPTY_SUMMARY)
      setIncomplete([])
      setError(msg.message)
      setLoading(false)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refresh()
    }, 500)
  }, [refresh])

  /**
   * Called on every tool_done event. Debounces refresh by 500ms.
   * Only refreshes for file-mutating tools.
   */
  const handleToolDone = useCallback((toolName: string, toolSummary?: string) => {
    if (!isOpenRef.current) return

    // Case-insensitive: Claude reports 'Edit'/'Write'/'Bash', OpenCode
    // lowercase 'edit'/'write'/'patch'/'bash'.
    const tool = toolName.toLowerCase()

    // Always refresh for file-mutating tools
    if (tool === 'edit' || tool === 'write' || tool === 'patch') {
      scheduleRefresh()
      return
    }

    // For Bash, skip if summary looks like a read-only command
    if (tool === 'bash' && toolSummary) {
      const trimmed = toolSummary.trim().toLowerCase()
      const isReadOnly = READ_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix))
      if (isReadOnly) return
    }

    // For Bash without a recognizable read-only prefix, refresh
    if (tool === 'bash') {
      scheduleRefresh()
    }
  }, [scheduleRefresh])

  /** Called when an agent turn finishes: catches changes the tool heuristic missed (e.g. commits). */
  const handleTurnDone = useCallback(() => {
    if (isOpenRef.current) scheduleRefresh()
  }, [scheduleRefresh])

  // Auto-fetch when panel opens
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current && sessionIdRef.current) {
      request(scopeRef.current)
    }
    prevOpenRef.current = isOpen
  }, [isOpen, request])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  return {
    files,
    summary,
    branch,
    scope,
    review,
    incomplete,
    loading,
    error,
    refresh,
    changeScope,
    changeReviewBase,
    discard,
    handleMessage,
    handleToolDone,
    handleTurnDone,
  }
}
