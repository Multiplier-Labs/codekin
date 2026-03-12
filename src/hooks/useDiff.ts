/**
 * Hook for managing diff viewer state.
 *
 * Sends get_diff/discard_changes messages over WebSocket, receives diff_result,
 * and auto-refreshes after file-mutating tool_done events.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { DiffFile, DiffSummary, DiffScope, DiffFileStatus, WsClientMessage, WsServerMessage } from '../types'

/** Read-only commands whose tool_done should NOT trigger a diff refresh. */
const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'echo', 'grep', 'git log', 'git status', 'pwd', 'which', 'node -e',
  'head', 'tail', 'wc', 'file', 'stat', 'find', 'type', 'env', 'printenv',
]

interface UseDiffOptions {
  send: (msg: WsClientMessage) => void
  isOpen: boolean
}

export function useDiff({ send, isOpen }: UseDiffOptions) {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [summary, setSummary] = useState<DiffSummary>({
    filesChanged: 0, insertions: 0, deletions: 0, truncated: false,
  })
  const [branch, setBranch] = useState('')
  const [scope, setScope] = useState<DiffScope>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scopeRef = useRef(scope)
  const isOpenRef = useRef(isOpen)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { scopeRef.current = scope }, [scope])
  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])

  const refresh = useCallback(() => {
    if (!isOpenRef.current) return
    setLoading(true)
    setError(null)
    send({ type: 'get_diff', scope: scopeRef.current })
  }, [send])

  const changeScope = useCallback((newScope: DiffScope) => {
    setScope(newScope)
    scopeRef.current = newScope
    if (isOpenRef.current) {
      setLoading(true)
      setError(null)
      send({ type: 'get_diff', scope: newScope })
    }
  }, [send])

  const discard = useCallback((paths?: string[], statuses?: Record<string, DiffFileStatus>) => {
    setLoading(true)
    send({ type: 'discard_changes', scope: scopeRef.current, paths, statuses })
  }, [send])

  /** Handle incoming diff_result / diff_error messages. */
  const handleMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'diff_result') {
      setFiles(msg.files)
      setSummary(msg.summary)
      setBranch(msg.branch)
      setScope(msg.scope)
      scopeRef.current = msg.scope
      setLoading(false)
      setError(null)
    } else if (msg.type === 'diff_error') {
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

    // Always refresh for Edit and Write
    if (toolName === 'Edit' || toolName === 'Write') {
      scheduleRefresh()
      return
    }

    // For Bash, skip if summary looks like a read-only command
    if (toolName === 'Bash' && toolSummary) {
      const trimmed = toolSummary.trim().toLowerCase()
      const isReadOnly = READ_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix))
      if (isReadOnly) return
    }

    // For Bash without a recognizable read-only prefix, refresh
    if (toolName === 'Bash') {
      scheduleRefresh()
    }
  }, [scheduleRefresh])

  // Auto-fetch when panel opens
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      send({ type: 'get_diff', scope: scopeRef.current })
    }
    prevOpenRef.current = isOpen
  }, [isOpen, send])

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
    loading,
    error,
    refresh,
    changeScope,
    discard,
    handleMessage,
    handleToolDone,
  }
}
