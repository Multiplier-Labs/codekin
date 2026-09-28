/**
 * Agent name (machine setting): the orchestrator's display name, saved to the
 * connected machine on blur or Enter.
 */

import { setAgentName as setAgentNameApi } from '../../lib/ccApi'
import { Row, input } from './Block'

interface Props {
  token: string
  agentName: string
  onAgentNameChange?: (name: string) => void
  onError: (message: string) => void
}

export function AgentNameField({ token, agentName, onAgentNameChange, onError }: Props) {
  // Enter always saves; blur only when the value differs.
  const save = (value: string, always: boolean) => {
    const val = value.trim()
    if (val && (always || val !== agentName)) {
      setAgentNameApi(token, val).then(saved => onAgentNameChange?.(saved)).catch(() => { onError('Failed to save agent name'); })
    }
  }
  return (
    <Row
      label="Agent name"
      htmlFor="settings-agent-name"
      description="What the orchestrator agent is called in the sidebar and in chat."
      control={
        <input
          id="settings-agent-name"
          type="text"
          value={agentName}
          onChange={e => { onAgentNameChange?.(e.target.value) }}
          onBlur={e => { save(e.target.value, false) }}
          onKeyDown={e => { if (e.key === 'Enter') save((e.target as HTMLInputElement).value, true) }}
          placeholder="Joe"
          maxLength={30}
          className={`${input} w-40`}
        />
      }
    />
  )
}
