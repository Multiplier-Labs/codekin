/**
 * Root application component — orchestrates the full Codekin UI.
 *
 * Wires together WebSocket chat, session management, repo selection,
 * file uploads, skill expansion, command palette, docs browser, and settings.
 * Layout: top session tab bar, left icon sidebar, main chat area with
 * input bar and prompt buttons, right sidebar with sessions/tasks/approvals.
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
import { Settings } from './components/Settings'
import { ChatView } from './components/ChatView'
import { DocsBrowser } from './components/DocsBrowser'
import { TodoPanel } from './components/TodoPanel'
import { LeftSidebar } from './components/LeftSidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { TentativeBanner } from './components/TentativeBanner'
import { WorkflowsView } from './components/WorkflowsView'
import { CommandPalette } from './components/CommandPalette'
import { InputBar, type InputBarHandle } from './components/InputBar'
import { PromptButtons } from './components/PromptButtons'
import { RepoSelector } from './components/RepoSelector'
import { DiffPanel } from './components/DiffPanel'

export default function App() {
  const { settings, updateSettings } = useSettings()
  const { groups, repos, globalSkills, globalModules, ghMissing } = useRepos(settings.token)
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
    if (id) {
      navigate(`/s/${id}`)
    } else {
      navigate('/', true)
    }
  }, [navigate])

  const [settingsOpen, setSettingsOpen] = useState(!settings.token)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [diffPanelOpen, setDiffPanelOpen] = useState(false)
  /** Callback ref for forwarding WsServerMessages to the diff panel (set by DiffPanel on mount). */
  const diffHandleMessageRef = useRef<(msg: import('./types').WsServerMessage) => void>(() => {})
  /** Callback ref for notifying the diff panel when a tool finishes (triggers auto-refresh). */
  const diffHandleToolDoneRef = useRef<(toolName: string, summary?: string) => void>(() => {})
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Holds context text (e.g. from archive "Continue" action) to inject into the next session's first message. */
  const pendingContextRef = useRef<string | null>(null)
  /** Stable ref to the current sendInput function, used by callbacks that close over stale state. */
  const sendInputRef = useRef<(data: string) => void>(() => {})

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
      }
    },
  })

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
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const activeSessionName = activeSession?.name ?? null
  const activeRepoName = activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? null

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
        onSelectSession={(id) => { docsBrowser.close(); handleSelectSession(id) }}
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

        {/* Main content: workflows view, docs browser, or chat */}
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
        ) : docsBrowser.isOpen ? (
          <div className="flex flex-1 flex-col overflow-hidden min-h-0">
            <DocsBrowser
              repoName={docsRepoName}
              filePath={docsBrowser.selectedFile!}
              content={docsBrowser.content}
              loading={docsBrowser.loading}
              error={docsBrowser.error}
              rawMode={docsBrowser.rawMode}
              isStarred={docsBrowser.isCurrentFileStarred}
              onToggleRaw={docsBrowser.toggleRawMode}
              onToggleStar={docsBrowser.toggleStarCurrentFile}
              onClose={docsBrowser.close}
            />
            {/* Input bar in docs mode */}
            {activeSessionId ? (
              <InputBar
                key={`docs-${activeSessionId}`}
                ref={inputBarRef}
                onSendInput={handleSendWithFiles}
                isWaiting={!!activePrompt}
                disabled={!settings.token}
                onEscape={docsBrowser.close}
                pendingFiles={pendingFiles}
                onAddFiles={addFiles}
                onRemoveFile={removeFile}
                skillGroups={skillGroups}
                slashCommands={allCommands}
                placeholder="Ask Claude about this doc, or request changes..."
                initialValue={activeSessionId ? (sessionInputs[activeSessionId] ?? '') : ''}
                onValueChange={(v) => { if (activeSessionId) setSessionInputs(prev => ({ ...prev, [activeSessionId]: v })) }}
                currentModel={currentModel}
                onModelChange={setModel}
                isMobile={isMobile}
              />
            ) : (
              <div className="px-4 py-3 border-t border-neutral-10">
                <div className="rounded-lg bg-neutral-11 px-3 py-2 text-[15px] text-neutral-5 opacity-40">
                  Start a session to edit this doc
                </div>
              </div>
            )}
          </div>
        ) : activeSessionId ? (
          <div className="flex flex-1 flex-col overflow-hidden min-h-0">
            <div className="relative flex-1 min-h-0 flex flex-col">
              <ChatView
                messages={[...messages, ...tentativeMessages]}
                fontSize={settings.fontSize + (isMobile ? 1 : 0)}
                disabled={!settings.token}
                planningMode={planningMode}
                activityLabel={activityLabel}
                isMobile={isMobile}
              />
              <TodoPanel tasks={tasks} />
            </div>

            {/* Smart prompt buttons (conditional) */}
            {activePrompt && (
              <PromptButtons
                key={activePrompt.requestId}
                options={activePrompt.options}
                question={activePrompt.question}
                multiSelect={activePrompt.multiSelect}
                promptType={activePrompt.promptType}
                questions={activePrompt.questions}
                approvePattern={activePrompt.approvePattern}
                onSelect={sendPromptResponse}
                isMobile={isMobile}
              />
            )}
            {promptQueueSize > 1 && (
              <div className="px-3 py-1 text-[12px] text-neutral-5 bg-neutral-11 border-t border-neutral-10">
                {promptQueueSize - 1} more pending
              </div>
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
              isWaiting={!!activePrompt}
              disabled={!settings.token}
              onEscape={() => {}}
              pendingFiles={pendingFiles}
              onAddFiles={addFiles}
              onRemoveFile={removeFile}
              skillGroups={skillGroups}
              slashCommands={allCommands}
              initialValue={activeSessionId ? (sessionInputs[activeSessionId] ?? '') : ''}
              onValueChange={(v) => { if (activeSessionId) setSessionInputs(prev => ({ ...prev, [activeSessionId]: v })) }}
              currentModel={currentModel}
              onModelChange={setModel}
              isMobile={isMobile}
            />
          </div>
        ) : (
          <RepoSelector groups={groups} token={settings.token} ghMissing={ghMissing} onOpen={handleOpenSession} />
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
