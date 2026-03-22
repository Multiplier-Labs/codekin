/**
 * Native permissions utility for Codekin.
 *
 * Reads/writes `.claude/settings.local.json` in the project directory so that
 * Claude Code's native permission system remembers approvals across sessions
 * without re-prompting.
 *
 * Also converts Codekin's approval registry into `--allowedTools` patterns
 * for passing at spawn time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/** In-process mutex map keyed by repo path to prevent concurrent write races. */
const writeLocks = new Map<string, Promise<void>>()

/** Acquire a per-repo write lock. All sessions share one Node process. */
function withLock(repoDir: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeLocks.get(repoDir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(repoDir, next)
  // Clean up the reference once done so we don't leak memory
  void next.then(() => {
    if (writeLocks.get(repoDir) === next) writeLocks.delete(repoDir)
  })
  return next
}

interface SettingsLocal {
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
  [key: string]: unknown
}

function settingsPath(repoDir: string): string {
  return join(repoDir, '.claude', 'settings.local.json')
}

/** Read existing native permissions from `.claude/settings.local.json`. */
export function readNativePermissions(repoDir: string): string[] {
  const filePath = settingsPath(repoDir)
  if (!existsSync(filePath)) return []
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as SettingsLocal
    return data.permissions?.allow ?? []
  } catch {
    return []
  }
}

/** Add a native permission to `.claude/settings.local.json` (append-only, atomic write). */
export async function addNativePermission(repoDir: string, permission: string): Promise<void> {
  await withLock(repoDir, async () => {
    const filePath = settingsPath(repoDir)
    const dir = join(repoDir, '.claude')

    let settings: SettingsLocal = {}
    if (existsSync(filePath)) {
      try {
        settings = JSON.parse(readFileSync(filePath, 'utf-8')) as SettingsLocal
      } catch {
        // Corrupted file — start fresh but preserve structure
      }
    }

    if (!settings.permissions) settings.permissions = {}
    if (!settings.permissions.allow) settings.permissions.allow = []

    // Don't add duplicates
    if (settings.permissions.allow.includes(permission)) return

    settings.permissions.allow.push(permission)

    mkdirSync(dir, { recursive: true })
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, filePath)
    console.log(`[native-permissions] added "${permission}" to ${filePath}`)
  })
}

/** Remove a native permission from `.claude/settings.local.json`. */
export async function removeNativePermission(repoDir: string, permission: string): Promise<void> {
  await withLock(repoDir, async () => {
    const filePath = settingsPath(repoDir)
    if (!existsSync(filePath)) return

    let settings: SettingsLocal = {}
    try {
      settings = JSON.parse(readFileSync(filePath, 'utf-8')) as SettingsLocal
    } catch {
      return
    }

    const allow = settings.permissions?.allow
    if (!allow) return

    const idx = allow.indexOf(permission)
    if (idx === -1) return

    allow.splice(idx, 1)

    const tmp = filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, filePath)
    console.log(`[native-permissions] removed "${permission}" from ${filePath}`)
  })
}

/**
 * Convert a tool invocation to Claude Code's native permission format.
 *
 * Examples:
 * - Bash + `{ command: "npm run build" }` → `"Bash(npm run build)"`
 * - WebFetch (any input) → `"WebFetch"`
 * - Read (file tool, pre-approved) → `null`
 */
export function toNativePermission(toolName: string, toolInput: Record<string, unknown>): string | null {
  // File tools are pre-approved by permission mode — no need to persist
  const preApproved = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'])
  if (preApproved.has(toolName)) return null

  if (toolName === 'Bash') {
    const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()
    if (!cmd) return null
    return `Bash(${cmd})`
  }

  return toolName
}

/**
 * Escape parentheses and backslashes in a string for use inside a
 * `Bash(...)` allowedTools pattern.  The Claude CLI's `--allowedTools`
 * parser splits on commas/spaces but tracks a single level of `(…)`.
 * Unescaped `)` inside the command prematurely closes the pattern,
 * corrupting the entire allowedTools list and breaking tool resolution
 * (manifests as "A.split is not a function" errors on unrelated tools).
 */
function escapeForAllowedTools(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Convert Codekin's approval registry into `--allowedTools` patterns.
 *
 * Only includes tool names and wildcard patterns — NOT exact commands.
 * Exact commands accumulate over time (hundreds of multi-line scripts)
 * and when included in `--allowedTools` they create an argument so large
 * and complex that it breaks the CLI's parser (manifests as "A.split is
 * not a function" errors on unrelated tools like Agent and TodoWrite).
 * Exact commands are still auto-approved at runtime via the approval hook.
 *
 * Translations:
 * - Pattern `"git diff *"` → `"Bash(git diff:*)"`
 * - Tool `"WebFetch"` → `"WebFetch"`
 */
export function toAllowedToolsPatterns(approvals: { tools: string[]; commands: string[]; patterns: string[] }): string[] {
  const result: string[] = []

  for (const tool of approvals.tools) {
    result.push(tool)
  }

  // Exact commands are intentionally excluded from --allowedTools.
  // They are handled by the auto-approval hook at prompt time instead.

  for (const pattern of approvals.patterns) {
    // Convert "prefix *" → "Bash(prefix:*)"
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2)
      result.push(`Bash(${escapeForAllowedTools(prefix)}:*)`)
    } else {
      result.push(`Bash(${escapeForAllowedTools(pattern)})`)
    }
  }

  return result
}
