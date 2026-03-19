/**
 * ShepherdContent — the shepherd (Joe) view content area.
 *
 * Extracted from App.tsx to reduce its complexity. Renders the ShepherdView
 * header and, once a shepherd session is joined, the chat UI with input bar.
 */

import type { RefObject } from 'react'
import { ShepherdView } from './ShepherdView'
import { ChatView } from './ChatView'
import { TodoPanel } from './TodoPanel'
import { PromptButtons } from './PromptButtons'
import { InputBar, type InputBarHandle } from './InputBar'
import type { SkillGroup } from './SkillMenu'
import type { SlashCommand } from '../lib/slashCommands'
import type { ChatMessage, PermissionMode, TaskItem } from '../types'
import type { PromptEntry } from '../hooks/usePromptState'

export interface ShepherdContentProps {
  token: string
  onShepherdSessionReady: (sessionId: string) => void
  sessionJoined: boolean
  activeSessionId: string | null
  messages: ChatMessage[]
  fontSize: number
  isMobile: boolean
  planningMode: boolean
  activityLabel?: string
  tasks: TaskItem[]
  activePrompt: PromptEntry | null
  sendPromptResponse: (value: string | string[], requestId?: string) => void
  inputBarRef: RefObject<InputBarHandle | null>
  onSendInput: (text: string, files?: File[]) => void
  pendingFiles: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  skillGroups: SkillGroup[]
  slashCommands: SlashCommand[]
  currentModel: string | null
  onModelChange: (model: string) => void
  currentPermissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  disabled: boolean
}

export function ShepherdContent({
  token,
  onShepherdSessionReady,
  sessionJoined,
  activeSessionId,
  messages,
  fontSize,
  isMobile,
  planningMode,
  activityLabel,
  tasks,
  activePrompt,
  sendPromptResponse,
  inputBarRef,
  onSendInput,
  pendingFiles,
  onAddFiles,
  onRemoveFile,
  skillGroups,
  slashCommands,
  currentModel,
  onModelChange,
  currentPermissionMode,
  onPermissionModeChange,
  disabled,
}: ShepherdContentProps) {
  return (
    <>
      <ShepherdView
        token={token}
        onShepherdSessionReady={onShepherdSessionReady}
        sessionJoined={sessionJoined}
      />
      {/* Render chat UI once shepherd session is joined */}
      {activeSessionId && (
        <div className="flex flex-1 flex-col overflow-hidden min-h-0">
          <div className="relative flex-1 min-h-0 flex flex-col">
            <ChatView
              messages={messages}
              fontSize={fontSize}
              disabled={disabled}
              planningMode={planningMode}
              activityLabel={activityLabel}
              isMobile={isMobile}
              variant="joe"
            />
            <TodoPanel tasks={tasks} />
          </div>
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
          <InputBar
            key={`shepherd-${activeSessionId}`}
            variant="joe"
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
            placeholder="Talk to Joe..."
            initialValue=""
            onValueChange={() => {}}
            currentModel={currentModel}
            onModelChange={onModelChange}
            isMobile={isMobile}
            currentPermissionMode={currentPermissionMode}
            onPermissionModeChange={onPermissionModeChange}
          />
        </div>
      )}
    </>
  )
}
