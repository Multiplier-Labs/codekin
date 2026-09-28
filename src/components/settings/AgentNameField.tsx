/**
 * Agent name (machine setting): the orchestrator's display name, saved to the
 * connected machine on blur or Enter.
 */

import { IconRobot } from '@tabler/icons-react'
import { setAgentName as setAgentNameApi } from '../../lib/ccApi'

interface Props {
  token: string
  agentName: string
  onAgentNameChange?: (name: string) => void
  onError: (message: string) => void
}

export function AgentNameField({ token, agentName, onAgentNameChange, onError }: Props) {
  return (
    <div>
      <label className="mb-1.5 block text-body text-ink-muted">
        <span className="flex items-center gap-1.5">
          <IconRobot size={14} className="text-ink-muted" />
          Agent Name
        </span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={agentName}
          onChange={e => {
            const val = e.target.value
            onAgentNameChange?.(val)
          }}
          onBlur={e => {
            const val = e.target.value.trim()
            if (val && val !== agentName) {
              setAgentNameApi(token, val).then(saved => onAgentNameChange?.(saved)).catch(() => onError('Failed to save agent name'))
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const val = (e.target as HTMLInputElement).value.trim()
              if (val) {
                setAgentNameApi(token, val).then(saved => onAgentNameChange?.(saved)).catch(() => onError('Failed to save agent name'))
              }
            }
          }}
          placeholder="Joe"
          maxLength={30}
          className="w-40 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
        />
      </div>
      <p className="mt-1 text-body text-ink-muted">Display name for the orchestrator agent in the sidebar and chat</p>
    </div>
  )
}
