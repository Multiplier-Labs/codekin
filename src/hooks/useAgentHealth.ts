/** React binding for the agent-health store (src/lib/agentHealth). */

import { useSyncExternalStore } from 'react'
import { getAgentHealth, subscribeAgentHealth, type AgentHealth } from '../lib/agentHealth'

export function useAgentHealth(): AgentHealth | null {
  return useSyncExternalStore(subscribeAgentHealth, getAgentHealth, getAgentHealth)
}
