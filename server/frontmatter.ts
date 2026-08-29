/**
 * Shared frontmatter machinery for recipe files.
 *
 * Both recipe formats — workflow definitions (`server/workflows/*.md`,
 * `{repo}/.codekin/workflows/*.md`) and loop templates (`server/loops/*.md`,
 * `{repo}/.codekin/loops/*.md`) — are markdown files opening with a
 * `--- ... ---` frontmatter block. Historically each loader had its own
 * splitter and its own parser (loops: strict YAML; workflows: a line-based
 * `key: value` scan). This module is the single splitter plus the tolerant
 * flat parser the workflow loader migrates onto.
 *
 * Why the fallback exists: every shipped workflow template writes values like
 * `commitMessage: chore: code review` — a second colon that strict YAML
 * rejects as a parse error. YAML is tried first (so quoted strings, numbers,
 * and future nested fields work); on a parse error the legacy line scan takes
 * over, keeping every existing template valid. Note that in the YAML path a
 * bare `#` starts a comment — values containing `#` must be quoted.
 */

import { parse as parseYaml } from 'yaml'

export interface FrontmatterSplit {
  /** Raw text between the opening and closing `---` fences. */
  frontmatter: string
  /** Everything after the closing fence (untrimmed). */
  body: string
}

/**
 * Split a recipe file into frontmatter and body. The opening fence must be
 * the very first line — a `---` later in the file is content, not frontmatter.
 * Returns null when the file does not open with a frontmatter block.
 */
export function splitFrontmatter(content: string): FrontmatterSplit | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  return { frontmatter: match[1], body: match[2] }
}

/** The legacy line-based scan: `key: value` per line, no nesting, no quoting. */
function scanLegacyLines(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const sep = line.indexOf(': ')
    if (sep === -1) continue
    fields[line.slice(0, sep).trim()] = line.slice(sep + 2).trim()
  }
  return fields
}

/**
 * Parse flat (string-valued) frontmatter: YAML first, legacy line scan when
 * YAML rejects the text. Scalar YAML values are coerced to strings so
 * `maxAgeDays: 30` and `maxAgeDays: "30"` read identically; a nested mapping
 * or list under a key is an authoring error for a flat format and falls back
 * to the legacy scan (which reads such lines as absent).
 */
export function parseFlatFrontmatter(text: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return scanLegacyLines(text)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return scanLegacyLines(text)
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'object') return scanLegacyLines(text)
    fields[key] = String(value).trim()
  }
  return fields
}
