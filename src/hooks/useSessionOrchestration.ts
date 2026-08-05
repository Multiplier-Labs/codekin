/**
 * Custom hook encapsulating session management logic:
 * switching, creating, deleting sessions, and repo-level operations.
 *
 * Extracted from App.tsx to reduce root component complexity.
 */

import { useCallback } from 'react'
import type { Repo, Session, PermissionMode } from '../types'

/** Use groupDir (if set) for tab grouping, falling back to workingDir. */
export function groupKey(s: Session): string {
  return s.groupDir ?? s.workingDir
}

export interface UseSessionOrchestrationParams {
  sessions: Session[]
  repos: Repo[]
  activeSessionId: string | null
  setActiveSessionId: (id: string | null) => void
  joinSession: (sessionId: string) => void
  leaveSession: () => void
  clearMessages: () => void
  wsCreateSession: (name: string, workingDir: string, useWorktree?: boolean, permissionMode?: PermissionMode, provider?: import('../types').CodingProvider) => void
  removeSession: (sessionId: string) => Promise<void>
  pendingContextRef: React.RefObject<string | null>
  /** Ref to the current worktree preference (read at session creation time). */
  useWorktreeRef: React.RefObject<boolean>
  /** Ref to the current permission mode preference (read at session creation time). */
  permissionModeRef: React.RefObject<PermissionMode>
  providerRef?: React.RefObject<import('../types').CodingProvider>
}

export interface UseSessionOrchestrationReturn {
  activeSession: Session | null
  activeWorkingDir: string | null
  handleOpenSession: (repo: Repo) => void
  handleSelectSession: (sessionId: string) => void
  handleDeleteSession: (sessionId: string) => Promise<void>
  handleSelectRepo: (workingDir: string) => void
  handleDeleteRepo: (workingDir: string) => Promise<void>
  handleNewSessionForRepo: (provider?: import('../types').CodingProvider) => void
  /** Start a session in any repo, not just the active one (sidebar hover action). */
  handleNewSessionInRepo: (workingDir: string, provider?: import('../types').CodingProvider) => void
  handleNewSessionFromArchive: (workingDir: string, context: string) => void
}

export function useSessionOrchestration({
  sessions,
  repos,
  activeSessionId,
  setActiveSessionId,
  joinSession,
  leaveSession,
  clearMessages,
  wsCreateSession,
  removeSession,
  pendingContextRef,
  useWorktreeRef,
  permissionModeRef,
  providerRef,
}: UseSessionOrchestrationParams): UseSessionOrchestrationReturn {
  // Derive active session and grouping key
  const activeSession = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null
  const activeWorkingDir = activeSession ? groupKey(activeSession) : null

  /**
   * Open a repo. Without a provider this joins the repo's most recent session
   * if there is one; with a provider the caller has explicitly asked for a new
   * session in it, so joining an existing one would discard that choice.
   */
  const handleOpenSession = useCallback((repo: Repo, provider?: import('../types').CodingProvider) => {
    const existing = sessions.filter(s => groupKey(s) === repo.workingDir)
    if (!provider && existing.length > 0) {
      const latest = existing[existing.length - 1]
      clearMessages()
      leaveSession()
      joinSession(latest.id)
      return
    }
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repo.id}`, repo.workingDir, useWorktreeRef.current, permissionModeRef.current, provider ?? providerRef?.current)
  }, [sessions, joinSession, wsCreateSession, leaveSession, clearMessages, useWorktreeRef, permissionModeRef, providerRef])

  const handleSelectSession = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return
    clearMessages()
    leaveSession()
    joinSession(sessionId)
  }, [activeSessionId, leaveSession, joinSession, clearMessages])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (sessionId === activeSessionId) {
      clearMessages()
      leaveSession()
      const deleted = sessions.find(s => s.id === sessionId)
      const remaining = sessions.filter(s => s.id !== sessionId)
      if (remaining.length > 0) {
        const sameRepo = deleted ? remaining.filter(s => groupKey(s) === groupKey(deleted)) : []
        const next = sameRepo.length > 0 ? sameRepo[0] : remaining[0]
        joinSession(next.id)
      } else {
        setActiveSessionId(null)
      }
    }
    await removeSession(sessionId)
  }, [activeSessionId, sessions, clearMessages, leaveSession, joinSession, setActiveSessionId, removeSession])

  const handleSelectRepo = useCallback((workingDir: string) => {
    if (workingDir === activeWorkingDir) return
    const repoSessions = sessions.filter(s => groupKey(s) === workingDir)
    if (repoSessions.length > 0) {
      const latest = repoSessions[repoSessions.length - 1]
      clearMessages()
      leaveSession()
      joinSession(latest.id)
    }
  }, [activeWorkingDir, sessions, clearMessages, leaveSession, joinSession])

  const handleDeleteRepo = useCallback(async (workingDir: string) => {
    const repoSessions = sessions.filter(s => groupKey(s) === workingDir)
    const isActiveRepo = repoSessions.some(s => s.id === activeSessionId)
    if (isActiveRepo) {
      clearMessages()
      leaveSession()
      const remaining = sessions.filter(s => groupKey(s) !== workingDir)
      if (remaining.length > 0) {
        joinSession(remaining[0].id)
      } else {
        setActiveSessionId(null)
      }
    }
    for (const s of repoSessions) {
      await removeSession(s.id)
    }
  }, [sessions, activeSessionId, clearMessages, leaveSession, joinSession, setActiveSessionId, removeSession])

  const handleNewSessionInRepo = useCallback((dir: string, provider?: import('../types').CodingProvider) => {
    const repo = repos.find(r => r.workingDir === dir)
    // Always use the repo root for new sessions — never a worktree path.
    // The repo's workingDir is the canonical root; the caller's dir may be a
    // worktree path if groupDir was missing on the session it came from.
    const workingDir = repo?.workingDir ?? dir
    const repoId = repo?.id ?? workingDir.split('/').pop() ?? 'session'
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repoId}`, workingDir, useWorktreeRef.current, permissionModeRef.current, provider ?? providerRef?.current)
  }, [repos, clearMessages, leaveSession, wsCreateSession, permissionModeRef, useWorktreeRef, providerRef])

  const handleNewSessionForRepo = useCallback((provider?: import('../types').CodingProvider) => {
    if (!activeWorkingDir) return
    handleNewSessionInRepo(activeWorkingDir, provider)
  }, [activeWorkingDir, handleNewSessionInRepo])

  const handleNewSessionFromArchive = useCallback((workingDir: string, context: string) => {
    // The archived workingDir may be a worktree path or an alternate clone path
    // that no longer matches any registered repo. Fall back to basename matching,
    // then to the active repo, so resume never silently no-ops.
    const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
    const repo =
      repos.find(r => r.workingDir === workingDir) ??
      repos.find(r => basename(r.workingDir) === basename(workingDir)) ??
      repos.find(r => r.workingDir === activeWorkingDir)
    if (!repo) return
    pendingContextRef.current = context
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repo.id}`, repo.workingDir, useWorktreeRef.current, permissionModeRef.current, providerRef?.current)
  }, [repos, activeWorkingDir, clearMessages, leaveSession, wsCreateSession, pendingContextRef, permissionModeRef, useWorktreeRef, providerRef])

  return {
    activeSession,
    activeWorkingDir,
    handleOpenSession,
    handleSelectSession,
    handleDeleteSession,
    handleSelectRepo,
    handleDeleteRepo,
    handleNewSessionForRepo,
    handleNewSessionInRepo,
    handleNewSessionFromArchive,
  }
}
