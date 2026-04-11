/**
 * Root application component — orchestrates the full Codekin UI.
 *
 * Wires together WebSocket chat, session management, repo selection,
 * file uploads, skill expansion, command palette, docs browser, and settings.
 * Layout: top session tab bar, left icon sidebar, main chat area with
 * input bar and prompt buttons, right sidebar with sessions/tasks/approvals.
 *
 * Content views are extracted into focused components:
 * - OrchestratorContent: the orchestrator (Joe) chat view
 * - DocsBrowserContent: the documentation browser with input bar
 * - SessionContent: the active chat session with diff panel and prompts
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useSettings } from './hooks/useSettings'
import { useRepos } from './hooks/useRepos'
import { useSessions } from './hooks/useSessions'
import { useChatSocket } from './hooks/useChatSocket'
import { usePageVisibility } from './hooks/usePageVisibility'
import { useRouter } from './hooks/useRouter'
import { useTentativeQueue } from './hooks/useTentativeQueue'
import { useSessionOrchestration } from './hooks/useSessionOrchestration'
import { useDocsBrowser } from './hooks/useDocsBrowser'
import { useIsMobile } from './hooks/useIsMobile'
import { useSendMessage } from './hooks/useSendMessage'
import { buildSlashCommandList } from './lib/slashCommands'
import { deriveActivityLabel } from './lib/deriveActivityLabel'
import { getQueueMessages, getAgentName } from './lib/ccApi'
import { Settings } from './components/Settings'
import { LeftSidebar } from './components/LeftSidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { WorkflowsView } from './components/WorkflowsView'
import { CommandPalette } from './components/CommandPalette'
import type { InputBarHandle } from './components/InputBar'
import { RepoSelector } from './components/RepoSelector'
import { DiffPanel } from './components/DiffPanel'
import { OrchestratorContent } from './components/OrchestratorContent'
import { DocsBrowserContent } from './components/DocsBrowserContent'
import { SessionContent } from './components/SessionContent'
import type { PermissionMode, CodingProvider, ModelOption } from './types'
import { CLAUDE_MODELS } from './types'
import { fetchOpenCodeModels } from './lib/ccApi'

export default function App() {
  const { settings, updateSettings } = useSettings()
  const { groups, repos, globalSkills, globalModules, ghMissing, refresh: refreshRepos } = useRepos(settings.token)
  const { sessions, rename: renameSession, remove: removeSession, refresh: refreshSessions } = useSessions(settings.token)
  const { queues: tentativeQueues, addToQueue, clearQueue } = useTentativeQueue()
  const { sessionId: urlSessionId, view, navigate } = useRouter()
  const docsBrowser = useDocsBrowser()
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const [activeSessionId, setActiveSessionIdRaw] = useState<string | null>(() =>
    urlSessionId ?? localStorage.getItem('codekin-active-session')
  )

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdRaw(id)
    // Don't navigate away from /orchestrator when joining the orchestrator session
    if (view === 'orchestrator') return
    if (id) {
      navigate(`/s/${id}`)
    } else {
      navigate('/', true)
    }
  }, [navigate, view])

  const [settingsOpen, setSettingsOpen] = useState(!settings.token)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [diffPanelOpen, setDiffPanelOpen] = useState(false)
  /** Callback ref for forwarding WsServerMessages to the diff panel (set by DiffPanel on mount). */
  const diffHandleMessageRef = useRef<(msg: import('./types').WsServerMessage) => void>(() => {})
  /** Callback ref for notifying the diff panel when a tool finishes (triggers auto-refresh). */
  const diffHandleToolDoneRef = useRef<(toolName: string, summary?: string) => void>(() => {})
  /** Tracks whether file-mutating tools have fired in this session (heuristic for "has diffs"). */
  const [hasFileChanges, setHasFileChanges] = useState(false)
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Holds context text (e.g. from archive "Continue" action) to inject into the next session's first message. */
  const pendingContextRef = useRef<string | null>(null)
  /** Stable ref to the current sendInput function, used by callbacks that close over stale state. */
  const sendInputRef = useRef<(data: string) => void>(() => {})

  /** Worktree toggle state, persisted to localStorage. */
  const [useWorktree, setUseWorktreeRaw] = useState(() => localStorage.getItem('codekin-use-worktree') === 'true')
  const useWorktreeRef = useRef(useWorktree)
  useEffect(() => { useWorktreeRef.current = useWorktree }, [useWorktree])
  const setUseWorktree = useCallback((v: boolean) => {
    setUseWorktreeRaw(v)
    localStorage.setItem('codekin-use-worktree', String(v))
  }, [])

  /** Queue messages setting — fetched from server, default off. */
  const [queueEnabled, setQueueEnabled] = useState(false)
  useEffect(() => {
    if (!settings.token) return
    getQueueMessages(settings.token).then(setQueueEnabled).catch(() => {})
  }, [settings.token])

  /** Agent display name — fetched from server. */
  const [agentName, setAgentName] = useState('Joe')
  useEffect(() => {
    if (!settings.token) return
    getAgentName(settings.token).then(setAgentName).catch(() => {})
  }, [settings.token])

  /** Permission mode ref for session orchestration (read at session creation time). */
  const permissionModeRef = useRef<PermissionMode>(
    (localStorage.getItem('claude-permission-mode') as PermissionMode) || 'acceptEdits'
  )

  /** Provider ref for session orchestration (read at session creation time). */
  const providerRef = useRef<CodingProvider>(
    (localStorage.getItem('codekin-provider') as CodingProvider) || 'claude'
  )

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
    activePrompt,
    promptQueueSize,
    joinSession,
    createSession: wsCreateSession,
    sendInput,
    sendPromptResponse,
    leaveSession,
    clearMessages,
    restoreSession,
    currentModel,
    setModel,
    send: wsSend,
    disconnect: wsDisconnect,
    reconnect: wsReconnect,
    currentPermissionMode,
    setPermissionMode,
    moveToWorktree,
  } = useChatSocket({
    token: settings.token,
    onSessionCreated: (sessionId) => {
      setActiveSessionId(sessionId)
      void refreshSessions()
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
      void refreshSessions()
    },
    onSessionsUpdated: () => {
      void refreshSessions()
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
    onRawMessage: (msg) => {
      if (msg.type === 'diff_result' || msg.type === 'diff_error') {
        diffHandleMessageRef.current(msg)
      } else if (msg.type === 'tool_done') {
        diffHandleToolDoneRef.current(msg.toolName, msg.summary)
        // Track file-mutating tools to show Code Review button
        if (msg.toolName === 'Edit' || msg.toolName === 'Write') {
          setHasFileChanges(true)
        }
      }
    },
  })

  // Wrap setPermissionMode to update the ref synchronously (avoids 1-render lag from useEffect)
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    permissionModeRef.current = mode
    setPermissionMode(mode)
  }, [setPermissionMode])

  // Provider is per-session; default for new sessions is persisted to localStorage
  const [currentProvider] = useState<CodingProvider>(
    (localStorage.getItem('codekin-provider') as CodingProvider) || 'claude'
  )
  // Dynamic model list for OpenCode (fetched from server on demand)
  const [openCodeModels, setOpenCodeModels] = useState<ModelOption[]>([])
  const [openCodeConnected, setOpenCodeConnected] = useState<boolean | null>(null) // null = unknown
  const [claudeDisabled, setClaudeDisabled] = useState(false)
  const [openCodeDisabled, setOpenCodeDisabled] = useState(false)
  const openCodeModelsDirRef = useRef<string | undefined>(undefined)
  // Derive the active session's provider (falls back to the default for new sessions)
  const activeSessionProvider = sessions.find(s => s.id === activeSessionId)?.provider ?? currentProvider
  const availableModels = activeSessionProvider === 'opencode' ? openCodeModels : CLAUDE_MODELS

  // Fetch OpenCode models when switching to an OpenCode session
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  const activeOpenCodeWd = activeSessionProvider === 'opencode'
    ? sessions.find(s => s.id === activeSessionId)?.workingDir
    : undefined
  useEffect(() => {
    if (activeSessionProvider !== 'opencode' || !settings.token) return
    const wdChanged = activeOpenCodeWd && activeOpenCodeWd !== openCodeModelsDirRef.current
    const currentIsValidOpenCode = currentModelRef.current && openCodeModels.some(m => m.id === currentModelRef.current)
    if (!wdChanged && openCodeModels.length > 0 && currentIsValidOpenCode) return
    const activeWd = activeOpenCodeWd
    fetchOpenCodeModels(settings.token, activeWd).then(result => {
      const models: ModelOption[] = result.models.map(m => ({
        id: `${m.providerID}/${m.id}`,
        label: `${m.name} (${m.providerName})`,
      }))
      setOpenCodeModels(models)
      setOpenCodeConnected(models.length > 0)
      openCodeModelsDirRef.current = activeWd
      const currentIsOpenCode = currentModelRef.current && models.some(m => m.id === currentModelRef.current)
      if (!currentIsOpenCode) {
        const [defaultProvider, defaultModelId] = Object.entries(result.defaults)[0] ?? []
        if (defaultProvider && defaultModelId) setModel(`${defaultProvider}/${defaultModelId}`)
        else if (models.length > 0) setModel(models[0].id)
      }
    }).catch(() => { setOpenCodeConnected(false) })
  }, [activeSessionProvider, settings.token, openCodeModels.length, setModel, activeOpenCodeWd])

  // Reset file-change tracking when switching sessions
  useEffect(() => {
    setHasFileChanges(false) // eslint-disable-line react-hooks/set-state-in-effect -- sync with session change
  }, [activeSessionId])

  // Validate currentModel when switching to a Claude session (OpenCode validation is in the other useEffect)
  useEffect(() => {
    if (activeSessionProvider !== 'claude') return
    if (!CLAUDE_MODELS.some(m => m.id === currentModel)) {
      setModel(CLAUDE_MODELS[0].id)
    }
  }, [activeSessionProvider, currentModel, setModel])

  // Session orchestration: switching, creating, deleting sessions & repos
  const {
    activeWorkingDir,
    handleOpenSession,
    handleSelectSession,
    handleDeleteSession,
    handleSelectRepo,
    handleDeleteRepo,
    handleNewSessionForRepo,
    handleNewSessionFromArchive,
  } = useSessionOrchestration({
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
  })

  // Derive active repo from the active session
  const activeRepo = activeWorkingDir
    ? repos.find(r => r.workingDir === activeWorkingDir) ?? null
    : null

  // All available skills for the current session (global + repo)
  const allSkills = useMemo(() => [
    ...globalSkills,
    ...(activeRepo?.skills ?? []),
  ], [globalSkills, activeRepo?.skills])

  // Unified slash command list for autocomplete (skills + bundled + built-in)
  const allCommands = useMemo(() => buildSlashCommandList(allSkills), [allSkills])

  // Handle built-in slash commands locally (not sent to Claude)
  const handleBuiltinCommand = useCallback((command: string, args: string) => {
    switch (command) {
      case '/clear':
      case '/reset':
      case '/new':
        leaveSession()
        clearMessages()
        if (activeWorkingDir) handleNewSessionForRepo()
        break
      case '/compact':
        sendInput('Please compact the conversation context to save tokens while preserving important context.')
        break
      case '/model':
        if (args) {
          setModel(args)
        } else {
          sendInput(`Current model: ${currentModel ?? 'default'}. To change, use the model selector in the input bar.`)
        }
        break
      case '/help':
        sendInput('[Codekin] Available commands: /clear, /compact, /model, /cost, /status, /help. Skills: type / to see autocomplete.')
        break
      default:
        sendInput(`[Codekin] Command ${command} is not available in the web UI.`)
        break
    }
  }, [leaveSession, clearMessages, activeWorkingDir, handleNewSessionForRepo, sendInput, currentModel, setModel])

  // Message sending: file uploads, skill expansion, tentative queue
  const {
    handleSend: handleSendWithFiles,
    handleExecuteTentative,
    handleDiscardTentative,
    tentativeMessages,
    activeTentativeCount,
    pendingFiles,
    addFiles,
    removeFile,
    uploadStatus,
  } = useSendMessage({
    token: settings.token,
    activeSessionId,
    activeWorkingDir,
    sessions,
    allSkills,
    sendInput,
    onBuiltinCommand: handleBuiltinCommand,
    tentativeQueues,
    addToQueue,
    clearQueue,
    docsContext: {
      isOpen: docsBrowser.isOpen,
      selectedFile: docsBrowser.selectedFile,
      repoWorkingDir: docsBrowser.repoWorkingDir,
    },
    queueEnabled,
  })

  // Keep sendInputRef in sync so onSessionCreated can use it
  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])

  // Cmd+K and Cmd+Shift+D listeners
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        setDiffPanelOpen(prev => !prev)
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

  // React to browser back/forward navigation.
  // This effect syncs app state when the user clicks the browser back/forward buttons.
  // It tracks `urlSessionId` (from popstate) and intentionally OMITS `activeSessionId`,
  // `clearMessages`, `leaveSession`, `joinSession`, and `setActiveSessionIdRaw` from the
  // dependency array. Including `activeSessionId` would cause an infinite loop: this effect
  // sets it, which would re-trigger the effect. The other callbacks are stable refs that
  // don't change, but listing them would obscure the intentional `activeSessionId` omission.
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

  // Close docs browser when switching sessions
  useEffect(() => {
    if (docsBrowser.isOpen) docsBrowser.close() // eslint-disable-line react-hooks/set-state-in-effect -- sync with session change
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendSkill = useCallback((command: string) => {
    inputBarRef.current?.insertText(command + ' ')
  }, [])

  const handleSendModule = useCallback((mod: { name: string; content: string }) => {
    sendInput(`[Module: ${mod.name}]\n\n${mod.content}`)
  }, [sendInput])

  const skillGroups = [
    { label: 'Global', skills: globalSkills },
    ...(activeRepo && activeRepo.skills.length > 0 ? [{ label: activeRepo.name, skills: activeRepo.skills }] : []),
  ]

  const activityLabel = deriveActivityLabel(messages, isProcessing, thinkingSummary)

  // Docs browser: derive the repo name for the currently viewed doc
  const docsRepoName = useMemo(() => {
    if (!docsBrowser.repoWorkingDir) return ''
    const parts = docsBrowser.repoWorkingDir.replace(/\/+$/, '').split('/')
    return parts[parts.length - 1] || docsBrowser.repoWorkingDir
  }, [docsBrowser.repoWorkingDir])

  // Navigate to the orchestrator view
  const orchestratorSessionRef = useRef<string | null>(null)
  const handleNavigateToOrchestrator = useCallback(() => {
    navigate('/orchestrator')
    // If we already know the orchestrator session ID, join it immediately
    if (orchestratorSessionRef.current) {
      clearMessages()
      leaveSession()
      joinSession(orchestratorSessionRef.current)
    }
  }, [navigate, clearMessages, leaveSession, joinSession])

  const handleOrchestratorSessionReady = useCallback((sessionId: string) => {
    orchestratorSessionRef.current = sessionId
    clearMessages()
    leaveSession()
    joinSession(sessionId)
  }, [clearMessages, leaveSession, joinSession])

  // Docs browser: handle browse docs from sidebar
  const handleBrowseDocs = useCallback((workingDir: string) => {
    if (docsBrowser.pickerOpen && docsBrowser.pickerRepoDir === workingDir) {
      docsBrowser.closePicker()
    } else {
      docsBrowser.openPicker(workingDir, settings.token)
    }
  }, [docsBrowser, settings.token])

  // Docs browser: handle file selection from picker
  const handleSelectDocFile = useCallback((filePath: string) => {
    if (docsBrowser.pickerRepoDir) {
      docsBrowser.openFile(docsBrowser.pickerRepoDir, filePath, settings.token)
    }
  }, [docsBrowser, settings.token])

  // Sync data-theme attribute on <html> whenever the setting changes
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Derive session name for mobile top bar
  // Connection toggle handlers
  const handleToggleClaude = useCallback(() => {
    if (claudeDisabled) {
      setClaudeDisabled(false)
      wsReconnect()
    } else {
      setClaudeDisabled(true)
      wsDisconnect()
    }
  }, [claudeDisabled, wsDisconnect, wsReconnect])

  const handleToggleOpenCode = useCallback(() => {
    if (openCodeDisabled) {
      setOpenCodeDisabled(false)
      // Re-fetch models to check connection
      if (settings.token) {
        fetchOpenCodeModels(settings.token).then(result => {
          const models: ModelOption[] = result.models.map(m => ({
            id: `${m.providerID}/${m.id}`,
            label: `${m.name} (${m.providerName})`,
          }))
          setOpenCodeModels(models)
          setOpenCodeConnected(models.length > 0)
        }).catch(() => { setOpenCodeConnected(false) })
      }
    } else {
      setOpenCodeDisabled(true)
      setOpenCodeConnected(false)
      // Leave the current session if it's an OpenCode session
      if (activeSessionProvider === 'opencode' && activeSessionId) {
        leaveSession()
      }
    }
  }, [openCodeDisabled, settings.token, activeSessionProvider, activeSessionId, leaveSession])

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const activeSessionName = activeSession?.name ?? null
  const activeRepoName = activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? null

  // Session input change handler for extracted components
  const handleSessionInputChange = useCallback((sessionId: string, value: string) => {
    setSessionInputs(prev => ({ ...prev, [sessionId]: value }))
  }, [])

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
        claudeDisabled={claudeDisabled}
        openCodeConnected={openCodeConnected}
        openCodeDisabled={openCodeDisabled}
        onToggleClaude={handleToggleClaude}
        onToggleOpenCode={handleToggleOpenCode}
        view={view}
        archiveRefreshKey={archiveRefreshKey}
        onSelectSession={(id) => { docsBrowser.close(); if (view === 'orchestrator') navigate(`/s/${id}`); handleSelectSession(id) }}
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
        agentName={agentName}
        onNavigateToWorkflows={() => navigate('/workflows')}
        onNavigateToOrchestrator={() => handleNavigateToOrchestrator()}
        onBrowseDocs={handleBrowseDocs}
        docsPicker={{
          open: docsBrowser.pickerOpen,
          repoDir: docsBrowser.pickerRepoDir,
          files: docsBrowser.pickerFiles,
          loading: docsBrowser.pickerLoading,
          onSelect: handleSelectDocFile,
          onClose: docsBrowser.closePicker,
          starredDocs: docsBrowser.starredDocs,
        }}
        mobile={{
          isMobile,
          mobileOpen: mobileMenuOpen,
          onMobileClose: () => setMobileMenuOpen(false),
        }}
      />

      {/* Main area */}
      <div className="terminal-area flex flex-1 flex-col overflow-hidden bg-neutral-12">
        {/* Mobile top bar */}
        {isMobile && (
          <MobileTopBar
            repoName={activeRepoName}
            sessionName={activeSessionName}
            onMenuOpen={() => setMobileMenuOpen(true)}
            onNewSession={handleNewSessionForRepo}
            onSettingsOpen={() => setSettingsOpen(true)}
            activeRepo={activeRepo}
          />
        )}
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

        {/* Main content: orchestrator, workflows view, docs browser, or chat */}
        {view === 'orchestrator' ? (
          <OrchestratorContent
            token={settings.token}
            onOrchestratorSessionReady={handleOrchestratorSessionReady}
            sessionJoined={!!activeSessionId}
            activeSessionId={activeSessionId}
            messages={[...messages, ...tentativeMessages]}
            fontSize={settings.fontSize + (isMobile ? 1 : 0)}
            isMobile={isMobile}
            planningMode={planningMode}
            activityLabel={activityLabel}
            tasks={tasks}
            activePrompt={activePrompt}
            sendPromptResponse={sendPromptResponse}
            inputBarRef={inputBarRef}
            onSendInput={handleSendWithFiles}
            pendingFiles={pendingFiles}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            skillGroups={skillGroups}
            slashCommands={allCommands}
            currentModel={currentModel}
            onModelChange={setModel}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            disabled={!settings.token}
            agentName={agentName}
          />
        ) : view === 'workflows' ? (
          <WorkflowsView
            token={settings.token}
            onNavigateToSession={(sessionId) => {
              clearMessages()
              leaveSession()
              joinSession(sessionId)
              navigate(`/s/${sessionId}`)
            }}
          />
        ) : docsBrowser.isOpen ? (
          <DocsBrowserContent
            docsRepoName={docsRepoName}
            filePath={docsBrowser.selectedFile!}
            content={docsBrowser.content}
            loading={docsBrowser.loading}
            error={docsBrowser.error}
            rawMode={docsBrowser.rawMode}
            isStarred={docsBrowser.isCurrentFileStarred}
            onToggleRaw={docsBrowser.toggleRawMode}
            onToggleStar={docsBrowser.toggleStarCurrentFile}
            onClose={docsBrowser.close}
            activeSessionId={activeSessionId}
            inputBarRef={inputBarRef}
            onSendInput={handleSendWithFiles}
            activePrompt={activePrompt}
            disabled={!settings.token}
            pendingFiles={pendingFiles}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            skillGroups={skillGroups}
            slashCommands={allCommands}
            sessionInputs={sessionInputs}
            onSessionInputChange={handleSessionInputChange}
            currentModel={currentModel}
            onModelChange={setModel}
            isMobile={isMobile}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            moveToWorktree={moveToWorktree}
            worktreePath={activeSession?.worktreePath}
          />
        ) : activeSessionId ? (
          <SessionContent
            activeSessionId={activeSessionId}
            messages={[...messages, ...tentativeMessages]}
            fontSize={settings.fontSize + (isMobile ? 1 : 0)}
            isMobile={isMobile}
            planningMode={planningMode}
            activityLabel={activityLabel}
            tasks={tasks}
            disabled={!settings.token}
            hasFileChanges={hasFileChanges}
            diffPanelOpen={diffPanelOpen}
            onOpenDiffPanel={() => setDiffPanelOpen(true)}
            activePrompt={activePrompt}
            promptQueueSize={promptQueueSize}
            sendPromptResponse={sendPromptResponse}
            activeTentativeCount={activeTentativeCount}
            activeRepoName={activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? 'this repo'}
            onExecuteTentative={() => handleExecuteTentative(activeSessionId)}
            onDiscardTentative={() => handleDiscardTentative(activeSessionId)}
            inputBarRef={inputBarRef}
            onSendInput={handleSendWithFiles}
            pendingFiles={pendingFiles}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            skillGroups={skillGroups}
            slashCommands={allCommands}
            sessionInputs={sessionInputs}
            onSessionInputChange={handleSessionInputChange}
            currentModel={currentModel}
            onModelChange={setModel}
            availableModels={availableModels}
            hasUserMessages={messages.some(m => m.type === 'user')}
            useWorktree={useWorktree}
            onWorktreeChange={setUseWorktree}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            moveToWorktree={moveToWorktree}
            worktreePath={activeSession?.worktreePath}
            openCodeConnected={activeSessionProvider === 'opencode' ? (openCodeDisabled ? false : openCodeConnected) : null}
            claudeDisabled={activeSessionProvider !== 'opencode' && claudeDisabled}
          />
        ) : (
          <RepoSelector groups={groups} token={settings.token} ghMissing={ghMissing} onOpen={handleOpenSession} onRefreshRepos={refreshRepos} />
        )}
      </div>

      {/* Diff viewer sidebar */}
      {activeSessionId && (
        <DiffPanel
          isOpen={diffPanelOpen}
          onClose={() => setDiffPanelOpen(false)}
          send={wsSend}
          onHandleMessage={(fn) => { diffHandleMessageRef.current = fn }}
          onHandleToolDone={(fn) => { diffHandleToolDoneRef.current = fn }}
        />
      )}

      {/* Modals */}
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
        isMobile={isMobile}
        autoWorktree={useWorktree}
        onAutoWorktreeChange={setUseWorktree}
        agentName={agentName}
        onAgentNameChange={setAgentName}
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
        isMobile={isMobile}
      />
    </div>
  )
}
