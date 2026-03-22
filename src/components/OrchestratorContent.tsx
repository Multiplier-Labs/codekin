/**
 * OrchestratorContent — the orchestrator view content area.
 *
 * Extracted from App.tsx to reduce its complexity. Renders the OrchestratorView
 * header and, once an orchestrator session is joined, the chat UI with input bar.
 */

import type { RefObject } from 'react'
import { OrchestratorView } from './OrchestratorView'
import { ChatView } from './ChatView'
import { TodoPanel } from './TodoPanel'
import { PromptButtons } from './PromptButtons'
import { InputBar, type InputBarHandle } from './InputBar'
import type { SkillGroup } from './SkillMenu'
import type { SlashCommand } from '../lib/slashCommands'
import type { ChatMessage, PermissionMode, TaskItem } from '../types'
import type { PromptEntry } from '../hooks/usePromptState'

export interface OrchestratorContentProps {
  token: string
  onOrchestratorSessionReady: (sessionId: string) => void
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
  agentName?: string
}

export function OrchestratorContent({
  token,
  onOrchestratorSessionReady,
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
  agentName,
}: OrchestratorContentProps) {
  return (
    <>
      <OrchestratorView
        token={token}
        onOrchestratorSessionReady={onOrchestratorSessionReady}
        sessionJoined={sessionJoined}
        agentName={agentName}
      />
      {/* Render chat UI once orchestrator session is joined */}
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
              variant="orchestrator"
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
            key={`orchestrator-${activeSessionId}`}
            variant="orchestrator"
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
            placeholder="Talk to the orchestrator..."
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
