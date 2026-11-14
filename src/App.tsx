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
import { getPref, loadPrefs, setPref, usePref } from './lib/prefs'
import { useRepos } from './hooks/useRepos'
import { useSessions } from './hooks/useSessions'
import { useAttentionNotifications } from './hooks/useAttentionNotifications'
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
import { useGrokModelSync } from './hooks/useGrokModelSync'
import { useOpenCodeCommands } from './hooks/useOpenCodeCommands'
import { useProviderValidation } from './hooks/useProviderValidation'
import { buildSlashCommandList, buildOpenCodeSlashCommandList } from './lib/slashCommands'
import { deriveActivityLabel } from './lib/deriveActivityLabel'
import { emitWorkflowEvent } from './lib/workflowEvents'
import { setAgentHealth, getAgentHealth, resolveDefaultProvider } from './lib/agentHealth'
import { useAgentHealth } from './hooks/useAgentHealth'
import { getQueueMessages, getAgentName, listArchivedSessions, type ArchivedSessionInfo, attachFolder, cloneRepo, createScratch, detachFolder, gitInit, moveSessionFolder, orgFolder, publishToGitHub, uploadAndBuildMessage } from './lib/ccApi'
import { ContextBar } from './components/ContextBar'
import { KeepThisWork } from './components/KeepThisWork'
import { sessionIsShared } from './hosted/sessionShares'
import { SettingsView } from './components/settings/SettingsView'
import { LeftSidebar } from './components/LeftSidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { AutomationsView } from './components/AutomationsView'
import { CommandPalette } from './components/CommandPalette'
import type { InputBarHandle } from './components/InputBar'
import { NewSessionComposer } from './components/NewSessionComposer'
import { EnvironmentChecklist } from './components/EnvironmentChecklist'
import { defaultPlace, getRecentPlaces, isNotRepoPlace, placeFromSession, rememberPlace, sessionPlaceLabel, type DraftPlace } from './lib/places'
import { resolvePlacePath, startDraftSession } from './lib/startDraftSession'
import { useDraftPermissionMode, useDraftState } from './hooks/useDraftState'
import { DiffPanel } from './components/DiffPanel'
import { OrchestratorContent } from './components/OrchestratorContent'
import { TasksView } from './components/TasksView'
import { useJoeTasks } from './hooks/useJoeTasks'
import { useJoeStatus } from './hooks/useJoeStatus'
import { useSessionTasks } from './hooks/useSessionTasks'
import { attentionCount } from './lib/tasksApi'
import { effectiveOwner, handOverToJoe, takeBackControl } from './lib/joeApi'
import { MaintenanceView } from './components/MaintenanceView'
import { useMaintenance } from './hooks/useMaintenance'
import { maintenancePath } from './hooks/useRouter'
import { DocsBrowserContent } from './components/DocsBrowserContent'
import { SessionContent } from './components/SessionContent'
import { CanvasPanel } from './components/canvas/CanvasPanel'
import { ChangesStrip } from './components/canvas/ChangesStrip'
import { useCanvas, type CanvasApi } from './hooks/useCanvas'
import { CANVAS_CHAT_WIDTH, CANVAS_SIDE_BY_SIDE_MIN, canvasKindForPath, clampChatWidth } from './lib/canvas'
import { formatWithContext, type CanvasAttachment } from './lib/canvasContext'
import { RepoDrawer, type RepoDrawerTab } from './components/RepoDrawer'
import type { PermissionMode, CodingProvider } from './types'
import { applyTheme } from './themes/registry'
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
  /**
   * Hosted only: leave this machine for the picker. Also handed to Settings —
   * it replaced the floating exit button that used to sit over the transcript.
   */
  onDisconnectMachine?: () => void
}

/**
 * Loads the user's preferences from the connected server before the app
 * renders, so every component can read them synchronously on mount. Without
 * a token (first-run setup) the app renders on defaults, then remounts once
 * a token is saved and its preferences are loaded.
 */
/** Below the relay's 30 s heartbeat: nothing can have been dropped. */
const SHORT_ABSENCE_MS = 25_000

export default function App(props: AppProps = {}) {
  const { settings } = useSettings()
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  useEffect(() => {
    if (!settings.token) return
    let cancelled = false
    void loadPrefs(settings.token).then(() => { if (!cancelled) setLoadedFor(settings.token) })
    return () => { cancelled = true }
  }, [settings.token])
  if (settings.token && loadedFor !== settings.token) return <div className="h-full bg-page" />
  return <AppMain key={loadedFor ?? 'setup'} {...props} />
}

