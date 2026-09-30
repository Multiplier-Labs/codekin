/**
 * Joe's task list, kept fresh push-first: task and child-run events on the
 * shared workflow_event channel trigger a debounced reload, with a slow poll
 * as the safety net. Counts feed the Tasks tab badge even while Chat is open.
 */

import { useCallback, useEffect, useState } from 'react'
import { listTasks, type TaskList } from '../lib/tasksApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'

export function useJoeTasks(token: string, repo: string, enabled: boolean) {
  const [data, setData] = useState<TaskList | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token || !enabled) return
    try {
      setData(await listTasks(token, { repo: repo || undefined }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    }
  }, [token, repo, enabled])

  useEffect(() => {
    if (!token || !enabled) return
    let cancelled = false
    listTasks(token, { repo: repo || undefined })
      .then(result => { if (!cancelled) { setData(result); setError(null) } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load tasks') })
    return () => { cancelled = true }
  }, [token, repo, enabled])

  useEffect(() => {
    if (!enabled) return
    const poll = setInterval(() => { void refresh() }, 60_000)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents((event) => {
      // Task changes, plus child-run changes that move linked tasks.
      if (event.engine !== 'agent') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refresh() }, 300)
    })
    return () => {
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh, enabled])

  return { data, error, refresh }
}
