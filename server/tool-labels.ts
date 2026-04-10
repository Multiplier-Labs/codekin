/**
 * Shared utility for generating human-readable tool input summaries.
 *
 * Used by both ClaudeProcess and OpenCodeProcess to produce UI chip labels
 * for tool invocations.
 */

/** Generate a short human-readable summary of a tool invocation for the UI chip. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // Normalize tool name to handle OpenCode's lowercase naming
  switch (toolName.toLowerCase()) {
    case 'bash': {
      const cmd = String(input.command || '')
      const firstLine = cmd.split('\n')[0]
      return firstLine.length < cmd.length ? `$ ${firstLine}...` : `$ ${cmd}`
    }
    case 'read':
    case 'view':
      return String(input.file_path || input.filePath || '')
    case 'write':
    case 'edit':
    case 'multiedit':
      return String(input.file_path || input.filePath || '')
    case 'glob':
      return String(input.pattern || '')
    case 'grep':
      return String(input.pattern || '')
    case 'task':
      return String(input.description || '')
    case 'enterplanmode':
      return 'Entering plan mode'
    case 'exitplanmode':
      return 'Exiting plan mode'
    case 'taskcreate':
      return String(input.subject || '')
    case 'taskupdate':
      return `#${input.taskId || ''} → ${input.status || ''}`
    case 'tasklist':
      return 'Listing tasks'
    case 'taskget':
      return `#${input.taskId || ''}`
    case 'todowrite': {
      const todos = input.todos as Array<Record<string, unknown>> | undefined
      return todos ? `${todos.length} tasks` : ''
    }
    case 'todoread':
      return 'Reading tasks'
    default:
      return ''
  }
}
