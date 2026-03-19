/**
 * SessionContent — the active chat session content area.
 *
 * Extracted from App.tsx to reduce its complexity. Renders the ChatView,
 * TodoPanel, diff button, prompt buttons, tentative banner, and input bar
 * for an active session.
 */

import type { RefObject } from 'react'
import { ChatView } from './ChatView'
import { TodoPanel } from './TodoPanel'
import { PromptButtons } from './PromptButtons'
import { TentativeBanner } from './TentativeBanner'
import { InputBar, type InputBarHandle } from './InputBar'
import { IconEye } from '@tabler/icons-react'
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
  disabled: boolean
  hasFileChanges: boolean
  diffPanelOpen: boolean
  onOpenDiffPanel: () => void
  activePrompt: PromptEntry | null
  promptQueueSize: number
  sendPromptResponse: (value: string | string[], requestId?: string) => void
  activeTentativeCount: number
  activeRepoName: string
  onExecuteTentative: () => void
  onDiscardTentative: () => void
  inputBarRef: RefObject<InputBarHandle | null>
  onSendInput: (text: string, files?: File[]) => void
  pendingFiles: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  skillGroups: SkillGroup[]
  slashCommands: SlashCommand[]
  sessionInputs: Record<string, string>
  onSessionInputChange: (sessionId: string, value: string) => void
  currentModel: string | null
  onModelChange: (model: string) => void
  hasUserMessages: boolean
  useWorktree: boolean
  onWorktreeChange: (v: boolean) => void
  currentPermissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  moveToWorktree: (() => void) | undefined
  worktreePath: string | undefined
}

export function SessionContent({
  activeSessionId,
  messages,
  fontSize,
  isMobile,
  planningMode,
  activityLabel,
  tasks,
  disabled,
  hasFileChanges,
  diffPanelOpen,
  onOpenDiffPanel,
  activePrompt,
  promptQueueSize,
  sendPromptResponse,
  activeTentativeCount,
  activeRepoName,
  onExecuteTentative,
  onDiscardTentative,
  inputBarRef,
  onSendInput,
  pendingFiles,
  onAddFiles,
  onRemoveFile,
  skillGroups,
  slashCommands,
  sessionInputs,
  onSessionInputChange,
  currentModel,
  onModelChange,
  hasUserMessages,
  useWorktree,
  onWorktreeChange,
  currentPermissionMode,
  onPermissionModeChange,
  moveToWorktree,
  worktreePath,
}: SessionContentProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ChatView
          messages={messages}
          fontSize={fontSize}
          disabled={disabled}
          planningMode={planningMode}
          activityLabel={activityLabel}
          isMobile={isMobile}
        />
        <TodoPanel tasks={tasks} />

        {/* Diff view button — top-right corner, visible when files have been changed */}
        {hasFileChanges && !diffPanelOpen && (
          <button
            className="absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-lg bg-primary-8 px-3 py-1.5 text-[13px] font-medium text-neutral-1 shadow-lg backdrop-blur-sm transition-colors hover:bg-primary-7"
            onClick={onOpenDiffPanel}
            title="Review code changes (Ctrl+Shift+D)"
          >
            <IconEye size={15} />
            Diff view
          </button>
        )}
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
        isWaiting={!!activePrompt}
        disabled={disabled}
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
        isMobile={isMobile}
        showWorktreeToggle={!hasUserMessages}
        useWorktree={useWorktree}
        onWorktreeChange={onWorktreeChange}
        currentPermissionMode={currentPermissionMode}
        onPermissionModeChange={onPermissionModeChange}
        onMoveToWorktree={moveToWorktree}
        worktreePath={worktreePath}
      />
    </div>
  )
}
