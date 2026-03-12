/**
 * Unified slash command registry.
 *
 * Three categories of slash commands exist in Claude Code:
 *
 * 1. **Filesystem skills** – defined in ~/.claude/skills/ or .claude/skills/
 *    with SKILL.md files. Content is expanded client-side before sending.
 *
 * 2. **Bundled skills** – prompt-based skills shipped inside Claude Code
 *    (e.g. /commit, /simplify). Sent as regular user messages so Claude's
 *    Skill tool handles them natively.
 *
 * 3. **Built-in commands** – execute fixed CLI logic (/clear, /compact, /model).
 *    Not available via stream-json; Codekin must handle these itself.
 */

import type { Skill } from '../types'

export type SlashCommandCategory = 'skill' | 'bundled' | 'builtin'

export interface SlashCommand {
  command: string
  name: string
  description: string
  category: SlashCommandCategory
  /** For 'skill' category: the expanded SKILL.md content. */
  content?: string
  /** Aliases that also trigger this command (e.g. /reset → /clear). */
  aliases?: string[]
}

// ---------------------------------------------------------------------------
// Built-in commands (CLI-only, handled by Codekin)
// ---------------------------------------------------------------------------

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { command: '/clear', name: 'Clear session', description: 'Clear conversation and start fresh', category: 'builtin', aliases: ['/reset', '/new'] },
  { command: '/compact', name: 'Compact', description: 'Compact conversation to save context', category: 'builtin' },
  { command: '/model', name: 'Model', description: 'Change the active model', category: 'builtin' },
  { command: '/help', name: 'Help', description: 'Show available commands', category: 'builtin' },
  { command: '/cost', name: 'Cost', description: 'Show session cost info', category: 'builtin' },
  { command: '/status', name: 'Status', description: 'Show session status', category: 'builtin' },
]

// Flat lookup of all alias → canonical command mappings.
const BUILTIN_ALIAS_MAP = new Map<string, string>()
for (const cmd of BUILTIN_COMMANDS) {
  BUILTIN_ALIAS_MAP.set(cmd.command, cmd.command)
  for (const alias of cmd.aliases ?? []) {
    BUILTIN_ALIAS_MAP.set(alias, cmd.command)
  }
}

/** Resolve an alias to its canonical built-in command, or undefined. */
export function resolveBuiltinAlias(input: string): string | undefined {
  return BUILTIN_ALIAS_MAP.get(input)
}

// ---------------------------------------------------------------------------
// Bundled skills (prompt-based, shipped inside Claude Code)
// ---------------------------------------------------------------------------

export const BUNDLED_SKILLS: SlashCommand[] = [
  { command: '/commit', name: 'Commit', description: 'Create a git commit', category: 'bundled' },
  { command: '/simplify', name: 'Simplify', description: 'Review and simplify changed code', category: 'bundled' },
  { command: '/loop', name: 'Loop', description: 'Run a command on a recurring interval', category: 'bundled' },
  { command: '/debug', name: 'Debug', description: 'Debug an issue step by step', category: 'bundled' },
  { command: '/claude-api', name: 'Claude API', description: 'Help with Anthropic SDK usage', category: 'bundled' },
]

// ---------------------------------------------------------------------------
// Merge function
// ---------------------------------------------------------------------------

/**
 * Build a unified, de-duplicated list of all slash commands.
 *
 * Priority: filesystem skills > bundled skills > built-in commands.
 * If a filesystem skill has the same command as a bundled skill, the
 * filesystem version wins (it has real content to expand).
 */
export function buildSlashCommandList(allSkills: Skill[]): SlashCommand[] {
  const seen = new Set<string>()
  const result: SlashCommand[] = []

  // 1. Filesystem skills (highest priority)
  for (const skill of allSkills) {
    if (seen.has(skill.command)) continue
    seen.add(skill.command)
    result.push({
      command: skill.command,
      name: skill.name,
      description: skill.description,
      category: 'skill',
      content: skill.content,
    })
  }

  // 2. Bundled skills
  for (const cmd of BUNDLED_SKILLS) {
    if (seen.has(cmd.command)) continue
    seen.add(cmd.command)
    result.push(cmd)
  }

  // 3. Built-in commands (including aliases in the seen-set)
  for (const cmd of BUILTIN_COMMANDS) {
    if (seen.has(cmd.command)) continue
    seen.add(cmd.command)
    for (const alias of cmd.aliases ?? []) seen.add(alias)
    result.push(cmd)
  }

  return result
}
