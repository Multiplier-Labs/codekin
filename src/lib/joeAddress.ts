/**
 * Addressing Agent Joe from a session composer: a leading `@Joe` (or the
 * configured agent name) sends the message to Joe instead of the coding agent.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addressPattern(agentName: string): RegExp {
  const names = [...new Set(['Joe', agentName].filter(Boolean))].map(escapeRegExp).join('|')
  return new RegExp(`^\\s*@(?:${names})(?![\\w-])[,:]?\\s*`, 'i')
}

/** Whether the composer text is addressed to Joe. */
export function isAddressedToJoe(text: string, agentName = 'Joe'): boolean {
  return addressPattern(agentName).test(text)
}

/** The message for Joe without its address, or null when not addressed to Joe. */
export function parseJoeAddress(text: string, agentName = 'Joe'): string | null {
  const match = addressPattern(agentName).exec(text)
  if (!match) return null
  return text.slice(match[0].length).trim()
}
