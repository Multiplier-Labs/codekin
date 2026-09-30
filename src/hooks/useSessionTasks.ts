/**
 * Live state of the tasks linked to a repo session, so task cards in the
 * conversation reflect the same record as the Tasks view: a decision answered
 * there shows as answered here. Refreshes on task events and when Joe posts.
 */

import { useCallback, useEffect, useState } from 'react'
import { listSessionTasks } from '../lib/joeApi'
import type { JoeTask } from '../lib/tasksApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'

export function useSessionTasks(token: string, sessionId: string | null, joeMessageCount: number) {
  const [tasks, setTasks] = useState<Record<string, JoeTask>>({})

  const refresh = useCallback(async () => {
    if (!token || !sessionId) return
    try {
      const list = await listSessionTasks(token, sessionId)
      setTasks(Object.fromEntries(list.tasks.map(t => [t.id, t])))
    } catch {
      // Cards fall back to the snapshot carried by the message.
    }
  }, [token, sessionId])

  useEffect(() => {
    if (joeMessageCount === 0) return
    void refresh() // eslint-disable-line react-hooks/set-state-in-effect -- fetch on new Joe activity
  }, [refresh, joeMessageCount])

  useEffect(() => {
    if (!sessionId || joeMessageCount === 0) return
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents((event) => {
      if (event.engine !== 'agent') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refresh() }, 300)
    })
    return () => {
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh, sessionId, joeMessageCount])

  return { tasks, refresh }
}
