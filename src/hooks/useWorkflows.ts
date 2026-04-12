/**
 * React hook for workflow engine data.
 *
 * Provides runs, schedules, and config state with auto-polling
 * and action helpers (trigger, cancel, refresh, addRepo, removeRepo).
 * Polls at 5s when any run is active, 15s otherwise.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listRuns,
  listSchedules,
  getConfig,
  triggerRun as apiTriggerRun,
  cancelRun as apiCancelRun,
  triggerSchedule as apiTriggerSchedule,
  addRepoConfig,
  removeRepoConfig,
  patchRepoConfig,
  type WorkflowRun,
  type CronSchedule,
  type WorkflowConfig,
  type ReviewRepoConfig,
  type WebhookSetupResult,
} from '../lib/workflowApi'

const POLL_FAST_MS = 5_000
const POLL_SLOW_MS = 15_000

interface UseWorkflowsResult {
  runs: WorkflowRun[]
  schedules: CronSchedule[]
  config: WorkflowConfig | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  triggerRun: (kind: string, input?: Record<string, unknown>) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  triggerSchedule: (id: string) => Promise<void>
  addRepo: (repo: ReviewRepoConfig, webhookUrl?: string) => Promise<WebhookSetupResult | undefined>
  removeRepo: (id: string) => Promise<void>
  updateRepo: (id: string, patch: Partial<ReviewRepoConfig>) => Promise<void>
  toggleScheduleEnabled: (id: string, enabled: boolean) => Promise<void>
}

export function useWorkflows(token: string): UseWorkflowsResult {
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [schedules, setSchedules] = useState<CronSchedule[]>([])
  const [config, setConfig] = useState<WorkflowConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const [runsData, schedulesData, configData] = await Promise.all([
        listRuns(token, { limit: 50 }),
        listSchedules(token),
        getConfig(token),
      ])
      setRuns(runsData)
      setSchedules(schedulesData)
      setConfig(configData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflow data')
    } finally {
      setLoading(false)
    }
  }, [token])

  // Adaptive polling: fast when runs are active, slow otherwise
  const hasActiveRuns = runs.some(r => r.status === 'running' || r.status === 'queued')
  const intervalMs = hasActiveRuns ? POLL_FAST_MS : POLL_SLOW_MS

  useEffect(() => {
    void refresh()
    pollRef.current = setInterval(refresh, intervalMs)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh, intervalMs])

  const triggerRun = useCallback(async (kind: string, input?: Record<string, unknown>) => {
    try {
      await apiTriggerRun(token, kind, input)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger run')
    }
  }, [token, refresh])

  const cancelRun = useCallback(async (runId: string) => {
    try {
      await apiCancelRun(token, runId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel run')
    }
  }, [token, refresh])

  const triggerSchedule = useCallback(async (id: string) => {
    try {
      await apiTriggerSchedule(token, id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger schedule')
    }
  }, [token, refresh])

  const addRepo = useCallback(async (repo: ReviewRepoConfig, webhookUrl?: string): Promise<WebhookSetupResult | undefined> => {
    const result = await addRepoConfig(token, repo, webhookUrl)
    await refresh()
    return result.webhookSetup
  }, [token, refresh])

  const removeRepo = useCallback(async (id: string) => {
    await removeRepoConfig(token, id)
    await refresh()
  }, [token, refresh])

  const updateRepo = useCallback(async (id: string, patch: Partial<ReviewRepoConfig>) => {
    await patchRepoConfig(token, id, patch)
    await refresh()
  }, [token, refresh])

  const toggleScheduleEnabled = useCallback(async (id: string, enabled: boolean) => {
    await patchRepoConfig(token, id, { enabled })
    await refresh()
  }, [token, refresh])

  return { runs, schedules, config, loading, error, refresh, triggerRun, cancelRun, triggerSchedule, addRepo, removeRepo, updateRepo, toggleScheduleEnabled }
}
