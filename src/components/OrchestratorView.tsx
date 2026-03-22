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
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-neutral-11 px-3 py-2 min-w-[120px]">
      <div className="text-neutral-5">{icon}</div>
      <div>
        <div className="text-[18px] font-semibold text-neutral-2 leading-tight">{value}</div>
        <div className="text-[12px] text-neutral-5 leading-tight">{label}</div>
      </div>
    </div>
  )
}

export function OrchestratorView({ token, onOrchestratorSessionReady, sessionJoined, agentName: agentNameProp }: Props) {
  const [status, setStatus] = useState<'loading' | 'active' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [agentNameLocal, setAgentNameLocal] = useState('Joe')
  const agentName = agentNameProp ?? agentNameLocal

  // Fetch dashboard stats
  const refreshStats = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch(`/cc/api/orchestrator/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setStats(data.stats)
      }
    } catch {
      // Stats are optional — don't fail the view
    }
  }, [token])

  // Initialize session
  useEffect(() => {
    if (!token) return

    let cancelled = false

    async function init() {
      try {
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
        <div className="flex items-center gap-3 text-neutral-4">
          <IconRobotFace size={20} stroke={2} />
          <span className="text-[15px]">Starting Agent {agentName}...</span>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 text-error-5 mb-2">
            <IconRobotFace size={20} stroke={2} />
            <span className="text-[15px] font-medium">Failed to start Agent {agentName}</span>
          </div>
          <p className="text-[14px] text-neutral-5">{error}</p>
        </div>
      </div>
    )
  }

  // Dashboard header — shown above the chat
  if (!sessionJoined) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-neutral-10 bg-neutral-12">
      <div className="flex items-center gap-2 text-neutral-2">
        <IconRobotFace size={18} stroke={2} className="text-accent-5" />
        <span className="text-[15px] font-medium">Agent {agentName}</span>
      </div>
      {stats && (
        <div className="flex items-center gap-2 ml-auto">
          <StatCard label="repos" value={stats.managedRepos} icon={<IconFolder size={15} />} />
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
