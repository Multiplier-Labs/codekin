/**
 * SessionContent — the active chat session content area.
 *
 * Extracted from App.tsx to reduce its complexity. Renders the ChatView,
 * TodoPanel, diff button, prompt buttons, tentative banner, and input bar
 * for an active session.
 */

import { isNotRepoPlace } from '../lib/places'
import type { ReactNode, RefObject } from 'react'
import { ChatView } from './ChatView'
import { TodoPanel } from './TodoPanel'
import { PromptButtons } from './PromptButtons'
import { TentativeBanner } from './TentativeBanner'
import { WorktreeRecoveryBanner } from './WorktreeRecoveryBanner'
import { changesButtonState } from '../lib/changesButton'
import { InputBar, type InputBarHandle } from './InputBar'
import { IconEye, IconFolder, IconLayoutSidebarRight, IconPencil, IconRobotFace } from '@tabler/icons-react'
import type { JoeChatContext } from './JoeChatMessage'
import type { SkillGroup } from './SkillMenu'
import type { SlashCommand } from '../lib/slashCommands'
import type { ChatMessage, PermissionMode, TaskItem } from '../types'
import type { PromptEntry } from '../hooks/usePromptState'

export interface SessionContentProps {
  activeSessionId: string
  messages: ChatMessage[]
  fontSize: number
  isMobile: boolean
  planningMode: boolean
  activityLabel?: string
  tasks: TaskItem[]
  isProcessing: boolean
  disabled: boolean
  hasFileChanges: boolean
  /** What the session has to review, from the server; null until known. */
  changeSummary?: { uncommittedFiles: number; branchCommits: number | null } | null
  diffPanelOpen: boolean
  onOpenDiffPanel: () => void
  /** Canvas items in this session; the Canvas button shows once there are any. */
  canvasCount?: number
  /** Canvas is showing (beside or instead of the chat). */
  canvasOpen?: boolean
  onOpenCanvas?: () => void
  activePrompt: PromptEntry | null
  promptQueueSize: number
  sendPromptResponse: (value: string | string[], requestId?: string) => void
  activeTentativeCount: number
  activeRepoName: string
  /** Where the session runs (absent from older servers). */
  place?: import('../types').SessionPlace
  /** The session's folder, for the place chip. */
  placePath?: string
  /** Where the session works and + Attach (phase 3); absent for sessions that can't attach. */
  contextBar?: ReactNode
  /** The "Keep this work?" callout for a scratch session, when it applies. */
  keepThisWork?: ReactNode
  onExecuteTentative: () => void
  onDiscardTentative: () => void
  inputBarRef: RefObject<InputBarHandle | null>
  onSendInput: (text: string, files?: File[]) => void
  /** Stop the agent's current turn (Ctrl+C in the composer while it works). */
  onInterrupt: () => void
  pendingFiles: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  skillGroups: SkillGroup[]
  slashCommands: SlashCommand[]
  sessionInputs: Record<string, string>
  onSessionInputChange: (sessionId: string, value: string) => void
  currentModel: string | null
  onModelChange: (model: string) => void
  /** Reasoning effort of the session (null = harness default). */
  currentEffort?: string | null
  /** Called when the user picks an effort level (null = harness default). */
  onEffortChange?: (effort: string | null) => void
  availableModels?: import('../types').ModelOption[]
  /** Coding provider of the active session — drives provider-specific UI (permission modes). */
  sessionProvider?: import('../types').CodingProvider
  /** Called when the user switches the session's provider (with carry-context flag). */
  onProviderChange?: (provider: import('../types').CodingProvider, carryContext: boolean) => void
  hasUserMessages: boolean
  useWorktree: boolean
  onWorktreeChange: (v: boolean) => void
  currentPermissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  moveToWorktree: (() => void) | undefined
  worktreePath: string | undefined
  /** Readiness of an isolated session's worktree; failed/missing shows the recovery banner. */
  worktreeState?: 'preparing' | 'ready' | 'failed' | 'missing' | 'removed'
  worktreeError?: string
  onRetryWorktree: () => void
  onUseExistingCheckout: () => void
  /** null = not an OpenCode session, true = connected, false = not connected */
  openCodeConnected: boolean | null
  /** null = not a Codex session, true = connected, false = not connected */
  codexConnected: boolean | null
  /** null = not a Grok session, true = connected, false = not connected */
  grokConnected: boolean | null
  /** Whether Claude Code connection has been disabled by the user. */
  claudeDisabled?: boolean
  /** Agent Joe in this session: attributed messages and live task cards. */
  joe?: JoeChatContext
  /** Who drives execution. While Joe does, ordinary messages pause. */
  controllerOwner?: 'user' | 'joe'
  /** Title of the task Joe supervises this session for. */
  supervisedTaskTitle?: string
  onTakeBackControl?: () => void
}

