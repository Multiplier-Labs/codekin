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
  wsCreateSession: (name: string, workingDir: string, useWorktree?: boolean, permissionMode?: PermissionMode) => void
  removeSession: (sessionId: string) => Promise<void>
  pendingContextRef: React.RefObject<string | null>
  /** Ref to the current worktree preference (read at session creation time). */
  useWorktreeRef: React.RefObject<boolean>
  /** Ref to the current permission mode preference (read at session creation time). */
  permissionModeRef: React.RefObject<PermissionMode>
}

export interface UseSessionOrchestrationReturn {
  activeSession: Session | null
  activeWorkingDir: string | null
  handleOpenSession: (repo: Repo) => void
  handleSelectSession: (sessionId: string) => void
  handleDeleteSession: (sessionId: string) => Promise<void>
  handleSelectRepo: (workingDir: string) => void
  handleDeleteRepo: (workingDir: string) => Promise<void>
  handleNewSessionForRepo: () => void
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
}: UseSessionOrchestrationParams): UseSessionOrchestrationReturn {
  // Derive active session and grouping key
  const activeSession = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null
  const activeWorkingDir = activeSession ? groupKey(activeSession) : null

  const handleOpenSession = useCallback((repo: Repo) => {
    const existing = sessions.filter(s => groupKey(s) === repo.workingDir)
    if (existing.length > 0) {
      const latest = existing[existing.length - 1]
      clearMessages()
      leaveSession()
      joinSession(latest.id)
      return
    }
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repo.id}`, repo.workingDir, useWorktreeRef.current, permissionModeRef.current)
  }, [sessions, joinSession, wsCreateSession, leaveSession, clearMessages, useWorktreeRef, permissionModeRef])

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

  const handleNewSessionForRepo = useCallback(() => {
    if (!activeWorkingDir) return
    const repo = repos.find(r => r.workingDir === activeWorkingDir)
    // Always use the repo root for new sessions — never a worktree path.
    // The repo's workingDir is the canonical root; activeWorkingDir may be a
    // worktree path if groupDir was missing on the active session.
    const workingDir = repo?.workingDir ?? activeWorkingDir
    const repoId = repo?.id ?? workingDir.split('/').pop() ?? 'session'
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repoId}`, workingDir, useWorktreeRef.current, permissionModeRef.current)
  }, [activeWorkingDir, repos, clearMessages, leaveSession, wsCreateSession, permissionModeRef, useWorktreeRef])

  const handleNewSessionFromArchive = useCallback((workingDir: string, context: string) => {
    const repo = repos.find(r => r.workingDir === workingDir)
    if (!repo) return
    pendingContextRef.current = context
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repo.id}`, repo.workingDir, useWorktreeRef.current, permissionModeRef.current)
  }, [repos, clearMessages, leaveSession, wsCreateSession, pendingContextRef, permissionModeRef, useWorktreeRef])

  return {
    activeSession,
    activeWorkingDir,
    handleOpenSession,
    handleSelectSession,
    handleDeleteSession,
    handleSelectRepo,
    handleDeleteRepo,
    handleNewSessionForRepo,
    handleNewSessionFromArchive,
  }
}
