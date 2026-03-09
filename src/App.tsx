/**
 * Root application component — orchestrates the full Codekin UI.
 *
 * Wires together WebSocket chat, session management, repo selection,
 * file uploads, skill expansion, command palette, docs browser, and settings.
 * Layout: top session tab bar, left icon sidebar, main chat area with
 * input bar and prompt buttons, right sidebar with sessions/tasks/approvals.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { ChatMessage } from './types'
import { useSettings } from './hooks/useSettings'
import { useRepos } from './hooks/useRepos'
import { useSessions } from './hooks/useSessions'
import { useChatSocket } from './hooks/useChatSocket'
import { usePageVisibility } from './hooks/usePageVisibility'
import { useRouter } from './hooks/useRouter'
import { useTentativeQueue } from './hooks/useTentativeQueue'
import { useSessionOrchestration, groupKey } from './hooks/useSessionOrchestration'
import { useDocsBrowser } from './hooks/useDocsBrowser'
import { useIsMobile } from './hooks/useIsMobile'
import { uploadFile } from './lib/ccApi'
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

export default function App() {
  const { settings, updateSettings } = useSettings()
  const { groups, repos, globalSkills, globalModules } = useRepos(settings.token)
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

    // Include docs context if viewing a doc
    const docsContext = docsBrowser.isOpen && docsBrowser.selectedFile && docsBrowser.repoWorkingDir
      ? `[Viewing doc: ${docsBrowser.selectedFile} in ${docsBrowser.repoWorkingDir}]\n\n`
      : ''

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
      addToQueue(activeSessionId, docsContext + expanded, pendingFiles)
      if (pendingFiles.length > 0) {
        setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [] }))
      }
      return
    }

    const files = pendingFiles
    if (files.length === 0) {
      // displayText is the original slash command (e.g. "/commit") when `expanded`
      // is the full skill content — the server echoes displayText to the chat so
      // the user sees the compact command form rather than the raw skill markdown.
      sendInput(docsContext + expanded, displayText)
      return
    }
    setUploadStatus('Uploading files...')
    try {
      const paths = await Promise.all(files.map(f => uploadFile(settings.token, f)))
      if (activeSessionId) setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [] }))
      setUploadStatus(null)
      const fileLine = `[Attached files: ${paths.join(', ')}]`
      const message = text.trim() ? `${fileLine}\n${docsContext}${expanded}` : fileLine
      sendInput(message)
    } catch (err) {
      setUploadStatus(`Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      setTimeout(() => setUploadStatus(null), 3000)
    }
  }, [settings.token, activeSessionId, activeWorkingDir, sessions, tentativeQueues, addToQueue, pendingFiles, expandSkill, sendInput, docsBrowser.isOpen, docsBrowser.selectedFile, docsBrowser.repoWorkingDir])

  const handleExecuteTentative = useCallback(async (sessionId: string) => {
    const queue = tentativeQueues[sessionId] ?? []
    clearQueue(sessionId)
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i]
      if (i > 0) await new Promise(r => setTimeout(r, 100))
      if (entry.files.length > 0 && settings.token) {
        try {
          const paths = await Promise.all(entry.files.map(f => uploadFile(settings.token, f)))
          const fileLine = `[Attached files: ${paths.join(', ')}]`
          const message = entry.text.trim() ? `${fileLine}\n${entry.text}` : fileLine
          sendInput(message)
        } catch {
          // Upload failed — send the text portion anyway
          sendInput(entry.text)
        }
      } else {
        sendInput(entry.text)
      }
    }
  }, [tentativeQueues, clearQueue, sendInput, settings.token])

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
    ? (tentativeQueues[activeSessionId] ?? []).map((entry, index) => ({
        type: 'tentative' as const,
        text: entry.files.length > 0
          ? `${entry.text}\n📎 ${entry.files.length} file${entry.files.length > 1 ? 's' : ''} attached`
          : entry.text,
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
        docsPickerOpen={docsBrowser.pickerOpen}
        docsPickerRepoDir={docsBrowser.pickerRepoDir}
        docsPickerFiles={docsBrowser.pickerFiles}
        docsPickerLoading={docsBrowser.pickerLoading}
        onDocsPickerSelect={handleSelectDocFile}
        onDocsPickerClose={docsBrowser.closePicker}
        docsStarredDocs={docsBrowser.starredDocs}
        isMobile={isMobile}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
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
                isWaiting={!!promptOptions}
                disabled={!settings.token}
                onEscape={docsBrowser.close}
                pendingFiles={pendingFiles}
                onAddFiles={addFiles}
                onRemoveFile={removeFile}
                skillGroups={skillGroups}
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
                fontSize={settings.fontSize}
                theme={settings.theme}
                disabled={!settings.token}
                planningMode={planningMode}
                activityLabel={activityLabel}
                isMobile={isMobile}
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
              isMobile={isMobile}
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
