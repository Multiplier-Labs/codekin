/**
 * React hook for workflow engine data.
 *
 * Provides runs, schedules, and config state with action helpers (trigger,
 * cancel, refresh, addRepo, removeRepo). Updates are push-driven: the server
 * broadcasts `workflow_event` on every run/step transition and the hook
 * refreshes on each one (debounced — step events arrive in bursts). A slow
 * poll remains as the safety net for missed events (page hidden during a
 * socket drop, server restarted mid-run).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
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

/** Safety-net poll interval — push events are the primary update signal. */
const POLL_FALLBACK_MS = 60_000
/** Collapse a burst of step events into one refresh. */
const EVENT_DEBOUNCE_MS = 300

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

  // Push-driven updates: refresh on every workflow_event (debounced against
  // step-event bursts), with a slow poll as the safety net for missed events.
  useEffect(() => {
    void refresh()
    pollRef.current = setInterval(refresh, POLL_FALLBACK_MS)
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents((event) => {
      // The channel carries both engines; loop events belong to LoopRunsView.
      if (event.engine === 'loop') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void refresh() }, EVENT_DEBOUNCE_MS)
    })
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [refresh])

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
