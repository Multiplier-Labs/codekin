/** Pure formatters for the session token/cost usage indicator in the input bar. */

/** Format a token count compactly: 950 → "950", 12_340 → "12.3k", 2_100_000 → "2.1M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Build the toolbar usage label, e.g. "12.3k tok · $0.042". */
export function formatUsageLabel(usage: { inputTokens: number; outputTokens: number; costUsd?: number }): string {
  const total = usage.inputTokens + usage.outputTokens
  const tok = `${formatTokenCount(total)} tok`
  if (usage.costUsd && usage.costUsd > 0) {
    const cost = usage.costUsd < 1 ? usage.costUsd.toFixed(3) : usage.costUsd.toFixed(2)
    return `${tok} · $${cost}`
  }
  return tok
}
