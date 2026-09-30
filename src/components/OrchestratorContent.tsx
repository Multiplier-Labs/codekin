/**
 * OrchestratorContent — Agent Joe's activity log.
 *
 * Joe no longer has a chat of its own: users address it from repo sessions
 * (@Joe) and follow delegated work in Tasks
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §2). This view keeps Joe's
 * transcript as history, lets the user answer Joe's own approval prompts, and
 * holds Joe's agent settings (harness, model, permissions). There is no
 * composer.
 */

import { OrchestratorView } from './OrchestratorView'
import { ChatView } from './ChatView'
import { PromptButtons } from './PromptButtons'
import type { ChatMessage, CodingProvider, ModelOption, PermissionMode } from '../types'
import { PROVIDERS, permissionModesFor } from '../types'
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
  activePrompt: PromptEntry | null
  sendPromptResponse: (value: string | string[], requestId?: string) => void
  currentModel: string | null
  onModelChange: (model: string) => void
  /** Models for the orchestrator's current harness — Joe is agent-agnostic. */
  availableModels?: ModelOption[]
  sessionProvider?: CodingProvider
  onProviderChange?: (provider: CodingProvider, carryContext: boolean) => void
  currentPermissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  disabled: boolean
  agentName?: string
  onBackToTasks?: () => void
}

const selectClass = 'rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink focus:border-focus focus:outline-none'

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
  activePrompt,
  sendPromptResponse,
  currentModel,
  onModelChange,
  availableModels = [],
  sessionProvider,
  onProviderChange,
  currentPermissionMode,
  onPermissionModeChange,
  disabled,
  agentName,
  onBackToTasks,
}: OrchestratorContentProps) {
  const modes = permissionModesFor(sessionProvider)

  return (
    <>
      <OrchestratorView
        token={token}
        onOrchestratorSessionReady={onOrchestratorSessionReady}
        sessionJoined={sessionJoined}
        agentName={agentName}
        onBackToTasks={onBackToTasks}
      />
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
              agentName={agentName}
            />
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
            />
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-edge bg-surface px-4 py-2 text-meta text-ink-muted" aria-label={`Agent ${agentName ?? 'Joe'} settings`}>
            <span>Talk to {agentName ?? 'Joe'} from any repo session with @{agentName ?? 'Joe'}.</span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {sessionProvider && onProviderChange && (
                <label className="flex items-center gap-1.5">
                  Agent
                  <select
                    aria-label="Harness"
                    value={sessionProvider}
                    disabled={disabled}
                    onChange={e => { onProviderChange(e.target.value as CodingProvider, false) }}
                    className={selectClass}
                  >
                    {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>
              )}
              {availableModels.length > 0 && (
                <select
                  aria-label="Model"
                  value={currentModel ?? ''}
                  disabled={disabled}
                  onChange={e => { onModelChange(e.target.value) }}
                  className={selectClass}
                >
                  {!currentModel && <option value="">Default model</option>}
                  {currentModel && !availableModels.some(m => m.id === currentModel) && <option value={currentModel}>{currentModel}</option>}
                  {availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              )}
              <label className="flex items-center gap-1.5">
                Permissions
                <select
                  aria-label="Permission mode"
                  value={currentPermissionMode}
                  disabled={disabled}
                  onChange={e => { onPermissionModeChange(e.target.value as PermissionMode) }}
                  className={selectClass}
                >
                  {modes.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            </span>
          </div>
        </div>
      )}
    </>
  )
}
