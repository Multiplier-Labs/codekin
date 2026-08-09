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

import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { transport } from './lib/transport'
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
import { useErrorNotification } from './hooks/useErrorNotification'
import { useGlobalKeyBindings } from './hooks/useGlobalKeyBindings'
import { useOpenCodeModelSync } from './hooks/useOpenCodeModelSync'
import { useCodexModelSync } from './hooks/useCodexModelSync'
import { useOpenCodeCommands } from './hooks/useOpenCodeCommands'
import { useProviderValidation } from './hooks/useProviderValidation'
import { buildSlashCommandList, buildOpenCodeSlashCommandList } from './lib/slashCommands'
import { deriveActivityLabel } from './lib/deriveActivityLabel'
import { getQueueMessages, getAgentName, listArchivedSessions, type ArchivedSessionInfo } from './lib/ccApi'
import { Settings } from './components/Settings'
import { LeftSidebar } from './components/LeftSidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { WorkflowsView } from './components/WorkflowsView'
import { LoopRunsView } from './components/LoopRunsView'
import { CommandPalette } from './components/CommandPalette'
import type { InputBarHandle } from './components/InputBar'
import { RepoSelector } from './components/RepoSelector'
import { DiffPanel } from './components/DiffPanel'
import { OrchestratorContent } from './components/OrchestratorContent'
import { DocsBrowserContent } from './components/DocsBrowserContent'
import { SessionContent } from './components/SessionContent'
import { RepoDrawer, type RepoDrawerTab } from './components/RepoDrawer'
import type { PermissionMode, CodingProvider } from './types'
import { useClaudeModelSync } from './hooks/useClaudeModelSync'

// Hosted-only: session sharing. Lazy so the class and its markup are code-split
// out of the local build, which never renders it.
const isHosted = import.meta.env.VITE_APP_MODE === 'hosted'
const ShareDialog = lazy(() => import('./hosted/ShareDialog').then(m => ({ default: m.ShareDialog })))

interface AppProps {
  /**
   * Hosted only: connect this workspace to a different machine. Supplied by
   * MachineWorkspace and handed to Settings, which is where the machine list
   * now lives. Undefined in the local build, which has no machines.
   */
  onSwitchMachine?: (machine: import('./hosted/machines').Machine) => void
}

