/**
 * React hook for the deployment registry + monitor.
 *
 * Probe samples update server-side every 5 minutes with no push channel, so
 * this polls slowly (60s) and refreshes eagerly after any mutation.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  listDeployments,
  saveDeployment,
  patchDeployment,
  deleteDeployment,
  discoverDeployments,
  type Deployment,
  type DiscoveredProcess,
} from '../lib/deploymentsApi'

const POLL_MS = 60_000

interface UseDeploymentsResult {
  deployments: Deployment[]
  discovered: DiscoveredProcess[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  save: (deployment: Omit<Deployment, 'latestSamples'>) => Promise<void>
  update: (id: string, patch: Partial<Omit<Deployment, 'latestSamples'>>) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useDeployments(token: string): UseDeploymentsResult {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredProcess[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const [list, found] = await Promise.all([
        listDeployments(token),
        // Discovery shells out to pm2 — non-fatal when unavailable.
        discoverDeployments(token).catch(() => [] as DiscoveredProcess[]),
      ])
      setDeployments(list)
      setDiscovered(found)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployments')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const save = useCallback(async (deployment: Omit<Deployment, 'latestSamples'>) => {
    await saveDeployment(token, deployment)
    await refresh()
  }, [token, refresh])

  const update = useCallback(async (id: string, patch: Partial<Omit<Deployment, 'latestSamples'>>) => {
    await patchDeployment(token, id, patch)
    await refresh()
  }, [token, refresh])

  const remove = useCallback(async (id: string) => {
    await deleteDeployment(token, id)
    await refresh()
  }, [token, refresh])

  return { deployments, discovered, loading, error, refresh, save, update, remove }
}
