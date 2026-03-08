/**
 * Root application component — orchestrates the full Codekin UI.
 *
 * Wires together WebSocket chat, session management, repo selection,
 * file uploads, skill expansion, command palette, and settings.
 * Layout: top session tab bar, left icon sidebar, main chat area with
 * input bar and prompt buttons, right sidebar with sessions/tasks/approvals.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { Repo, Session, ChatMessage } from './types'
import { useSettings } from './hooks/useSettings'
import { useRepos } from './hooks/useRepos'
import { useSessions } from './hooks/useSessions'
import { useChatSocket } from './hooks/useChatSocket'
import { usePageVisibility } from './hooks/usePageVisibility'
import { useRouter } from './hooks/useRouter'
import { useTentativeQueue } from './hooks/useTentativeQueue'
import { uploadFile } from './lib/ccApi'
import { deriveActivityLabel } from './lib/deriveActivityLabel'
import { Settings } from './components/Settings'
import { ChatView } from './components/ChatView'
import { TodoPanel } from './components/TodoPanel'
import { LeftSidebar } from './components/LeftSidebar'
import { TentativeBanner } from './components/TentativeBanner'
import { WorkflowsView } from './components/WorkflowsView'
import { CommandPalette } from './components/CommandPalette'
import { InputBar, type InputBarHandle } from './components/InputBar'
import { PromptButtons } from './components/PromptButtons'
import { RepoSelector } from './components/RepoSelector'

/** Use groupDir (if set) for tab grouping, falling back to workingDir. */
function groupKey(s: Session): string {
  return s.groupDir ?? s.workingDir
}

