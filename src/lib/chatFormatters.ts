/** Format a Claude model ID into a human-readable label. */
export function formatModelName(modelId: string): string {
  const m = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/)
  if (m) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return `${name} ${m[2]}.${m[3]}`
  }
  return modelId
}

/** Replace [Attached files: ...] markers with emoji-prefixed file names. */
export function formatUserText(text: string): string {
  return text.replace(
    /\[Attached files?: ([^\]]+)\]/g,
    (_, paths: string) => {
      const names = paths.split(', ').map(p => p.split('/').pop() || p)
      return `\u{1F4CE} ${names.join(', ')}`
    },
  )
}
