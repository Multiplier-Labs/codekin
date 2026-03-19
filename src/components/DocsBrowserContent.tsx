/**
 * DocsBrowserContent — the documentation browser content area with input bar.
 *
 * Extracted from App.tsx to reduce its complexity. Shows the docs browser
 * and an input bar (or placeholder if no session is active).
 */

import type { RefObject } from 'react'
import { DocsBrowser } from './DocsBrowser'
import { InputBar, type InputBarHandle } from './InputBar'
import type { SkillGroup } from './SkillMenu'
import type { SlashCommand } from '../lib/slashCommands'
import type { PermissionMode } from '../types'
import type { PromptEntry } from '../hooks/usePromptState'

export interface DocsBrowserContentProps {
  docsRepoName: string
  filePath: string
  content: string | null
  loading: boolean
  error: string | null
  rawMode: boolean
  isStarred: boolean
  onToggleRaw: () => void
  onToggleStar: () => void
  onClose: () => void
  activeSessionId: string | null
  inputBarRef: RefObject<InputBarHandle | null>
  onSendInput: (text: string, files?: File[]) => void
  activePrompt: PromptEntry | null
  disabled: boolean
  pendingFiles: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  skillGroups: SkillGroup[]
  slashCommands: SlashCommand[]
  sessionInputs: Record<string, string>
  onSessionInputChange: (sessionId: string, value: string) => void
  currentModel: string | null
  onModelChange: (model: string) => void
  isMobile: boolean
  currentPermissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  moveToWorktree: (() => void) | undefined
  worktreePath: string | undefined
}

export function DocsBrowserContent({
  docsRepoName,
  filePath,
  content,
  loading,
  error,
  rawMode,
  isStarred,
  onToggleRaw,
  onToggleStar,
  onClose,
  activeSessionId,
  inputBarRef,
  onSendInput,
  activePrompt,
  disabled,
  pendingFiles,
  onAddFiles,
  onRemoveFile,
  skillGroups,
  slashCommands,
  sessionInputs,
  onSessionInputChange,
  currentModel,
  onModelChange,
  isMobile,
  currentPermissionMode,
  onPermissionModeChange,
  moveToWorktree,
  worktreePath,
}: DocsBrowserContentProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DocsBrowser
        repoName={docsRepoName}
        filePath={filePath}
        content={content}
        loading={loading}
        error={error}
        rawMode={rawMode}
        isStarred={isStarred}
        onToggleRaw={onToggleRaw}
        onToggleStar={onToggleStar}
        onClose={onClose}
      />
      {/* Input bar in docs mode */}
      {activeSessionId ? (
        <InputBar
          key={`docs-${activeSessionId}`}
          ref={inputBarRef}
          onSendInput={onSendInput}
          isWaiting={!!activePrompt}
          disabled={disabled}
          onEscape={onClose}
          pendingFiles={pendingFiles}
          onAddFiles={onAddFiles}
          onRemoveFile={onRemoveFile}
          skillGroups={skillGroups}
          slashCommands={slashCommands}
          placeholder="Ask Claude about this doc, or request changes..."
          initialValue={activeSessionId ? (sessionInputs[activeSessionId] ?? '') : ''}
          onValueChange={(v) => { if (activeSessionId) onSessionInputChange(activeSessionId, v) }}
          currentModel={currentModel}
          onModelChange={onModelChange}
          isMobile={isMobile}
          currentPermissionMode={currentPermissionMode}
          onPermissionModeChange={onPermissionModeChange}
          onMoveToWorktree={moveToWorktree}
          worktreePath={worktreePath}
        />
      ) : (
        <div className="px-4 py-3 border-t border-neutral-10">
          <div className="rounded-lg bg-neutral-11 px-3 py-2 text-[15px] text-neutral-5 opacity-40">
            Start a session to edit this doc
          </div>
        </div>
      )}
    </div>
  )
}