export function SessionContent({
  activeSessionId,
  messages,
  fontSize,
  isMobile,
  planningMode,
  activityLabel,
  tasks,
  isProcessing,
  disabled,
  hasFileChanges,
  changeSummary,
  diffPanelOpen,
  onOpenDiffPanel,
  canvasCount = 0,
  canvasOpen = false,
  onOpenCanvas,
  activePrompt,
  promptQueueSize,
  sendPromptResponse,
  activeTentativeCount,
  activeRepoName,
  place,
  placePath,
  contextBar,
  keepThisWork,
  onExecuteTentative,
  onDiscardTentative,
  inputBarRef,
  onSendInput,
  onInterrupt,
  pendingFiles,
  onAddFiles,
  onRemoveFile,
  skillGroups,
  slashCommands,
  sessionInputs,
  onSessionInputChange,
  currentModel,
  onModelChange,
  currentEffort,
  onEffortChange,
  availableModels,
  sessionProvider,
  onProviderChange,
  hasUserMessages,
  useWorktree,
  onWorktreeChange,
  currentPermissionMode,
  onPermissionModeChange,
  moveToWorktree,
  worktreePath,
  worktreeState,
  worktreeError,
  onRetryWorktree,
  onUseExistingCheckout,
  openCodeConnected,
  codexConnected,
  grokConnected,
  claudeDisabled,
  joe,
  controllerOwner = 'user',
  supervisedTaskTitle,
  onTakeBackControl,
}: SessionContentProps) {
  const joeName = joe?.agentName ?? 'Joe'
  const joeControls = controllerOwner === 'joe'
  const isOpenCodeDisconnected = openCodeConnected === false
  const isCodexDisconnected = codexConnected === false
  const isGrokDisconnected = grokConnected === false
  const isProviderDisabled = claudeDisabled || isOpenCodeDisconnected || isCodexDisconnected || isGrokDisconnected

  const { show: showChangesButton, count: changesCount, detail: changesDetail } = changesButtonState(hasFileChanges, changeSummary)
  // Older servers send no place; then nothing changes.
  const notRepo = isNotRepoPlace(place)
  const placeLabel = placePath
    ? (place?.kind === 'scratch' ? `scratch/${placePath.replace(/\/+$/, '').split('/').pop() ?? ''}` : placePath.replace(/\/+$/, '').split('/').pop() ?? placePath)
    : activeRepoName
  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      {contextBar}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ChatView
          sessionId={activeSessionId}
          messages={messages}
          fontSize={fontSize}
          disabled={disabled}
          planningMode={planningMode}
          activityLabel={isProviderDisabled ? undefined : activityLabel}
          joe={joe}
          agentName={joeName}
        />
        <TodoPanel tasks={tasks} isProcessing={isProcessing} />

        {/* Claude Code disabled banner */}
        {claudeDisabled && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-page/90">
            <div className="flex flex-col items-center gap-3 text-center px-6 max-w-md">
              <div className="text-body font-medium text-ink">Claude Code is disabled</div>
              <p className="text-body text-ink-muted">
                Re-enable Claude Code from the connection status menu to continue this session.
              </p>
            </div>
          </div>
        )}

        {/* OpenCode not connected banner */}
        {isOpenCodeDisconnected && !claudeDisabled && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-page/90">
            <div className="flex flex-col items-center gap-3 text-center px-6 max-w-md">
              <div className="text-body font-medium text-ink">OpenCode is not connected</div>
              <p className="text-body text-ink-muted">
                Install OpenCode to use this session. Visit{' '}
                <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer" className="text-primary-5 hover:underline">opencode.ai</a>
                {' '}and run <code className="bg-surface-raised px-1.5 py-0.5 rounded-control text-meta">opencode serve</code> to start the server.
              </p>
            </div>
          </div>
        )}

        {/* Codex not connected banner */}
        {isCodexDisconnected && !claudeDisabled && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-page/90">
            <div className="flex flex-col items-center gap-3 text-center px-6 max-w-md">
              <div className="text-body font-medium text-ink">Codex is not connected</div>
              <p className="text-body text-ink-muted">
                Install the Codex CLI with <code className="bg-surface-raised px-1.5 py-0.5 rounded-control text-meta">npm i -g @openai/codex</code>
                {' '}and authenticate by running <code className="bg-surface-raised px-1.5 py-0.5 rounded-control text-meta">codex login</code> on the host.
              </p>
            </div>
          </div>
        )}

        {/* Grok not connected banner */}
        {isGrokDisconnected && !claudeDisabled && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-page/90">
            <div className="flex flex-col items-center gap-3 text-center px-6 max-w-md">
              <div className="text-body font-medium text-ink">Grok is not connected</div>
              <p className="text-body text-ink-muted">
                Install the Grok Build CLI with <code className="bg-surface-raised px-1.5 py-0.5 rounded-control text-meta">curl -fsSL https://x.ai/cli/install.sh | bash</code>
                {' '}and sign in by running <code className="bg-surface-raised px-1.5 py-0.5 rounded-control text-meta">grok login</code> on the host.
              </p>
            </div>
          </div>
        )}

        {/* Changes button — top-right corner, visible whenever the session has
            something to review: uncommitted files, commits on its branch, or
            an edit just made in this browser. */}
        {/* A folder without git has nothing to review: say where the session
            runs instead, and open Changes, which offers to make it a repo. */}
        <div className="absolute top-3 right-3 z-10 flex max-w-[70%] items-center gap-2">
        {/* Canvas: once the session has items, and while Canvas is closed. */}
        {canvasCount > 0 && !canvasOpen && onOpenCanvas && (
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-control border border-edge-strong bg-surface px-2.5 py-1 text-meta font-medium text-ink transition-colors hover:border-focus"
            onClick={onOpenCanvas}
            title={'Open Canvas (⌘\\)'}
          >
            <IconLayoutSidebarRight size={15} stroke={1.75} />
            Canvas
            <span className="rounded-control bg-primary-fill px-1.5 text-micro font-bold tabular-nums text-on-primary-fill">{canvasCount}</span>
          </button>
        )}
        {notRepo && !diffPanelOpen && (
          <button
            className="flex min-w-0 items-center gap-1.5 rounded-control border border-edge-strong bg-surface px-2.5 py-1 text-meta text-ink-muted transition-colors hover:text-ink"
            onClick={onOpenDiffPanel}
            title={`${placePath ?? 'This folder'} is not a git repository — open Changes to initialize git`}
          >
            {place?.kind === 'scratch' ? <IconPencil size={14} stroke={2} className="shrink-0" /> : <IconFolder size={14} stroke={2} className="shrink-0" />}
            <span className="truncate font-mono">{placeLabel}</span>
            <span className="shrink-0 text-ink-muted">· no git</span>
          </button>
        )}
        {showChangesButton && !notRepo && !diffPanelOpen && (
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary backdrop-blur-sm transition-colors hover:bg-primary-7"
            onClick={onOpenDiffPanel}
            title={`Review this session's changes${changesDetail ? ` — ${changesDetail}` : ''} (Ctrl+Shift+D)`}
          >
            <IconEye size={15} />
            Changes
            {changesCount > 0 && <span className="rounded-control bg-on-primary/20 px-1.5 text-micro tabular-nums">{changesCount}</span>}
          </button>
        )}
        </div>
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
        />
      )}
      {promptQueueSize > 1 && (
        <div className="px-3 py-1 text-meta text-ink-muted bg-surface border-t border-edge">
          {promptQueueSize - 1} more pending
        </div>
      )}

      {/* Isolated session whose worktree is unavailable */}
      {(worktreeState === 'failed' || worktreeState === 'missing' || worktreeState === 'removed') && (
        <WorktreeRecoveryBanner
          state={worktreeState}
          error={worktreeError}
          onRetry={onRetryWorktree}
          onUseExistingCheckout={onUseExistingCheckout}
        />
      )}

      {/* One controller per execution: while Joe drives, say so and offer the way back. */}
      {joeControls && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-accent-8/50 bg-surface px-4 py-2 text-meta" role="status">
          <IconRobotFace size={15} stroke={2} className="flex-shrink-0 text-accent-5" />
          <span className="font-medium text-ink">Supervised by Agent {joeName}</span>
          {supervisedTaskTitle && <span className="text-ink-muted">Task: {supervisedTaskTitle}</span>}
          <span className="text-ink-muted">{joeName} is coordinating this execution.</span>
          {onTakeBackControl && (
            <button
              type="button"
              onClick={onTakeBackControl}
              className="ml-auto rounded-control border border-edge px-2.5 py-1 font-medium text-ink hover:border-edge-strong"
            >
              Take back control
            </button>
          )}
        </div>
      )}

      {keepThisWork}

      {/* Tentative banner */}
      {activeTentativeCount > 0 && (
        <TentativeBanner
          count={activeTentativeCount}
          repoName={activeRepoName}
          onExecute={onExecuteTentative}
          onDiscard={onDiscardTentative}
        />
      )}

      {/* Input bar */}
      <InputBar
        key={activeSessionId ?? 'no-session'}
        ref={inputBarRef}
        onSendInput={onSendInput}
        onInterrupt={isProcessing ? onInterrupt : undefined}
        isWaiting={!!activePrompt}
        disabled={disabled || isProviderDisabled}
        placeholder={claudeDisabled ? 'Claude Code is disabled' : isOpenCodeDisconnected ? 'OpenCode is not connected' : isCodexDisconnected ? 'Codex is not connected' : isGrokDisconnected ? 'Grok is not connected' : undefined}
        onEscape={() => {}}
        pendingFiles={pendingFiles}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        skillGroups={skillGroups}
        slashCommands={slashCommands}
        initialValue={sessionInputs[activeSessionId] ?? ''}
        onValueChange={(v) => { onSessionInputChange(activeSessionId, v) }}
        currentModel={currentModel}
        onModelChange={onModelChange}
        currentEffort={currentEffort}
        onEffortChange={onEffortChange}
        availableModels={availableModels}
        sessionProvider={sessionProvider}
        onProviderChange={onProviderChange}
        isMobile={isMobile}
        showWorktreeToggle={!hasUserMessages && !notRepo}
        useWorktree={useWorktree}
        onWorktreeChange={onWorktreeChange}
        currentPermissionMode={currentPermissionMode}
        onPermissionModeChange={onPermissionModeChange}
        onMoveToWorktree={notRepo ? undefined : moveToWorktree}
        worktreePath={worktreePath}
        joeName={joe ? joeName : undefined}
        lockedReason={joeControls ? `${joeName} is coordinating this session — take back control to message the agent.` : undefined}
      />
    </div>
  )
}
