/**
 * Orchestrator view — initialization + dashboard header.
 *
 * On mount, fetches the orchestrator session ID from the server and notifies
 * the parent to join it. Displays a dashboard header with summary stats.
 * The actual chat rendering is handled by ChatView and InputBar in App.tsx.
 */

import { useEffect, useState, useCallback } from 'react'
import { IconRobotFace, IconFolder, IconBell, IconTerminal2 } from '@tabler/icons-react'
import * as api from '../lib/ccApi'
import { AGENT_PROVIDER_IDS, PROVIDERS, type CodingProvider } from '../types'
import { useAgentHealth } from '../hooks/useAgentHealth'
import { providerAvailability } from '../lib/agentHealth'

interface DashboardStats {
  managedRepos: number
  pendingNotifications: number
  activeChildSessions: number
  totalChildSessions: number
  trustRecords: number
  autoApprovedActions: number
  memoryItems: number
}

interface Props {
  token: string
  onOrchestratorSessionReady: (sessionId: string) => void
  /** Whether the session has been joined and chat is rendering. */
  sessionJoined: boolean
  /** Agent display name (from parent settings). */
  agentName?: string
  /** Chat / Tasks tab (header tabs render only when onTabChange is given). */
  tab?: OrchestratorTab
  onTabChange?: (tab: OrchestratorTab) => void
  /** Tasks waiting on the user (decisions + reviews), shown as a badge. */
  taskAttention?: number
}

export type OrchestratorTab = 'chat' | 'tasks'

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-control bg-surface px-3 py-2 min-w-[120px]">
      <div className="text-ink-muted">{icon}</div>
      <div>
        <div className="text-head font-semibold text-ink">{value}</div>
        <div className="text-meta text-ink-muted leading-tight">{label}</div>
      </div>
    </div>
  )
}

export function OrchestratorView({ token, onOrchestratorSessionReady, sessionJoined, agentName: agentNameProp, tab = 'chat', onTabChange, taskAttention = 0 }: Props) {
  const [status, setStatus] = useState<'loading' | 'choose' | 'active' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [agentNameLocal, setAgentNameLocal] = useState('Joe')
  const agentName = agentNameProp ?? agentNameLocal
  const health = useAgentHealth()

  // Fetch dashboard stats
  const refreshStats = useCallback(async () => {
    if (!token) return
    // Stats are optional — getOrchestratorDashboard returns null instead of failing the view
    const stats = await api.getOrchestratorDashboard<DashboardStats>(token)
    if (stats) setStats(stats)
  }, [token])

  // Initialize session
  useEffect(() => {
    if (!token) return

    let cancelled = false

    async function init() {
      try {
        const saved = await api.getOrchestratorStatus(token)
        if (cancelled) return
        if (saved.agentName) setAgentNameLocal(saved.agentName)
        if (!saved.provider) {
          setStatus('choose')
          return
        }
        const result = await api.startOrchestrator(token)
        if (cancelled) return
        if (result.agentName) setAgentNameLocal(result.agentName)
        setStatus('active')
        onOrchestratorSessionReady(result.sessionId)
        void refreshStats()
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to start orchestrator')
        setStatus('error')
      }
    }

    void init()
    return () => { cancelled = true }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh stats periodically
  useEffect(() => {
    if (status !== 'active' || !token) return
    const interval = setInterval(() => void refreshStats(), 30000)
    return () => clearInterval(interval)
  }, [status, token, refreshStats])

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-3 text-ink-muted">
          <IconRobotFace size={20} stroke={2} />
          <span className="text-body">Starting Agent {agentName}...</span>
        </div>
      </div>
    )
  }

  async function chooseProvider(provider: CodingProvider) {
    setError(null)
    setStatus('loading')
    try {
      const result = await api.startOrchestrator(token, provider)
      if (result.agentName) setAgentNameLocal(result.agentName)
      setStatus('active')
      onOrchestratorSessionReady(result.sessionId)
      void refreshStats()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start orchestrator')
      setStatus('error')
    }
  }

  if (status === 'choose' || status === 'error') {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-lg">
          <h2 className="text-title font-semibold text-ink">Choose an agent for {agentName}</h2>
          <p className="mt-2 text-body text-ink-muted">
            Joe and delegated sessions will use this agent. You can change it in the chat composer or ask Joe to use another agent for a task.
          </p>
          {error && <p role="alert" className="mt-2 text-body text-error-5">{error}</p>}
          <div className="mt-4 flex flex-col gap-2">
            {PROVIDERS.filter((p) => AGENT_PROVIDER_IDS.includes(p.id)).map((provider) => {
              const availability = providerAvailability(health, provider.id)
              return (
                <button
                  key={provider.id}
                  type="button"
                  disabled={!availability.available}
                  onClick={() => { void chooseProvider(provider.id) }}
                  className="rounded-control border border-edge px-4 py-3 text-left text-body text-ink hover:border-edge-strong disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="font-semibold">{provider.label}</span>
                  <span className="block text-meta text-ink-muted">{availability.hint ?? provider.description}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // Dashboard header — shown above the chat
  if (!sessionJoined) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-edge bg-page">
      <div className="flex items-center gap-2 text-ink">
        <IconRobotFace size={18} stroke={2} className="text-accent-5" />
        <span className="text-body font-medium">Agent {agentName}</span>
      </div>
      {onTabChange && (
        <div role="tablist" aria-label={`Agent ${agentName} views`} className="flex items-center gap-1">
          {(['chat', 'tasks'] as const).map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => { onTabChange(id) }}
              className={`inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-meta ${tab === id ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              {id === 'chat' ? 'Chat' : 'Tasks'}
              {id === 'tasks' && taskAttention > 0 && (
                <span aria-label={`${taskAttention} waiting on you`} className="rounded-full bg-warning-7 px-1.5 text-micro font-semibold text-warning-1">{taskAttention}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {stats && (
        <div className="flex items-center gap-2 ml-auto">
          {stats.managedRepos > 0 && (
            <StatCard label="repos" value={stats.managedRepos} icon={<IconFolder size={15} />} />
          )}
          {stats.pendingNotifications > 0 && (
            <StatCard label="pending" value={stats.pendingNotifications} icon={<IconBell size={15} />} />
          )}
          {stats.activeChildSessions > 0 && (
            <StatCard label="sessions" value={stats.activeChildSessions} icon={<IconTerminal2 size={15} />} />
          )}
        </div>
      )}
    </div>
  )
}
