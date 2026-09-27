/**
 * Minimal reader for the flat custom-property blocks the theme CSS is made
 * of. Used by the palette generator and the theme tests — not a general CSS
 * parser: it assumes the block it is asked for contains no nested braces.
 */

/** Body of the first rule whose selector list is exactly `selector`. */
export function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`No CSS block for selector: ${selector}`)
  return match[2]
}

/** Custom properties declared in a block, comments stripped. */
export function parseVars(block: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
  return vars
}

/** Follow `var(--x)` references through `scopes` (first match wins). */
export function resolveVar(name: string, scopes: Record<string, string>[]): string {
  for (let depth = 0; depth < 10; depth++) {
    const value = scopes.find(s => name in s)?.[name]
    if (value === undefined) throw new Error(`Unresolved CSS variable: ${name}`)
    const ref = /^var\((--[\w-]+)\)$/.exec(value)
    if (!ref) return value
    name = ref[1]
  }
  throw new Error(`Variable reference cycle at ${name}`)
}