export default function App({ onSwitchMachine }: AppProps = {}) {
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
  const { error, showError } = useErrorNotification()
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

  /**
   * The mode new sessions start in, read at session-creation time.
   *
   * Backed by localStorage rather than a mount-time snapshot: Settings and the
   * repo drawer's approvals tab both write that key directly, and a cached ref
   * would hand new sessions a mode the user had already changed.
   */
  const permissionModeRef = useMemo(() => ({
    get current(): PermissionMode {
      return (localStorage.getItem('claude-permission-mode') as PermissionMode | null) ?? 'acceptEdits'
    },
    set current(mode: PermissionMode) {
      localStorage.setItem('claude-permission-mode', mode)
    },
  }), [])

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
    setProvider,
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
      showError(msg)
      if (msg.toLowerCase().includes('not found')) {
        setActiveSessionId(null)
      }
    },
    onRawMessage: (msg) => {
      if (msg.type === 'diff_result' || msg.type === 'diff_error') {
        diffHandleMessageRef.current(msg)
      } else if (msg.type === 'tool_done') {
        diffHandleToolDoneRef.current(msg.toolName, msg.summary)
        // Track file-mutating tools to show Code Review button.
        // Case-insensitive: Claude reports 'Edit'/'Write', OpenCode 'edit'/'write'/'patch'.
        const tool = msg.toolName.toLowerCase()
        if (tool === 'edit' || tool === 'write' || tool === 'patch') {
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
  const [claudeDisabled, setClaudeDisabled] = useState(false)
  const [openCodeDisabled, setOpenCodeDisabled] = useState(false)
  const [codexDisabled, setCodexDisabled] = useState(false)
  // Derive the active session's provider (falls back to the default for new sessions)
  const activeSessionProvider = sessions.find(s => s.id === activeSessionId)?.provider ?? currentProvider

  const activeOpenCodeWd = activeSessionProvider === 'opencode'
    ? sessions.find(s => s.id === activeSessionId)?.workingDir
    : undefined

  const { openCodeModels, openCodeConnected, setOpenCodeConnected, reconnect: reconnectOpenCode } = useOpenCodeModelSync({
    token: settings.token,
    activeSessionProvider,
    activeOpenCodeWd,
    currentModel,
    setModel,
    openCodeDisabled,
  })
  const { codexModels, codexConnected, setCodexConnected, reconnect: reconnectCodex } = useCodexModelSync({
    token: settings.token,
    activeSessionProvider,
    currentModel,
    setModel,
    codexDisabled,
  })
  const { claudeModels } = useClaudeModelSync({
    token: settings.token,
    currentModel,
    setModel,
  })
  const availableModels = activeSessionProvider === 'opencode' ? openCodeModels
    : activeSessionProvider === 'codex' ? codexModels
    : claudeModels

  // Reset file-change tracking when switching sessions
  useEffect(() => {
    setHasFileChanges(false) // eslint-disable-line react-hooks/set-state-in-effect -- sync with session change
  }, [activeSessionId])

  useProviderValidation({ activeSessionProvider, currentModel, setModel, claudeModels })

  // Session orchestration: switching, creating, deleting sessions & repos
  const {
    activeWorkingDir,
    handleOpenSession,
    handleSelectSession,
    handleDeleteSession,
    handleSelectRepo,
    handleDeleteRepo,
    handleNewSessionForRepo,
    handleNewSessionInRepo,
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

  // Re-scan repos (and their .claude/skills) when switching to a different
  // repo, so skills added or edited mid-session show up without a reload.
  // Guarded by the last-refreshed dir so joining sessions in the same repo
  // doesn't refetch.
  const lastSkillRefreshDirRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeWorkingDir) return
    if (lastSkillRefreshDirRef.current === activeWorkingDir) return
    const isFirstRepo = lastSkillRefreshDirRef.current === null
    lastSkillRefreshDirRef.current = activeWorkingDir
    // Skip the initial mount — useRepos already fetches on mount.
    if (!isFirstRepo) refreshRepos()
  }, [activeWorkingDir, refreshRepos])

  // All available skills for the current session (global + repo)
  const allSkills = useMemo(() => [
    ...globalSkills,
    ...(activeRepo?.skills ?? []),
  ], [globalSkills, activeRepo?.skills])

  // Unified slash command list for autocomplete (skills + bundled + built-in)
  const allCommands = useMemo(() => buildSlashCommandList(allSkills), [allSkills])

  // OpenCode sessions get the server's own commands instead of Claude skills
  const openCodeCommands = useOpenCodeCommands({
    token: settings.token,
    activeSessionProvider,
    activeOpenCodeWd,
    openCodeDisabled,
  })
  const sessionCommands = useMemo(
    () => activeSessionProvider === 'opencode' ? buildOpenCodeSlashCommandList(openCodeCommands) : allCommands,
    [activeSessionProvider, openCodeCommands, allCommands],
  )

  // Wrap setModel to also persist OpenCode model selection to localStorage
  const handleModelChange = useCallback((model: string) => {
    setModel(model)
    if (activeSessionProvider === 'opencode') {
      localStorage.setItem('opencode-model', model)
    } else if (activeSessionProvider === 'codex') {
      localStorage.setItem('codex-model', model)
    }
  }, [setModel, activeSessionProvider])

  // Switch the active session's coding provider; refresh the session list so
  // provider-derived UI (model list, permission modes) follows immediately.
  const handleProviderChange = useCallback((provider: CodingProvider, carryContext: boolean) => {
    setProvider(provider, carryContext)
    localStorage.setItem('codekin-provider', provider)
    void refreshSessions()
  }, [setProvider, refreshSessions])

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
        // OpenCode has a native summarize endpoint — the server maps the
        // literal /compact to POST /session/:id/summarize. Claude (stream-json)
        // has no such command, so ask the model to compact in-band.
        if (activeSessionProvider === 'opencode') {
          sendInput('/compact')
        } else {
          sendInput('Please compact the conversation context to save tokens while preserving important context.')
        }
        break
      case '/model':
        if (args) {
          handleModelChange(args)
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
  }, [leaveSession, clearMessages, activeWorkingDir, handleNewSessionForRepo, sendInput, currentModel, handleModelChange, activeSessionProvider])

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
  const togglePalette = useCallback(() => setPaletteOpen(prev => !prev), [])
  const toggleDiffPanel = useCallback(() => setDiffPanelOpen(prev => !prev), [])
  useGlobalKeyBindings({ onTogglePalette: togglePalette, onToggleDiffPanel: toggleDiffPanel })

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
  // --- Repo drawer (docs / archive / approvals) -------------------------
  const [drawer, setDrawer] = useState<{ workingDir: string; tab: RepoDrawerTab } | null>(null)

  const handleOpenDrawer = useCallback((workingDir: string, tab: RepoDrawerTab) => {
    setDrawer(prev => (prev?.workingDir === workingDir && prev.tab === tab ? null : { workingDir, tab }))
    // The docs tab reads the picker's file list, so make sure it is loaded.
    if (tab === 'docs') docsBrowser.openPicker(workingDir, settings.token)
  }, [docsBrowser, settings.token])

  const handleDrawerSelectDoc = useCallback((filePath: string) => {
    if (drawer) docsBrowser.openFile(drawer.workingDir, filePath, settings.token)
  }, [drawer, docsBrowser, settings.token])

  // --- Command palette collections --------------------------------------
  const paletteDocs = useMemo(
    () => (docsBrowser.pickerRepoDir
      ? docsBrowser.pickerFiles.map(f => ({
          ...f,
          repoDir: docsBrowser.pickerRepoDir as string,
          starred: docsBrowser.starredDocs.includes(f.path),
        }))
      : []),
    [docsBrowser.pickerFiles, docsBrowser.pickerRepoDir, docsBrowser.starredDocs],
  )

  const [paletteArchived, setPaletteArchived] = useState<ArchivedSessionInfo[]>([])
  useEffect(() => {
    if (!settings.token || !paletteOpen) return
    listArchivedSessions(settings.token).then(setPaletteArchived).catch(() => {})
  }, [settings.token, paletteOpen, archiveRefreshKey])

  const handleOpenDocFromPalette = useCallback((path: string, repoDir: string) => {
    docsBrowser.openFile(repoDir, path, settings.token)
  }, [docsBrowser, settings.token])

  const handleOpenArchivedFromPalette = useCallback((id: string) => {
    const found = paletteArchived.find(a => a.id === id)
    if (found) setDrawer({ workingDir: found.groupDir ?? found.workingDir, tab: 'archive' })
  }, [paletteArchived])

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
      reconnectOpenCode()
    } else {
      setOpenCodeDisabled(true)
      setOpenCodeConnected(false)
      // Leave the current session if it's an OpenCode session
      if (activeSessionProvider === 'opencode' && activeSessionId) {
        leaveSession()
      }
    }
  }, [openCodeDisabled, activeSessionProvider, activeSessionId, leaveSession, reconnectOpenCode, setOpenCodeConnected])

  const handleToggleCodex = useCallback(() => {
    if (codexDisabled) {
      setCodexDisabled(false)
      reconnectCodex()
    } else {
      setCodexDisabled(true)
      setCodexConnected(false)
      // Leave the current session if it's a Codex session
      if (activeSessionProvider === 'codex' && activeSessionId) {
        leaveSession()
      }
    }
  }, [codexDisabled, activeSessionProvider, activeSessionId, leaveSession, reconnectCodex, setCodexConnected])

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const activeSessionName = activeSession?.name ?? null
  const activeRepoName = activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? null

  // Hosted mode shares the active session from the sidebar footer. The
  // machine id comes from the installed relay transport; empty in local mode,
  // where the Share control is never rendered.
  const [shareOpen, setShareOpen] = useState(false)
  const hostedMachineId = (transport as { machineId?: string }).machineId ?? ''

  // Session input change handler for extracted components
  const handleSessionInputChange = useCallback((sessionId: string, value: string) => {
    setSessionInputs(prev => ({ ...prev, [sessionId]: value }))
  }, [])

  return (
    <div className="flex h-full bg-edge-strong" data-density={isMobile ? 'touch' : undefined}>
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
        connState={connState}
        claudeDisabled={claudeDisabled}
        openCodeConnected={openCodeConnected}
        openCodeDisabled={openCodeDisabled}
        onToggleClaude={handleToggleClaude}
        onToggleOpenCode={handleToggleOpenCode}
        codexConnected={codexConnected}
        codexDisabled={codexDisabled}
        onToggleCodex={handleToggleCodex}
        view={view}
        onSelectSession={(id) => { docsBrowser.close(); if (view === 'orchestrator') navigate(`/s/${id}`); handleSelectSession(id) }}
        onDeleteSession={handleDeleteSession}
        onRenameSession={renameSession}
        onNewSessionInRepo={handleNewSessionInRepo}
        onOpenSession={handleOpenSession}
        onSelectRepo={handleSelectRepo}
        onDeleteRepo={handleDeleteRepo}
        onSettingsOpen={() => setSettingsOpen(true)}
        onShareSession={isHosted ? () => setShareOpen(true) : undefined}
        onUpdateTheme={(theme) => updateSettings({ theme: theme as 'dark' | 'light' })}
        onSendModule={handleSendModule}
        agentName={agentName}
        onNavigateToWorkflows={() => navigate('/workflows')}
        onNavigateToLoops={() => navigate('/loops')}
        onNavigateToOrchestrator={() => handleNavigateToOrchestrator()}
        onOpenDrawer={handleOpenDrawer}
        onMoveToWorktree={moveToWorktree}
        mobile={{
          isMobile,
          mobileOpen: mobileMenuOpen,
          onMobileClose: () => setMobileMenuOpen(false),
        }}
      />

      {/* Main area */}
      <div className="terminal-area flex flex-1 flex-col overflow-hidden bg-page">
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
          <div className="border-b border-error-9/50 bg-error-10/50 px-4 py-2 text-body text-error-5">
            {error}
          </div>
        )}

        {/* Upload status */}
        {uploadStatus && (
          <div className="border-b border-primary-9/50 bg-primary-10/50 px-4 py-2 text-body text-primary-5">
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
            isProcessing={isProcessing}
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
            onModelChange={handleModelChange}
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
        ) : view === 'loops' ? (
          <LoopRunsView
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
            slashCommands={sessionCommands}
            sessionInputs={sessionInputs}
            onSessionInputChange={handleSessionInputChange}
            currentModel={currentModel}
            onModelChange={handleModelChange}
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
            isProcessing={isProcessing}
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
            slashCommands={sessionCommands}
            sessionInputs={sessionInputs}
            onSessionInputChange={handleSessionInputChange}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            availableModels={availableModels}
            sessionProvider={activeSessionProvider}
            onProviderChange={handleProviderChange}
            hasUserMessages={messages.some(m => m.type === 'user')}
            useWorktree={useWorktree}
            onWorktreeChange={setUseWorktree}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            moveToWorktree={moveToWorktree}
            worktreePath={activeSession?.worktreePath}
            openCodeConnected={activeSessionProvider === 'opencode' ? (openCodeDisabled ? false : openCodeConnected) : null}
            codexConnected={activeSessionProvider === 'codex' ? (codexDisabled ? false : codexConnected) : null}
            claudeDisabled={activeSessionProvider === 'claude' && claudeDisabled}
          />
        ) : (
          <RepoSelector groups={groups} token={settings.token} ghMissing={ghMissing} onOpen={handleOpenSession} onRefreshRepos={refreshRepos} />
        )}
      </div>

      {/* Repo drawer — independent of the diff panel: own open state, own width */}
      <RepoDrawer
        token={settings.token}
        workingDir={drawer?.workingDir ?? null}
        repoName={(drawer?.workingDir ?? '').replace(/\/+$/, '').split('/').pop() ?? ''}
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        docsFiles={docsBrowser.pickerRepoDir === drawer?.workingDir ? docsBrowser.pickerFiles : []}
        docsLoading={docsBrowser.pickerLoading}
        starredDocs={docsBrowser.starredDocs}
        onSelectDoc={handleDrawerSelectDoc}
        archiveRefreshKey={archiveRefreshKey}
        onViewArchivedSession={() => { /* the drawer owns the viewer */ }}
        onNewSessionFromArchive={handleNewSessionFromArchive}
        fontSize={settings.fontSize}
        initialTab={drawer?.tab}
        isMobile={isMobile}
      />

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
        repos={repos}
        hostedMachineId={hostedMachineId}
        onSwitchMachine={onSwitchMachine}
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
        docs={paletteDocs}
        onSelectDoc={handleOpenDocFromPalette}
        archivedSessions={paletteArchived}
        onSelectArchived={handleOpenArchivedFromPalette}
        activeWorkingDir={activeWorkingDir}
      />
      {isHosted && shareOpen && activeSession && (
        <Suspense fallback={null}>
          <ShareDialog
            machineId={hostedMachineId}
            sessionId={activeSession.id}
            sessionName={activeSessionName ?? activeSession.id}
            onClose={() => setShareOpen(false)}
          />
        </Suspense>
      )}
    </div>
  )
}