export default function App() {
  const { settings, updateSettings } = useSettings()
  const { groups, repos, globalSkills, globalModules } = useRepos(settings.token)
  const { sessions, rename: renameSession, remove: removeSession, refresh: refreshSessions } = useSessions(settings.token)
  const { queues: tentativeQueues, addToQueue, clearQueue } = useTentativeQueue()
  const { sessionId: urlSessionId, view, navigate } = useRouter()

  const [activeSessionId, setActiveSessionIdRaw] = useState<string | null>(() =>
    urlSessionId ?? localStorage.getItem('codekin-active-session')
  )

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdRaw(id)
    if (id) {
      navigate(`/s/${id}`)
    } else {
      navigate('/', true)
    }
  }, [navigate])

  const [settingsOpen, setSettingsOpen] = useState(!settings.token)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingContextRef = useRef<string | null>(null)
  const sendInputRef = useRef<(data: string) => void>(() => {})
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [sessionPendingFiles, setSessionPendingFiles] = useState<Record<string, File[]>>({})
  const pendingFiles = useMemo(() => activeSessionId ? (sessionPendingFiles[activeSessionId] ?? []) : [], [activeSessionId, sessionPendingFiles])

  const inputBarRef = useRef<InputBarHandle>(null)
  const [sessionInputs, setSessionInputs] = useState<Record<string, string>>({})

  const {
    connState,
    messages,
    tasks,
    planningMode,
    isProcessing,
    thinkingSummary,
    waitingSessions,
    promptOptions,
    promptQuestion,
    promptType,
    promptQuestions,
    approvePattern,
    multiSelect,
    joinSession,
    createSession: wsCreateSession,
    sendInput,
    sendPromptResponse,
    leaveSession,
    clearMessages,
    restoreSession,
    currentModel,
    setModel,
  } = useChatSocket({
    token: settings.token,
    onSessionCreated: (sessionId) => {
      setActiveSessionId(sessionId)
      refreshSessions()
      if (pendingContextRef.current) {
        const ctx = pendingContextRef.current
        pendingContextRef.current = null
        setTimeout(() => sendInputRef.current(ctx), 500)
      }
    },
    onSessionJoined: (sessionId) => {
      setActiveSessionId(sessionId)
    },
    onSessionRenamed: () => {
      refreshSessions()
    },
    onSessionsUpdated: () => {
      refreshSessions()
      setArchiveRefreshKey(k => k + 1)
    },
    onError: (msg) => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      setError(msg)
      errorTimerRef.current = setTimeout(() => setError(null), 5000)
      if (msg.toLowerCase().includes('not found')) {
        setActiveSessionId(null)
      }
    },
  })

  // Keep sendInputRef in sync so onSessionCreated can use it
  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])

  // Cmd+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Persist active session ID
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem('codekin-active-session', activeSessionId)
    } else {
      localStorage.removeItem('codekin-active-session')
    }
  }, [activeSessionId])

  // Auto-rejoin last session on connect/reconnect
  const autoJoinedRef = useRef(false)
  useEffect(() => {
    if (connState === 'disconnected') {
      autoJoinedRef.current = false
    }
  }, [connState])
  useEffect(() => {
    if (autoJoinedRef.current || !activeSessionId || connState !== 'connected') return
    autoJoinedRef.current = true
    joinSession(activeSessionId)
  }, [activeSessionId, connState, joinSession])

  // React to browser back/forward navigation
  useEffect(() => {
    if (urlSessionId === activeSessionId) return
    if (urlSessionId) {
      clearMessages()
      leaveSession()
      joinSession(urlSessionId)
      setActiveSessionIdRaw(urlSessionId) // eslint-disable-line react-hooks/set-state-in-effect -- browser navigation sync
    } else {
      clearMessages()
      leaveSession()
      setActiveSessionIdRaw(null) // eslint-disable-line react-hooks/set-state-in-effect -- browser navigation sync
    }
  }, [urlSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL on initial load when restoring from localStorage
  useEffect(() => {
    if (activeSessionId && window.location.pathname === '/') {
      navigate(`/s/${activeSessionId}`, true)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore session when returning from idle/background tab
  usePageVisibility(() => {
    restoreSession()
  })

  // Auto-open settings on first visit
  useEffect(() => {
    if (!settings.token) setSettingsOpen(true) // eslint-disable-line react-hooks/set-state-in-effect -- initial setup
  }, [settings.token])

  const handleOpenSession = useCallback(async (repo: Repo, sessionName?: string) => {
    // If no custom name, check for existing sessions for this repo
    if (!sessionName) {
      const existing = sessions.filter(s => groupKey(s) === repo.workingDir)
      if (existing.length > 0) {
        // Join the most recent existing session
        const latest = existing[existing.length - 1]
        clearMessages()
        leaveSession()
        joinSession(latest.id)
        return
      }
    }

    // Create via WebSocket
    const name = sessionName || `hub:${repo.id}`
    clearMessages()
    leaveSession()
    wsCreateSession(name, repo.workingDir)
  }, [sessions, joinSession, wsCreateSession, leaveSession, clearMessages])

  const handleSelectSession = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return
    clearMessages()
    leaveSession()
    joinSession(sessionId)
  }, [activeSessionId, leaveSession, joinSession, clearMessages])

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- setActiveSessionId is stable
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (sessionId === activeSessionId) {
      clearMessages()
      leaveSession()
      // Switch to another available session instead of showing empty state
      const deleted = sessions.find(s => s.id === sessionId)
      const remaining = sessions.filter(s => s.id !== sessionId)
      if (remaining.length > 0) {
        // Prefer a session from the same repo, otherwise take the first available
        const sameRepo = deleted ? remaining.filter(s => groupKey(s) === groupKey(deleted)) : []
        const next = sameRepo.length > 0 ? sameRepo[0] : remaining[0]
        joinSession(next.id)
      } else {
        setActiveSessionId(null)
      }
    }
    await removeSession(sessionId)
  }, [activeSessionId, sessions, clearMessages, leaveSession, joinSession, setActiveSessionId, removeSession])

  // Derive active grouping key from the active session
  const activeSession = activeSessionId ? sessions.find(s => s.id === activeSessionId) : null
  const activeWorkingDir = activeSession ? groupKey(activeSession) : null

  const handleSelectRepo = useCallback((workingDir: string) => {
    // If already viewing this repo, do nothing
    if (workingDir === activeWorkingDir) return
    // Find the most recent session for this repo and switch to it
    const repoSessions = sessions.filter(s => groupKey(s) === workingDir)
    if (repoSessions.length > 0) {
      const latest = repoSessions[repoSessions.length - 1]
      clearMessages()
      leaveSession()
      joinSession(latest.id)
    }
  }, [activeWorkingDir, sessions, clearMessages, leaveSession, joinSession])

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- setActiveSessionId is stable
  const handleDeleteRepo = useCallback(async (workingDir: string) => {
    const repoSessions = sessions.filter(s => groupKey(s) === workingDir)
    const isActiveRepo = repoSessions.some(s => s.id === activeSessionId)
    if (isActiveRepo) {
      clearMessages()
      leaveSession()
      // Switch to a session from another repo instead of showing empty state
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
    const repoId = repo?.id ?? activeWorkingDir.split('/').pop() ?? 'session'
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repoId}`, activeWorkingDir)
  }, [activeWorkingDir, repos, clearMessages, leaveSession, wsCreateSession])

  const handleNewSessionFromArchive = useCallback((workingDir: string, context: string) => {
    const repo = repos.find(r => r.workingDir === workingDir)
    if (!repo) return
    pendingContextRef.current = context
    clearMessages()
    leaveSession()
    wsCreateSession(`hub:${repo.id}`, repo.workingDir)
  }, [repos, clearMessages, leaveSession, wsCreateSession])

  const handleSendSkill = useCallback((command: string) => {
    inputBarRef.current?.insertText(command + ' ')
  }, [])

  const handleSendModule = useCallback((mod: { name: string; content: string }) => {
    sendInput(`[Module: ${mod.name}]\n\n${mod.content}`)
  }, [sendInput])

  const addFiles = useCallback((files: File[]) => {
    if (!activeSessionId) return
    setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [...(prev[activeSessionId] ?? []), ...files] }))
  }, [activeSessionId])

  const removeFile = useCallback((index: number) => {
    if (!activeSessionId) return
    setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: (prev[activeSessionId] ?? []).filter((_, i) => i !== index) }))
  }, [activeSessionId])

  // Derive active repo from the active session
  const activeRepo = activeWorkingDir
    ? repos.find(r => r.workingDir === activeWorkingDir) ?? null
    : null

  // All available skills for the current session (global + repo)
  const allSkills = useMemo(() => [
    ...globalSkills,
    ...(activeRepo?.skills ?? []),
  ], [globalSkills, activeRepo?.skills])

  // Expand slash commands to skill content before sending
  const expandSkill = useCallback((text: string): string => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return text

    // Extract command and any trailing args: "/commit fix the bug" → command="/commit", args="fix the bug"
    const spaceIdx = trimmed.indexOf(' ')
    const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    const skill = allSkills.find(s => s.command === command)
    if (!skill?.content) return text

    // Replace $ARGUMENTS placeholder in skill content with actual args
    const content = skill.content.replace(/\$ARGUMENTS/g, args || '(no arguments provided)')
    const parts = [`[Skill: ${skill.name}]`, '', content]
    if (args) parts.push('', `User instructions: ${args}`)
    return parts.join('\n')
  }, [allSkills])

  const handleSendWithFiles = useCallback(async (text: string) => {
    if (!settings.token) return
    const expanded = expandSkill(text)
    const displayText = expanded !== text ? text : undefined

    // Tentative mode: if another session for the same repo is currently processing,
    // or if this session already has queued messages (isAlreadyTentative), hold the
    // new message rather than sending it immediately.  This prevents two Claude
    // processes for the same repo from interleaving edits on the same files.
    // The queued messages are auto-executed by the useEffect below once all blocking
    // sessions for this repo finish processing.
    const isAlreadyTentative = (tentativeQueues[activeSessionId ?? '']?.length ?? 0) > 0
    const hasConflict = !!activeWorkingDir &&
      sessions.some(s => groupKey(s) === activeWorkingDir && s.isProcessing && s.id !== activeSessionId)
    if (activeSessionId && (isAlreadyTentative || hasConflict)) {
      addToQueue(activeSessionId, expanded)
      return
    }

    const files = pendingFiles
    if (files.length === 0) {
      // displayText is the original slash command (e.g. "/commit") when `expanded`
      // is the full skill content — the server echoes displayText to the chat so
      // the user sees the compact command form rather than the raw skill markdown.
      sendInput(expanded, displayText)
      return
    }
    if (activeSessionId) setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [] }))
    setUploadStatus('Uploading files...')
    try {
      const paths = await Promise.all(files.map(f => uploadFile(settings.token, f)))
      setUploadStatus(null)
      const fileLine = `[Attached files: ${paths.join(', ')}]`
      const message = text.trim() ? `${fileLine}\n${expanded}` : fileLine
      sendInput(message)
    } catch (err) {
      setUploadStatus(`Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      setTimeout(() => setUploadStatus(null), 3000)
    }
  }, [settings.token, activeSessionId, activeWorkingDir, sessions, tentativeQueues, addToQueue, pendingFiles, expandSkill, sendInput])

  const handleExecuteTentative = useCallback((sessionId: string) => {
    const queue = tentativeQueues[sessionId] ?? []
    clearQueue(sessionId)
    queue.forEach((msg, i) => {
      setTimeout(() => sendInput(msg), i * 100)
    })
  }, [tentativeQueues, clearQueue, sendInput])

  const handleDiscardTentative = useCallback((sessionId: string) => {
    clearQueue(sessionId)
  }, [clearQueue])

  // Auto-execute tentative queue when the blocking session(s) finish
  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(tentativeQueues)) {
      if (queue.length === 0) continue
      const session = sessions.find(s => s.id === sessionId)
      if (!session) continue
      const wDir = groupKey(session)
      const blocking = sessions.filter(s => groupKey(s) === wDir && s.isProcessing && s.id !== sessionId)
      if (blocking.length === 0 && sessionId === activeSessionId) {
        handleExecuteTentative(sessionId)
        setTimeout(() => {
          setUploadStatus('Session finished — starting queued session.')
          setTimeout(() => setUploadStatus(null), 3000)
        }, 0)
      }
    }
  }, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tentative messages for the active session (rendered in ChatView after real messages)
  const tentativeMessages: ChatMessage[] = activeSessionId
    ? (tentativeQueues[activeSessionId] ?? []).map((text, index) => ({
        type: 'tentative' as const,
        text,
        index,
        key: `tentative-${index}`,
      }))
    : []

  const activeTentativeCount = activeSessionId ? (tentativeQueues[activeSessionId]?.length ?? 0) : 0

  const skillGroups = [
    { label: 'Global', skills: globalSkills },
    ...(activeRepo && activeRepo.skills.length > 0 ? [{ label: activeRepo.name, skills: activeRepo.skills }] : []),
  ]

  const activityLabel = deriveActivityLabel(messages, isProcessing, thinkingSummary)

  // Sync data-theme attribute on <html> whenever the setting changes
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  return (
    <div className="flex h-full bg-neutral-7">
      {/* Left sidebar — repo/session tree + nav */}
      <LeftSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        activeWorkingDir={activeWorkingDir}
        waitingSessions={waitingSessions}
        tentativeQueues={tentativeQueues}
        groups={groups}
        globalModules={globalModules}
        activeRepo={activeRepo}
        token={settings.token}
        theme={settings.theme}
        fontSize={settings.fontSize}
        connState={connState}
        view={view}
        archiveRefreshKey={archiveRefreshKey}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onRenameSession={renameSession}
        onNewSession={handleNewSessionForRepo}
        onNewSessionFromArchive={handleNewSessionFromArchive}
        onOpenSession={handleOpenSession}
        onSelectRepo={handleSelectRepo}
        onDeleteRepo={handleDeleteRepo}
        onSettingsOpen={() => setSettingsOpen(true)}
        onUpdateTheme={(theme) => updateSettings({ theme: theme as 'dark' | 'light' })}
        onSendModule={handleSendModule}
        onNavigateToWorkflows={() => navigate('/workflows')}
      />

      {/* Main area */}
      <div className="terminal-area flex flex-1 flex-col overflow-hidden bg-neutral-12">
        {/* Error banner */}
        {error && (
          <div className="border-b border-error-9/50 bg-error-10/50 px-4 py-2 text-[15px] text-error-5">
            {error}
          </div>
        )}

        {/* Upload status */}
        {uploadStatus && (
          <div className="border-b border-primary-9/50 bg-primary-10/50 px-4 py-2 text-[15px] text-primary-5">
            {uploadStatus}
          </div>
        )}

        {/* Main content: workflows view or chat */}
        {view === 'workflows' ? (
          <WorkflowsView
            token={settings.token}
            onNavigateToSession={(sessionId) => {
              clearMessages()
              leaveSession()
              joinSession(sessionId)
              navigate(`/s/${sessionId}`)
            }}
          />
        ) : activeSessionId ? (
          <div className="flex flex-1 flex-col overflow-hidden min-h-0">
            <div className="relative flex-1 min-h-0 flex flex-col">
              <ChatView
                messages={[...messages, ...tentativeMessages]}
                fontSize={settings.fontSize}
                theme={settings.theme}
                disabled={!settings.token}
                planningMode={planningMode}
                activityLabel={activityLabel}
              />
              <TodoPanel tasks={tasks} />
            </div>

            {/* Smart prompt buttons (conditional) */}
            {promptOptions && (
              <PromptButtons options={promptOptions} question={promptQuestion} multiSelect={multiSelect} promptType={promptType} questions={promptQuestions} approvePattern={approvePattern} onSelect={sendPromptResponse} />
            )}

            {/* Tentative banner */}
            {activeTentativeCount > 0 && (
              <TentativeBanner
                count={activeTentativeCount}
                repoName={activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? 'this repo'}
                onExecute={() => handleExecuteTentative(activeSessionId)}
                onDiscard={() => handleDiscardTentative(activeSessionId)}
              />
            )}

            {/* Input bar */}
            <InputBar
              key={activeSessionId ?? 'no-session'}
              ref={inputBarRef}
              onSendInput={handleSendWithFiles}
              isWaiting={!!promptOptions}
              disabled={!settings.token}
              onEscape={() => {}}
              pendingFiles={pendingFiles}
              onAddFiles={addFiles}
              onRemoveFile={removeFile}
              skillGroups={skillGroups}
              initialValue={activeSessionId ? (sessionInputs[activeSessionId] ?? '') : ''}
              onValueChange={(v) => { if (activeSessionId) setSessionInputs(prev => ({ ...prev, [activeSessionId]: v })) }}
              currentModel={currentModel}
              onModelChange={setModel}
            />
          </div>
        ) : (
          <RepoSelector groups={groups} token={settings.token} onOpen={handleOpenSession} />
        )}
      </div>

      {/* Modals */}
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        repos={repos}
        globalSkills={globalSkills}
        globalModules={globalModules}
        onOpenRepo={handleOpenSession}
        onSendSkill={handleSendSkill}
        onSendModule={handleSendModule}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </div>
  )
}