function AppMain({ onSwitchMachine, onDisconnectMachine }: AppProps) {
  const { settings, updateSettings } = useSettings()
  const {
    groups, repos, globalSkills, globalModules,
    loading: reposLoading, error: reposError, ghStatus, ghError,
    refresh: refreshRepos,
  } = useRepos(settings.token)
  const { sessions, rename: renameSession, archive: archiveSession, refresh: refreshSessions } = useSessions(settings.token)
  const { queues: tentativeQueues, addToQueue, clearQueue } = useTentativeQueue()
  const { sessionId: urlSessionId, view, automationsTab, settingsSection, maintenanceRepo, path: routePath, navigate } = useRouter()

  // Canonicalize the pre-unification routes: /workflows and /loops render the
  // Automations view (with the matching tab); the URL becomes /automations.
  useEffect(() => {
    if (view === 'automations' && routePath !== '/automations') navigate('/automations', true)
  }, [view, routePath, navigate])
  const docsBrowser = useDocsBrowser()
  const isMobile = useIsMobile()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const [activeSessionId, setActiveSessionIdRaw] = useState<string | null>(() =>
    urlSessionId ?? getPref('activeSessionId') ?? null
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

  // Settings is a routed view (/settings/<section>); leaving returns to the session.
  const openSettings = useCallback((section?: string) => {
    navigate(section ? `/settings/${section}` : '/settings')
  }, [navigate])
  const closeSettings = useCallback(() => {
    navigate(activeSessionId ? `/s/${activeSessionId}` : '/')
  }, [navigate, activeSessionId])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [diffPanelOpen, setDiffPanelOpen] = useState(false)
  /** Callback ref for forwarding WsServerMessages to the diff panel (set by DiffPanel on mount). */
  const diffHandleMessageRef = useRef<(msg: import('./types').WsServerMessage) => void>(() => {})
  /** Callback ref for notifying the diff panel when a tool finishes (triggers auto-refresh). */
  const diffHandleToolDoneRef = useRef<(toolName: string, summary?: string) => void>(() => {})
  /** Callback ref for notifying the diff panel that an agent turn finished. */
  const diffHandleTurnDoneRef = useRef<() => void>(() => {})
  /** Canvas message handling and item-list requests (set once the socket exists). */
  const canvasRef = useRef<CanvasApi | null>(null)
  const canvasListRef = useRef<() => void>(() => {})
  /** Tracks whether file-mutating tools have fired in this session (heuristic for "has diffs"). */
  const [hasFileChanges, setHasFileChanges] = useState(false)
  /** What the active session has to review; drives the Changes button even when no edit happened in this browser. */
  const [changeSummary, setChangeSummary] = useState<{ uncommittedFiles: number; branchCommits: number | null } | null>(null)
  /** Asks the server for the active session's change summary (debounced; set once the socket exists). */
  const requestChangeSummaryRef = useRef<() => void>(() => {})
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0)
  const { error, showError } = useErrorNotification()
  /** Holds context text (e.g. from archive "Continue" action) to inject into the next session's first message. */
  const pendingContextRef = useRef<string | null>(null)
  /** Stable ref to the current sendInput function, used by callbacks that close over stale state. */
  const sendInputRef = useRef<(data: string) => void>(() => {})

  /** Worktree toggle for new sessions. On by default; only an explicit opt-out turns it off. */
  const [useWorktree, setUseWorktreeRaw] = useState(() => getPref('useWorktree') !== false)
  const useWorktreeRef = useRef(useWorktree)
  useEffect(() => { useWorktreeRef.current = useWorktree }, [useWorktree])
  const setUseWorktree = useCallback((v: boolean) => {
    setUseWorktreeRaw(v)
    setPref('useWorktree', v)
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
   * Backed by the prefs store rather than a mount-time snapshot: Settings and the
   * repo drawer's approvals tab both write that pref directly, and a cached ref
   * would hand new sessions a mode the user had already changed.
   */
  const permissionModeRef = useMemo(() => ({
    get current(): PermissionMode {
      return getPref('permissionMode') ?? 'acceptEdits'
    },
    set current(mode: PermissionMode) {
      setPref('permissionMode', mode)
    },
  }), [])

  /**
   * Default provider for new sessions, read at session-creation time. Resolved
   * against live agent health so a fresh browser whose implicit default
   * (Claude) isn't installed or signed in starts with a healthy agent instead
   * (audit N6). A saved, installed choice is respected.
   */
  const providerRef = useMemo(() => ({
    get current(): CodingProvider {
      return resolveDefaultProvider(getAgentHealth(), getPref('provider') ?? null)
    },
  }), [])

  const inputBarRef = useRef<InputBarHandle>(null)
  const [sessionInputs, setSessionInputs] = useState<Record<string, string>>({})
  // Creating a session takes seconds (worktree setup, harness spawn). Until
  // session_created arrives the composer still belongs to the previous
  // session, so text typed meanwhile lands in that session's draft and the
  // new session's composer mounts empty. Remember what the draft held when
  // the create was asked for, and hand anything typed since to the new session.
  const pendingCreateDraftRef = useRef<{ fromId: string | null; before: string } | null>(null)

  // --- New-session composer (draft) -----------------------------------------
  // The draft screen holds what the next session will be — where it runs,
  // which agent — before anything exists on the server. Send creates it; the
  // first message follows once session_created arrives.
  const recentPlacesPref = usePref('recentPlaces')
  const [draftPlace, setDraftPlace] = useState<DraftPlace>(() => defaultPlace(getRecentPlaces()))
  const [draftProviderChoice, setDraftProviderChoice] = useState<CodingProvider | null>(null)
  const draft = useDraftState()

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
    askJoe,
    sendPromptResponse,
    leaveSession,
    clearMessages,
    restoreSession,
    currentModel,
    currentEffort,
    sessionProvider,
    setModel,
    setEffort,
    setProvider,
    send: wsSend,
    disconnect: wsDisconnect,
    reconnect: wsReconnect,
    currentPermissionMode,
    setPermissionMode,
    moveToWorktree,
    retryWorktree,
    switchToSharedCheckout,
  } = useChatSocket({
    token: settings.token,
    onSessionCreated: (sessionId) => {
      const pending = pendingCreateDraftRef.current
      pendingCreateDraftRef.current = null
      if (pending?.fromId) {
        const { fromId, before } = pending
        setSessionInputs(prev => {
          const now = prev[fromId] ?? ''
          if (now === before) return prev
          const typed = now.startsWith(before) ? now.slice(before.length).trimStart() : now
          return { ...prev, [fromId]: before, [sessionId]: typed }
        })
      }
      setActiveSessionId(sessionId)
      void refreshSessions()
      const created = draft.takeCreated()
      if (created) {
        // The server holds input until the agent (and any worktree) is ready.
        sendInputRef.current(created.firstMessage)
        rememberPlace(created.place)
        return
      }
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
      if (draft.isAwaitingCreate()) {
        // A draft's create failed: keep the draft, text included, and say why there.
        draft.fail(msg)
        return
      }
      showError(msg)
      if (msg.toLowerCase().includes('not found')) {
        setActiveSessionId(null)
      }
    },
    onRawMessage: (msg) => {
      if (canvasRef.current?.handleMessage(msg)) return
      // Joining (or rejoining after a reconnect) loads the session's Canvas items.
      if (msg.type === 'session_joined') canvasListRef.current()
      if (msg.type === 'diff_result' || msg.type === 'diff_error' || msg.type === 'pr_status' || msg.type === 'review_comments' || msg.type === 'review_error') {
        diffHandleMessageRef.current(msg)
      } else if (msg.type === 'change_summary') {
        if (msg.sessionId === activeSessionId) setChangeSummary({ uncommittedFiles: msg.uncommittedFiles, branchCommits: msg.branchCommits })
      } else if (msg.type === 'result') {
        diffHandleTurnDoneRef.current()
        requestChangeSummaryRef.current()
      } else if (msg.type === 'tool_done') {
        diffHandleToolDoneRef.current(msg.toolName, msg.summary)
        // Track file-mutating tools to show the Changes button right away.
        // Case-insensitive: Claude reports 'Edit'/'Write', OpenCode 'edit'/'write'/'patch'.
        const tool = msg.toolName.toLowerCase()
        if (tool === 'edit' || tool === 'write' || tool === 'patch') {
          setHasFileChanges(true)
        }
        if (tool === 'edit' || tool === 'write' || tool === 'patch' || tool === 'bash') requestChangeSummaryRef.current()
      } else if (msg.type === 'workflow_event') {
        // Server-pushed workflow progress — forwarded so useWorkflows can
        // refresh on events instead of fast-polling.
        emitWorkflowEvent(msg)
      } else if (msg.type === 'connected') {
        // Startup probes: which agent CLIs exist and are signed in on the
        // host. Provider pickers derive availability from this.
        setAgentHealth({
          claudeAvailable: msg.claudeAvailable,
          claudeAuthenticated: msg.apiKeySet,
          claudeVersion: msg.claudeVersion,
          codexAvailable: msg.codexAvailable ?? false,
          codexAuthenticated: msg.codexAuthenticated ?? false,
          openCodeAvailable: msg.openCodeAvailable ?? false,
          grokAvailable: msg.grokAvailable ?? false,
          grokAuthenticated: msg.grokAuthenticated ?? false,
        })
      }
    },
  })

  // Wrap setPermissionMode to update the ref synchronously (avoids 1-render lag from useEffect)
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    permissionModeRef.current = mode
    setPermissionMode(mode)
  }, [setPermissionMode])

  // Provider is per-session; the default for new sessions is a stored pref
  const agentHealth = useAgentHealth()
  const [storedProvider] = useState(() => getPref('provider') ?? null)
  const currentProvider = useMemo(
    () => resolveDefaultProvider(agentHealth, storedProvider),
    [agentHealth, storedProvider],
  )
  const [claudeDisabled, setClaudeDisabled] = useState(false)
  const [openCodeDisabled, setOpenCodeDisabled] = useState(false)
  const [codexDisabled, setCodexDisabled] = useState(false)
  const [grokDisabled, setGrokDisabled] = useState(false)
  // Derive the active session's provider (falls back to the default for new
  // sessions). The orchestrator session is not in the sidebar sessions list,
  // so its provider comes from the session_joined sync — without this the
  // fallback would hand it another provider's model list.
  // A session just created or joined may not be in the list yet; its provider
  // from session_created/session_joined beats the new-session default, which
  // would otherwise sync another harness's model onto it.
  const listedProvider = sessions.find(s => s.id === activeSessionId)?.provider
  // The composer is up on /new, and on the landing page when no session is open.
  const showComposer = view === 'new' || (view === 'chat' && !activeSessionId)
  const draftProvider = draftProviderChoice ?? currentProvider
  const [draftPermissionMode, setDraftPermissionMode] = useDraftPermissionMode(draftProvider)
  const activeSessionProvider = showComposer ? draftProvider : view === 'orchestrator'
    ? sessionProvider ?? 'claude'
    : listedProvider
      ?? (activeSessionId ? sessionProvider : null)
      ?? currentProvider
  // The harness model sync acts on: null while a session is active but its
  // harness is not known yet — right after a reload the session id is restored
  // before the sessions list or session_joined arrive, and acting on the
  // new-session default then would push e.g. a Codex model onto a Claude session.
  const syncProvider: CodingProvider | null = showComposer ? draftProvider : view === 'orchestrator'
    ? sessionProvider
    : activeSessionId && !listedProvider && !sessionProvider ? null : activeSessionProvider

  const activeOpenCodeWd = activeSessionProvider !== 'opencode' ? undefined
    : showComposer ? draftPlace.path
    : sessions.find(s => s.id === activeSessionId)?.workingDir

  const { openCodeModels, openCodeConnected, setOpenCodeConnected, reconnect: reconnectOpenCode } = useOpenCodeModelSync({
    token: settings.token,
    activeSessionProvider: syncProvider,
    activeOpenCodeWd,
    currentModel,
    setModel,
    openCodeDisabled,
  })
  const { codexModels, codexConnected, setCodexConnected, reconnect: reconnectCodex } = useCodexModelSync({
    token: settings.token,
    activeSessionProvider: syncProvider,
    currentModel,
    setModel,
    codexDisabled,
  })
  const { grokModels, grokConnected, setGrokConnected, reconnect: reconnectGrok } = useGrokModelSync({
    token: settings.token,
    activeSessionProvider: syncProvider,
    currentModel,
    setModel,
    grokDisabled,
  })
  const { claudeModels } = useClaudeModelSync({
    token: settings.token,
    currentModel,
    setModel,
  })
  const availableModels = activeSessionProvider === 'opencode' ? openCodeModels
    : activeSessionProvider === 'codex' ? codexModels
    : activeSessionProvider === 'grok' ? grokModels
    : claudeModels

  // Debounced change-summary request for the joined session (cheap git status + commit count).
  const changeSummaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    requestChangeSummaryRef.current = () => {
      if (changeSummaryTimerRef.current) clearTimeout(changeSummaryTimerRef.current)
      changeSummaryTimerRef.current = setTimeout(() => {
        changeSummaryTimerRef.current = null
        wsSend({ type: 'get_change_summary' })
      }, 800)
    }
    return () => { if (changeSummaryTimerRef.current) clearTimeout(changeSummaryTimerRef.current) }
  }, [wsSend])

  // Canvas for the joined session (docs/CANVAS-SPEC.md).
  // Auto-open on an agent's new item: per the setting, never on phones or mid-draft.
  const autoOpenState = useRef({ isMobile, draft: '' })
  useEffect(() => {
    autoOpenState.current = { isMobile, draft: activeSessionId ? sessionInputs[activeSessionId] ?? '' : '' }
  })
  const canvas = useCanvas(activeSessionId, wsSend, {
    shouldAutoOpen: (first) => {
      const mode = getPref('canvasAutoOpen') ?? 'first'
      if (mode === 'never' || autoOpenState.current.isMobile || autoOpenState.current.draft.trim()) return false
      return mode === 'every' || first
    },
  })
  useEffect(() => {
    canvasRef.current = canvas
    canvasListRef.current = () => { wsSend({ type: 'canvas_list' }) }
  })
  const canvasSideBySide = !useIsMobile(CANVAS_SIDE_BY_SIDE_MIN)
  const chatWidthPref = usePref('canvasChatWidth')
  const [chatWidthDrag, setChatWidthDrag] = useState<number | null>(null)
  const chatWidth = chatWidthDrag ?? clampChatWidth(chatWidthPref ?? CANVAS_CHAT_WIDTH.default)
  const [railOverlayOpen, setRailOverlayOpen] = useState(false)
  const startChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const start = chatWidth
    let latest = start
    const onMove = (ev: MouseEvent) => { latest = clampChatWidth(start + ev.clientX - startX); setChatWidthDrag(latest) }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setPref('canvasChatWidth', latest)
      setChatWidthDrag(null)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [chatWidth])

  // Ctrl+C in the composer while the agent works: stop its turn. The next
  // message restarts the agent and resumes the conversation.
  const handleInterrupt = useCallback(() => { wsSend({ type: 'stop' }) }, [wsSend])

  // Reset file-change tracking when switching sessions, then ask what the new one has to review.
  useEffect(() => {
    setHasFileChanges(false) // eslint-disable-line react-hooks/set-state-in-effect -- sync with session change
    setChangeSummary(null)
    if (activeSessionId) requestChangeSummaryRef.current()
  }, [activeSessionId])

  useProviderValidation({ activeSessionProvider: syncProvider, currentModel, setModel, claudeModels })

  const createSessionKeepingDraft = useCallback((...args: Parameters<typeof wsCreateSession>) => {
    pendingCreateDraftRef.current = {
      fromId: activeSessionId,
      before: activeSessionId ? (sessionInputs[activeSessionId] ?? '') : '',
    }
    wsCreateSession(...args)
  }, [activeSessionId, sessionInputs, wsCreateSession])

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
    wsCreateSession: createSessionKeepingDraft,
    closeSession: archiveSession,
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

  // Wrap setModel to also remember the OpenCode / Codex / Grok model choice.
  // A model the user has picked an effort for gets that effort back in the
  // same restart; Codex models otherwise get their advertised default named
  // explicitly, because clearing an override doesn't reset a Codex thread.
  const handleModelChange = useCallback((model: string) => {
    const option = availableModels.find(m => m.id === model)
    const remembered = getPref('modelEfforts')?.[model]
    const effort = !option?.efforts ? undefined
      : remembered && option.efforts.some(e => e.id === remembered) ? remembered
      : option.defaultEffort ?? null
    setModel(model, effort)
    if (activeSessionProvider === 'opencode') {
      setPref('opencodeModel', model)
    } else if (activeSessionProvider === 'codex') {
      setPref('codexModel', model)
    } else if (activeSessionProvider === 'grok') {
      setPref('grokModel', model)
    }
  }, [setModel, activeSessionProvider, availableModels])

  /** Pick an effort level for the session and remember it for its model. */
  const handleEffortChange = useCallback((effort: string | null) => {
    setEffort(effort)
    if (!currentModel) return
    const rest = Object.fromEntries(Object.entries(getPref('modelEfforts') ?? {}).filter(([id]) => id !== currentModel))
    setPref('modelEfforts', effort ? { ...rest, [currentModel]: effort } : rest)
  }, [setEffort, currentModel])

  // Switch the active session's coding provider; refresh the session list so
  // provider-derived UI (model list, permission modes) follows immediately.
  const handleProviderChange = useCallback((provider: CodingProvider, carryContext: boolean) => {
    setProvider(provider, carryContext)
    setPref('provider', provider)
    void refreshSessions()
  }, [setProvider, refreshSessions])

  // --- Draft handlers ---

  // A create can't be confirmed over a dropped connection: hand the draft back.
  useEffect(() => {
    if (connState === 'connected' || !draft.isAwaitingCreate()) return
    draft.fail('The connection dropped before the session started. Try again once it is back.')
  }, [connState, draft])

  /** Open the composer; `preset` picks the place (the sidebar's group +), else the last one used. */
  const openNewSession = useCallback((preset?: DraftPlace) => {
    setDraftPlace(preset ?? defaultPlace(getRecentPlaces()))
    draft.setError(null)
    navigate('/new')
  }, [navigate, draft])

  /** Choose the draft's agent. Its permission mode follows (Skip permissions is Claude-only). */
  const handleDraftProviderChange = useCallback((provider: CodingProvider) => {
    setDraftProviderChoice(provider)
    setPref('provider', provider)
  }, [])

  const handleDraftSend = useCallback((text: string, files: File[]) => {
    const token = settings.token
    if (!token || !draft.begin(text)) return
    // Only pass a model that belongs to the chosen agent's list; the sync may still be catching up.
    const model = currentModel && availableModels.some(m => m.id === currentModel) ? currentModel : null
    startDraftSession({
      place: draftPlace, text, files, provider: draftProvider, model, effort: currentEffort,
      permissionMode: draftPermissionMode, useWorktree,
    }, {
      createScratch: () => createScratch(token),
      cloneRepo: (owner, name) => cloneRepo(token, owner, name),
      orgFolder: (owner) => orgFolder(token, owner),
      uploadAndBuildMessage: (f, t) => uploadAndBuildMessage(token, f, t),
      createSession: (name, workingDir, worktree, mode, provider, explicit, start) => {
        // From here a server error lands in onError, which restores the draft;
        // session_created sends the first message.
        draft.awaitCreated({ firstMessage: start.firstMessage, place: start.place })
        wsCreateSession(name, workingDir, worktree, mode, provider, explicit)
      },
      onProgress: draft.setProgress,
    }).catch((err: unknown) => {
      draft.fail(err instanceof Error ? err.message : String(err))
    })
  }, [settings.token, draft, currentModel, availableModels, draftPlace, draftProvider, currentEffort, draftPermissionMode, useWorktree, wsCreateSession])

  // Attach a place to the open session (phase 3): resolve it to a folder
  // (clone a repo, prepare an org folder) the same way Send does, then attach.
  const handleAttach = useCallback(async (picked: DraftPlace, onProgress: (text: string) => void) => {
    const token = settings.token
    const sessionId = activeSessionId
    if (!token || !sessionId) return
    const machineId = (transport as { machineId?: string }).machineId
    if (isHosted && machineId && await sessionIsShared(machineId, sessionId)
      && !window.confirm('This session is shared. People you shared it with can reach the attached folder through the agent. Attach it?')) return
    const resolved = await resolvePlacePath(picked, {
      createScratch: () => createScratch(token),
      cloneRepo: (owner, name) => cloneRepo(token, owner, name),
      orgFolder: (owner) => orgFolder(token, owner),
      onProgress: (text) => { if (text) onProgress(text) },
    })
    onProgress('Attaching…')
    await attachFolder(token, sessionId, resolved.path)
    await refreshSessions()
  }, [settings.token, activeSessionId, refreshSessions])

  const handleDetach = useCallback(async (path: string) => {
    const token = settings.token
    if (!token || !activeSessionId) return
    await detachFolder(token, activeSessionId, path)
    await refreshSessions()
  }, [settings.token, activeSessionId, refreshSessions])

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
    handleSend: handleSendPlain,
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
    askJoe,
    agentName,
  })

  // Canvas selections attached to the next message, per session (docs/CANVAS-SPEC.md §5).
  const [canvasAttachments, setCanvasAttachments] = useState<Record<string, CanvasAttachment[]>>({})
  const activeAttachments = useMemo(() => (activeSessionId ? canvasAttachments[activeSessionId] ?? [] : []), [canvasAttachments, activeSessionId])
  const handleSendWithFiles = useCallback((text: string) => {
    if (activeSessionId && activeAttachments.length) {
      setCanvasAttachments(prev => ({ ...prev, [activeSessionId]: [] }))
      return handleSendPlain(formatWithContext(text, activeAttachments))
    }
    return handleSendPlain(text)
  }, [activeSessionId, activeAttachments, handleSendPlain])

  // Keep sendInputRef in sync so onSessionCreated can use it
  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])

  // Cmd+K and Cmd+Shift+D listeners
  const togglePalette = useCallback(() => setPaletteOpen(prev => !prev), [])
  const toggleDiffPanel = useCallback(() => setDiffPanelOpen(prev => !prev), [])
  // The session view is up (not settings, tasks, automations, the composer or docs): Canvas can show.
  const showingSession = !!activeSessionId && !showComposer && !docsBrowser.isOpen
    && view !== 'settings' && view !== 'tasks' && view !== 'orchestrator' && view !== 'automations'
    && !(view === 'maintenance' && maintenanceRepo)
  const canvasActive = showingSession && canvas.open
  const canvasBeside = canvasActive && canvasSideBySide
  const canvasReplacesChat = canvasActive && !canvasSideBySide
  // On desktop at any width, open Canvas brings the sidebar rail and the Changes strip.
  const canvasDesktop = canvasActive && !isMobile
  useEffect(() => { if (!canvasDesktop) setRailOverlayOpen(false) }, [canvasDesktop]) // eslint-disable-line react-hooks/set-state-in-effect -- the overlay only exists beside Canvas
  useGlobalKeyBindings({
    onTogglePalette: togglePalette,
    onToggleDiffPanel: toggleDiffPanel,
    onToggleCanvas: showingSession ? canvas.toggle : undefined,
    onCanvasStep: canvasActive ? canvas.step : undefined,
  })

  // Remember the active session for the next visit
  useEffect(() => {
    setPref('activeSessionId', activeSessionId ?? undefined)
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
    // Settings is visited on top of the current session, not instead of it.
    if (view === 'settings') return
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

  // Sync URL on initial load when restoring the remembered session
  useEffect(() => {
    if (activeSessionId && window.location.pathname === '/') {
      navigate(`/s/${activeSessionId}`, true)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore session when returning from idle/background tab. A short absence
  // can't have lost anything: the server never drops an open socket, and the
  // relay only drops a silent one after a missed 30 s heartbeat, which closes
  // it and reconnects anyway. Skipping it matters in the desktop app, where
  // WebKit reports the page hidden whenever the window is covered, and the
  // rejoin rebuilds the whole transcript (losing the reader's scroll position).
  usePageVisibility(hiddenForMs => {
    if (hiddenForMs < SHORT_ABSENCE_MS) return
    restoreSession()
  })

  // First visit without a token: the one thing to do is connect.
  useEffect(() => {
    if (!settings.token && view !== 'settings') navigate('/settings/connection', true)
  }, [settings.token]) // eslint-disable-line react-hooks/exhaustive-deps -- first-run redirect only

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

  // Tasks: delegated work across repos, plus Joe's availability and whether
  // Joe itself waits on the user (answered from its activity log).
  const [taskRepoFilter, setTaskRepoFilter] = useState('')
  // Unfiltered for the sidebar badge; the view's own list follows its repo filter.
  const allJoeTasks = useJoeTasks(settings.token, '', !!settings.token)
  const viewJoeTasks = useJoeTasks(settings.token, taskRepoFilter, !!settings.token && view === 'tasks' && !!taskRepoFilter)
  const joeTasks = taskRepoFilter ? viewJoeTasks : allJoeTasks
  const joeStatus = useJoeStatus(settings.token)
  // The title count, Dock badge (desktop app) and quiet notifications for sessions that need you.
  useAttentionNotifications({ sessions, waitingSessions, activeSessionId, onOpenSession: handleSelectSession })

  const joeWaiting = !!joeStatus.status?.sessionId && waitingSessions[joeStatus.status.sessionId]
  const joeMessageCount = useMemo(() => messages.filter(m => m.type === 'joe').length, [messages])
  const sessionTasks = useSessionTasks(settings.token, view === 'chat' ? activeSessionId : null, joeMessageCount)

  const maintenance = useMaintenance(settings.token)
  const openMaintenance = useCallback((repo: string) => { navigate(maintenancePath(repo)) }, [navigate])
  const changeController = useCallback((action: 'handover' | 'takeback', sessionId: string) => {
    const call = action === 'handover' ? handOverToJoe : takeBackControl
    call(settings.token, sessionId)
      .then(() => refreshSessions())
      .catch((err: unknown) => { showError(err instanceof Error ? err.message : 'Could not change who controls the session') })
  }, [settings.token, refreshSessions, showError])

  const openSessionFromTasks = useCallback((sessionId: string) => {
    clearMessages()
    leaveSession()
    joinSession(sessionId)
    navigate(`/s/${sessionId}`)
  }, [clearMessages, leaveSession, joinSession, navigate])

  // Navigate to Joe's activity log (its own transcript)
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

  // Sync data-theme / data-scheme on <html> whenever the setting changes
  useEffect(() => {
    applyTheme(settings.theme)
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

  const handleToggleGrok = useCallback(() => {
    if (grokDisabled) {
      setGrokDisabled(false)
      reconnectGrok()
    } else {
      setGrokDisabled(true)
      setGrokConnected(false)
      // Leave the current session if it's a Grok session
      if (activeSessionProvider === 'grok' && activeSessionId) {
        leaveSession()
      }
    }
  }, [grokDisabled, activeSessionProvider, activeSessionId, leaveSession, reconnectGrok, setGrokConnected])

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const activeSessionName = activeSession?.name ?? null
  const activeRepoName = activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? null

  // Hosted mode shares the active session from the sidebar footer. The
  // machine id comes from the installed relay transport; empty in local mode,
  // where the Share control is never rendered.
  const [shareSessionId, setShareSessionId] = useState<string | null>(null)
  const shareSession = sessions.find(s => s.id === shareSessionId)
  const hostedMachineId = (transport as { machineId?: string }).machineId ?? ''
  // "Keep this work?" on a scratch session that holds something, between turns (phase 3).
  const keepWorkDismissed = usePref('keepWorkDismissed')
  const activePlace = activeSession?.place
  // Published already still leaves Move to a folder.
  const showKeepThisWork = !!activeSession && activePlace?.kind === 'scratch' && !!activePlace.hasFiles
    && activeSession.source === 'manual' && !isProcessing && messages.some(m => m.type === 'user')
    && !(keepWorkDismissed ?? []).includes(activeSession.id)

  // Attached repositories and org folders Changes can switch to (phase 3).
  const attachedDiffRoots = useMemo(() => (activeSession?.attached ?? [])
    .filter(a => a.place.git || a.place.kind === 'org')
    .map(a => ({ path: a.path, label: sessionPlaceLabel(a.path, a.place) })), [activeSession?.attached])

  // Session input change handler for extracted components
  const handleSessionInputChange = useCallback((sessionId: string, value: string) => {
    setSessionInputs(prev => ({ ...prev, [sessionId]: value }))
  }, [])

  // The agent's latest line, under a Canvas that replaces the chat.
  const lastAgentLine = canvasReplacesChat
    ? [...messages].reverse().find((m): m is Extract<typeof m, { type: 'assistant' }> => m.type === 'assistant')
      ?.text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean)?.slice(0, 200)
    : undefined
  // A Canvas selection: attach it to the next message; "Ask" also brings the composer up.
  const attachCanvasContext = (att: CanvasAttachment, ask: boolean) => {
    if (!activeSessionId) return
    setCanvasAttachments(prev => ({
      ...prev,
      [activeSessionId]: [...(prev[activeSessionId] ?? []).filter(a => !(a.itemId === att.itemId && a.excerpt === att.excerpt)), att],
    }))
    if (ask) {
      if (canvasReplacesChat) canvas.setOpen(false)
      inputBarRef.current?.focus()
    }
  }

  // A file shown in Docs can open in Canvas when it belongs to the session's folder or an attached one.
  const docsCanvasRoot = (() => {
    const dir = docsBrowser.repoWorkingDir
    if (!activeSession || !dir || !docsBrowser.selectedFile || !canvasKindForPath(docsBrowser.selectedFile)) return null
    if (dir === activeSession.workingDir || dir === activeSession.groupDir) return { root: undefined }
    return activeSession.attached?.some(a => a.path === dir) ? { root: dir } : null
  })()

  return (
    <div className="relative flex h-full bg-edge-strong" data-density={isMobile ? 'touch' : undefined}>
      {/* Left sidebar — repo/session tree + nav. Settings is a page of its
          own, so it takes the whole window rather than sitting beside it. */}
      {view !== 'settings' && <LeftSidebar
        sessions={sessions}
        rail={canvasDesktop ? { overlayOpen: railOverlayOpen, onOverlayChange: setRailOverlayOpen } : undefined}
        activeSessionId={activeSessionId}
        activeWorkingDir={activeWorkingDir}
        waitingSessions={waitingSessions}
        tentativeQueues={tentativeQueues}
        globalModules={globalModules}
        activeRepo={activeRepo}
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
        grokConnected={grokConnected}
        grokDisabled={grokDisabled}
        onToggleGrok={handleToggleGrok}
        view={view}
        onSelectSession={(id) => { docsBrowser.close(); if (view === 'orchestrator' || view === 'tasks' || view === 'maintenance') navigate(`/s/${id}`); handleSelectSession(id) }}
        onDeleteSession={handleDeleteSession}
        onRenameSession={renameSession}
        onNewSession={() => { docsBrowser.close(); openNewSession() }}
        onNewSessionInPlace={(place) => { docsBrowser.close(); openNewSession(place) }}
        onSelectRepo={handleSelectRepo}
        onDeleteRepo={handleDeleteRepo}
        onSettingsOpen={() => { openSettings() }}
        onShareSession={isHosted ? setShareSessionId : undefined}
        onUpdateTheme={(theme) => { updateSettings({ theme }) }}
        onSendModule={handleSendModule}
        agentName={agentName}
        taskAttention={attentionCount(allJoeTasks.data?.counts)}
        joeWaiting={joeWaiting}
        onNavigateToAutomations={() => navigate('/automations')}
        onNavigateToTasks={() => { void joeStatus.refresh(); navigate('/tasks') }}
        maintenance={maintenance.byRepo}
        onOpenMaintenance={openMaintenance}
        onHandOver={(id) => { changeController('handover', id) }}
        onTakeBack={(id) => { changeController('takeback', id) }}
        onOpenDrawer={handleOpenDrawer}
        onMoveToWorktree={moveToWorktree}
        mobile={{
          isMobile,
          mobileOpen: mobileMenuOpen,
          onMobileClose: () => setMobileMenuOpen(false),
        }}
      />}

      {/* Main area */}
      <div className="terminal-area flex flex-1 flex-col overflow-hidden bg-page">
        {/* Mobile top bar */}
        {isMobile && view !== 'settings' && !canvasReplacesChat && (
          <MobileTopBar
            repoName={activeRepoName}
            sessionName={activeSessionName}
            onMenuOpen={() => setMobileMenuOpen(true)}
            // Same place as the session in view (a new scratch folder for a scratch session); else the default.
            onNewSession={() => { openNewSession(activeSession ? placeFromSession(activeSession) : undefined) }}
            onSettingsOpen={() => { openSettings() }}
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
        {view === 'settings' ? (
          <SettingsView
            section={settingsSection}
            onNavigate={(section, replace) => { navigate(section ? `/settings/${section}` : '/settings', replace) }}
            onClose={closeSettings}
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
            onDisconnectMachine={onDisconnectMachine}
          />
        ) : view === 'tasks' ? (
          <TasksView
            token={settings.token}
            data={joeTasks.data}
            error={joeTasks.error}
            onChanged={() => { void joeTasks.refresh(); if (joeTasks !== allJoeTasks) void allJoeTasks.refresh() }}
            repos={repos}
            repoFilter={taskRepoFilter}
            onRepoFilterChange={setTaskRepoFilter}
            agentName={agentName}
            joeStatus={joeStatus.status}
            onJoeStatusChanged={() => { void joeStatus.refresh() }}
            joeWaiting={joeWaiting}
            onOpenSession={openSessionFromTasks}
            onOpenJoeLog={() => handleNavigateToOrchestrator()}
            maintenance={maintenance.byRepo}
            onOpenMaintenance={openMaintenance}
          />
        ) : view === 'maintenance' && maintenanceRepo ? (
          <MaintenanceView
            key={maintenanceRepo}
            token={settings.token}
            repo={maintenanceRepo}
            agentName={agentName}
            onBack={() => navigate('/tasks')}
            onOpenTasks={() => { setTaskRepoFilter(maintenanceRepo); navigate('/tasks') }}
            onOpenSession={openSessionFromTasks}
            onOpenAutomations={() => navigate('/automations')}
            onChanged={() => { void maintenance.refresh() }}
          />
        ) : view === 'orchestrator' ? (
          <OrchestratorContent
            token={settings.token}
            onOrchestratorSessionReady={handleOrchestratorSessionReady}
            sessionJoined={!!activeSessionId}
            activeSessionId={activeSessionId}
            messages={messages}
            fontSize={settings.fontSize + (isMobile ? 1 : 0)}
            isMobile={isMobile}
            planningMode={planningMode}
            activityLabel={activityLabel}
            activePrompt={activePrompt}
            sendPromptResponse={sendPromptResponse}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            /* Provider-aware: the orchestrator is agent-agnostic, so the model
               list follows whichever harness it currently runs on. */
            availableModels={availableModels}
            sessionProvider={activeSessionProvider}
            /* Deliberately not handleProviderChange: switching Joe's harness
               must not change the default provider for new sessions. */
            onProviderChange={(provider, carryContext) => {
              setProvider(provider, carryContext)
              void refreshSessions()
              void joeStatus.refresh()
            }}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            disabled={!settings.token}
            agentName={agentName}
            onBackToTasks={() => navigate('/tasks')}
          />
        ) : view === 'automations' ? (
          <AutomationsView
            token={settings.token}
            initialTab={automationsTab ?? undefined}
            onNavigateToSession={(sessionId) => {
              clearMessages()
              leaveSession()
              joinSession(sessionId)
              navigate(`/s/${sessionId}`)
            }}
          />
        ) : showComposer ? (
          <NewSessionComposer
            token={settings.token}
            groups={groups}
            isMobile={isMobile}
            disabled={!settings.token || connState !== 'connected'}
            place={draftPlace}
            onPlaceChange={(p) => { setDraftPlace(p); draft.setError(null) }}
            recent={recentPlacesPref ?? []}
            initialText={draft.text}
            onTextChange={draft.setText}
            resetKey={draft.resetKey}
            provider={draftProvider}
            onProviderChange={handleDraftProviderChange}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            currentEffort={currentEffort}
            onEffortChange={handleEffortChange}
            availableModels={availableModels}
            permissionMode={draftPermissionMode}
            onPermissionModeChange={setDraftPermissionMode}
            useWorktree={useWorktree}
            onWorktreeChange={setUseWorktree}
            progress={draft.progress}
            error={draft.error}
            onSend={handleDraftSend}
          >
            <EnvironmentChecklist
              ghStatus={ghStatus}
              ghError={ghError}
              repoCount={groups.reduce((n, g) => n + g.repos.length, 0)}
              reposLoading={reposLoading}
              reposError={reposError}
            />
          </NewSessionComposer>
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
            onOpenInCanvas={docsCanvasRoot ? () => {
              const file = docsBrowser.selectedFile!
              docsBrowser.close()
              canvas.openFile(file, docsCanvasRoot.root)
            } : undefined}
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
          <div className="flex min-h-0 min-w-0 flex-1">
          {/* The chat: full width, a fixed column beside Canvas, or hidden (still
              mounted, so scroll and the draft survive) while Canvas replaces it. */}
          <div
            className={canvasReplacesChat ? 'hidden' : canvasBeside ? 'relative flex min-h-0 shrink-0 flex-col border-r border-edge' : 'flex min-h-0 min-w-0 flex-1 flex-col'}
            style={canvasBeside ? { width: `clamp(${CANVAS_CHAT_WIDTH.min}px, calc(100vw - 56px - 40px - 640px), ${chatWidth}px)` } : undefined}
          >
          <SessionContent
            activeSessionId={activeSessionId}
            canvasCount={canvas.items.length}
            canvasOpen={canvasActive}
            onOpenCanvas={() => { canvas.setOpen(true) }}
            canvasCards={{
              items: canvas.loaded ? canvas.items : null,
              openItemId: canvasActive ? canvas.selected?.id ?? null : null,
              onOpen: canvas.select,
              onOpenAt: canvas.openAt,
            }}
            onSelectInCanvas={() => { canvas.setOpen(true) }}
            canvasContext={{
              attachments: activeAttachments,
              onRemove: (id) => { setCanvasAttachments(prev => ({ ...prev, [activeSessionId]: (prev[activeSessionId] ?? []).filter(a => a.id !== id) })) },
            }}
            messages={[...messages, ...tentativeMessages]}
            fontSize={settings.fontSize + (isMobile ? 1 : 0)}
            isMobile={isMobile}
            planningMode={planningMode}
            activityLabel={activityLabel}
            tasks={tasks}
            isProcessing={isProcessing}
            disabled={!settings.token}
            hasFileChanges={hasFileChanges}
            changeSummary={changeSummary}
            /* Beside Canvas, the Changes strip on the right edge replaces the button. */
            diffPanelOpen={diffPanelOpen || canvasBeside}
            onOpenDiffPanel={() => setDiffPanelOpen(true)}
            activePrompt={activePrompt}
            promptQueueSize={promptQueueSize}
            sendPromptResponse={sendPromptResponse}
            activeTentativeCount={activeTentativeCount}
            activeRepoName={activeRepo?.name ?? activeWorkingDir?.split('/').pop() ?? 'this repo'}
            place={activeSession?.place}
            placePath={activeSession ? activeSession.groupDir ?? activeSession.workingDir : undefined}
            keepThisWork={showKeepThisWork && activeSession ? (
              <KeepThisWork
                key={activeSession.id}
                place={activeSession.place!}
                folderName={(activeSession.groupDir ?? activeSession.workingDir).split('/').filter(Boolean).pop() ?? 'scratch'}
                owners={groups.filter(g => g.source !== 'local' && !g.error).map(g => g.owner)}
                onGitInit={async () => {
                  await gitInit(settings.token, activeSession.id)
                  await refreshSessions()
                }}
                onPublish={async (choice) => {
                  const { url } = await publishToGitHub(settings.token, activeSession.id, choice)
                  await refreshSessions()
                  return url
                }}
                token={settings.token}
                onMove={async (parent) => {
                  await moveSessionFolder(settings.token, activeSession.id, parent)
                  await refreshSessions()
                }}
                onDismiss={() => { setPref('keepWorkDismissed', [...(keepWorkDismissed ?? []).filter(id => id !== activeSession.id), activeSession.id].slice(-200)) }}
              />
            ) : undefined}
            contextBar={activeSession?.place && activeSession.source === 'manual' && effectiveOwner(activeSession) !== 'joe' ? (
              <ContextBar
                token={settings.token}
                path={activeSession.groupDir ?? activeSession.workingDir}
                place={activeSession.place}
                attached={activeSession.attached ?? []}
                groups={groups}
                recent={recentPlacesPref ?? []}
                isMobile={isMobile}
                disabled={!settings.token}
                onAttach={handleAttach}
                onDetach={handleDetach}
                worktree={activeSession.worktreePath ? { path: activeSession.worktreePath, branch: activeSession.worktreeBranch } : undefined}
                onMoveToWorktree={!activeSession.worktreePath && activeSession.place.git && activeSession.place.kind !== 'org' ? moveToWorktree : undefined}
              />
            ) : undefined}
            onExecuteTentative={() => handleExecuteTentative(activeSessionId)}
            onDiscardTentative={() => handleDiscardTentative(activeSessionId)}
            inputBarRef={inputBarRef}
            onSendInput={handleSendWithFiles}
            onInterrupt={handleInterrupt}
            pendingFiles={pendingFiles}
            onAddFiles={addFiles}
            onRemoveFile={removeFile}
            skillGroups={skillGroups}
            slashCommands={sessionCommands}
            sessionInputs={sessionInputs}
            onSessionInputChange={handleSessionInputChange}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            currentEffort={currentEffort}
            onEffortChange={handleEffortChange}
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
            worktreeState={activeSession?.worktreeState}
            worktreeError={activeSession?.worktreeError}
            onRetryWorktree={retryWorktree}
            onUseExistingCheckout={switchToSharedCheckout}
            openCodeConnected={activeSessionProvider === 'opencode' ? (openCodeDisabled ? false : openCodeConnected) : null}
            codexConnected={activeSessionProvider === 'codex' ? (codexDisabled ? false : codexConnected) : null}
            grokConnected={activeSessionProvider === 'grok' ? (grokDisabled ? false : grokConnected) : null}
            claudeDisabled={activeSessionProvider === 'claude' && claudeDisabled}
            joe={{
              token: settings.token,
              agentName,
              tasks: sessionTasks.tasks,
              onTaskChanged: () => { void sessionTasks.refresh(); void allJoeTasks.refresh() },
              onOpenTasks: () => navigate('/tasks'),
            }}
            controllerOwner={effectiveOwner(activeSession)}
            supervisedTaskTitle={activeSession?.controller?.taskId ? sessionTasks.tasks[activeSession.controller.taskId]?.title : undefined}
            onTakeBackControl={() => { changeController('takeback', activeSessionId) }}
          />
          {canvasBeside && (
            <div
              className="absolute -right-1 top-0 bottom-0 z-20 w-2 cursor-col-resize hover:bg-primary-6/40"
              onMouseDown={startChatResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat"
              title="Drag to resize the chat"
            />
          )}
          </div>
          {canvasActive && (
            <CanvasPanel
              canvas={canvas}
              replacesChat={canvasReplacesChat}
              isMobile={isMobile}
              onBackToChat={() => { canvas.setOpen(false) }}
              lastAgentLine={lastAgentLine}
              onSuggest={(text) => {
                if (canvasReplacesChat) canvas.setOpen(false)
                inputBarRef.current?.insertText(text)
              }}
              onAttach={attachCanvasContext}
              onPointerDown={diffPanelOpen && canvasDesktop ? () => { setDiffPanelOpen(false) } : undefined}
            />
          )}
          </div>
        ) : null}
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
        onNewSessionFromArchive={handleNewSessionFromArchive}
        onResumeSession={(id) => { void refreshSessions(); handleSelectSession(id) }}
        fontSize={settings.fontSize}
        initialTab={drawer?.tab}
        isMobile={isMobile}
      />

      {/* Beside Canvas, Changes is a strip on the right edge and slides over Canvas. */}
      {canvasDesktop && (
        <ChangesStrip
          count={changeSummary?.uncommittedFiles ?? 0}
          open={diffPanelOpen}
          onToggle={toggleDiffPanel}
        />
      )}

      {/* Diff viewer sidebar (a slide-over beside Canvas; the wrapper keeps it mounted across both) */}
      {activeSessionId && (
        <div className={canvasDesktop && diffPanelOpen ? 'absolute inset-y-0 right-10 z-30 flex shadow-floating' : 'contents'}>
        <DiffPanel
          isOpen={diffPanelOpen}
          onClose={() => setDiffPanelOpen(false)}
          send={wsSend}
          onHandleMessage={(fn) => { diffHandleMessageRef.current = fn }}
          onHandleToolDone={(fn) => { diffHandleToolDoneRef.current = fn }}
          onHandleTurnDone={(fn) => { diffHandleTurnDoneRef.current = fn }}
          sessionId={activeSessionId}
          defaultView={activeSession?.worktreePath ? 'branch' : 'all'}
          isMobile={isMobile}
          notRepo={isNotRepoPlace(activeSession?.place)}
          attachedRoots={attachedDiffRoots}
          onInitGit={settings.token && activeSessionId ? async () => {
            await gitInit(settings.token, activeSessionId)
            await refreshSessions()
          } : undefined}
          onOpenInCanvas={(path, root) => {
            setDiffPanelOpen(false)
            canvas.openFile(path, root)
          }}
        />
        </div>
      )}

      {/* Modals */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        repos={repos}
        globalSkills={globalSkills}
        globalModules={globalModules}
        onOpenRepo={handleOpenSession}
        onSendSkill={handleSendSkill}
        onSendModule={handleSendModule}
        onOpenSettings={() => { openSettings() }}
        theme={settings.theme}
        onSelectTheme={(theme) => { updateSettings({ theme }) }}
        isMobile={isMobile}
        docs={paletteDocs}
        onSelectDoc={handleOpenDocFromPalette}
        archivedSessions={paletteArchived}
        onSelectArchived={handleOpenArchivedFromPalette}
        activeWorkingDir={activeWorkingDir}
      />
      {isHosted && shareSession && (
        <Suspense fallback={null}>
          <ShareDialog
            machineId={hostedMachineId}
            sessionId={shareSession.id}
            sessionName={shareSession.name}
            onClose={() => setShareSessionId(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
