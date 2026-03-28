/** Format a Claude model ID into a human-readable label. */
export function formatModelName(modelId: string): string {
  const m = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/)
  if (m) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return `${name} ${m[2]}.${m[3]}`
  }
  return modelId
}

/**
 * Replace [Attached files: ...] markers with emoji-prefixed file names.
 * Claude CLI emits these markers when files are attached to a prompt.
 * The regex matches both singular and plural forms, extracts the comma-
 * separated paths, strips directories to show only basenames, and
 * prepends a paperclip emoji for a cleaner display in the chat UI.
 */
export function formatUserText(text: string): string {
  return text.replace(
    /\[Attached files?: ([^\]]+)\]/g,
    (_, paths: string) => {
      const names = paths.split(', ').map(p => p.split('/').pop() || p)
      return `\u{1F4CE} ${names.join(', ')}`
    },
  )
}
