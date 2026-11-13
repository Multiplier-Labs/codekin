/**
 * Whether a session on this machine is shared with anyone (hosted mode).
 *
 * Attaching a folder widens what the agent can reach, and so what a grantee
 * who may send input can reach through it. Before attaching to a shared
 * session the owner is asked to confirm. Shares live on the relay.
 */

import { workspaceHeaders } from './workspace'

export async function sessionIsShared(machineId: string, sessionId: string): Promise<boolean> {
  const res = await fetch('/api/shares', { credentials: 'include', headers: workspaceHeaders() })
  // Unknown: ask anyway rather than attach silently.
  if (!res.ok) return true
  const data = (await res.json()) as { shared?: Array<{ machineId: string; localSessionId: string }> }
  return (data.shared ?? []).some(s => s.machineId === machineId && s.localSessionId === sessionId)
}
