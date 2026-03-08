import type { ChatMessage } from '../types'

/**
 * Derives a human-readable activity label from the current chat state.
 *
 * Priority order:
 *  1. "Writing..." — assistant message is still streaming
 *  2. "Running <tool>..." — a tool call is in progress
 *  3. "Thinking: <summary>" — extended thinking with a summary
 *  4. "Thinking..." — processing but no specific status yet
 *  5. undefined — idle, no activity to display
 */
export function deriveActivityLabel(messages: ChatMessage[], isProcessing: boolean, thinkingSummary?: string | null): string | undefined {
  // Check for incomplete assistant (streaming text)
  const last = messages[messages.length - 1]
  if (last && last.type === 'assistant' && !last.complete) return 'Writing...'
  // Check for active tool
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'tool_group') {
      const active = m.tools.find(t => t.active)
      if (active) return `Running ${active.name}...`
      break
    }
    if (m.type !== 'planning_mode' && m.type !== 'tool_output') break
  }
  // Fallback: turn still in progress but between content blocks
  if (isProcessing) {
    if (thinkingSummary) return `Thinking: ${thinkingSummary}`
    return 'Thinking...'
  }
  return undefined
}
