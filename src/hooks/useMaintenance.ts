/**
 * Maintenance summaries for every repo with a plan, keyed by repo path —
 * feeds the repo nav indicator and the Tasks overview. Refreshes on task and
 * run events, with a slow poll as the safety net.
 */

import { useCallback, useEffect, useState } from 'react'
import { listMaintenance, type RepoMaintenance } from '../lib/maintenanceApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'

export function useMaintenance(token: string) {
  const [byRepo, setByRepo] = useState<Record<string, RepoMaintenance>>({})

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const repos = await listMaintenance(token)
      setByRepo(Object.fromEntries(repos.map(r => [r.repo, r])))
    } catch {
      // Keep the last known state; the maintenance view shows errors.
    }
  }, [token])

  useEffect(() => {
    void refresh() // eslint-disable-line react-hooks/set-state-in-effect -- initial load
    const poll = setInterval(() => { void refresh() }, 60_000)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refresh() }, 1000)
    })
    return () => {
      clearInterval(poll)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh])

  return { byRepo, refresh }
}
