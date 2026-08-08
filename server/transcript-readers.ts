/**
 * Transcript readers for session handoff.
 *
 * Locates harness-native session transcripts on disk (Claude Code, Codex) and
 * condenses them into a plain-text extract suitable for distillation into a
 * handoff document — user/assistant messages plus tool-call titles, recency
 * weighted. Readers never write foreign formats; the raw transcript path is
 * kept as a lossless escape hatch for the target agent.
 *
 * See docs/SESSION-HANDOFF-SPEC.md.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CodingProvider } from './coding-process.js'
import { jsonParse } from './json-parse.js'

/** Parse one JSONL line into a record, or null on malformed input. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = jsonParse(line)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Max chars of a single user/assistant message kept in the extract. */
const MESSAGE_CAP = 2000
/** Max chars of a tool call / tool result line kept in the extract. */
const TOOL_CAP = 200

/** One entry of a condensed transcript, in conversation order. */
interface Entry {
  text: string
}

/** Claude Code slugifies the cwd into a project directory name. */
export function claudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Locate the on-disk transcript for a session's harness-native session ID.
 * Returns null when the harness has no known transcript layout (opencode,
 * Phase 2) or the file cannot be found.
 */
export function findTranscript(provider: CodingProvider, workingDir: string, sessionId: string): string | null {
  if (!sessionId) return null
  if (provider === 'claude') {
    const path = join(homedir(), '.claude', 'projects', claudeProjectSlug(workingDir), `${sessionId}.jsonl`)
    return existsSync(path) ? path : null
  }
  if (provider === 'codex') {
    return findCodexRollout(sessionId)
  }
  return null
}

/**
 * Codex stores rollouts as sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl.
 * Walk day directories newest-first and match on the thread id suffix.
 */
function findCodexRollout(threadId: string, root = join(homedir(), '.codex', 'sessions')): string | null {
  const suffix = `${threadId}.jsonl`
  const dirsDesc = (p: string): string[] => {
    try {
      return readdirSync(p)
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => b.localeCompare(a))
        .map((n) => join(p, n))
    } catch {
      return []
    }
  }
  for (const year of dirsDesc(root)) {
    for (const month of dirsDesc(year)) {
      for (const day of dirsDesc(month)) {
        try {
          const hit = readdirSync(day).find((f) => f.endsWith(suffix))
          if (hit) return join(day, hit)
        } catch {
          /* unreadable day dir — keep scanning */
        }
      }
    }
  }
  return null
}

/** Exported for tests: locate a Codex rollout under a custom root. */
export const _findCodexRollout = findCodexRollout

/**
 * Read a transcript and condense it to plain text within `budgetChars`.
 * Keeps the first user message (the goal) plus as many of the most recent
 * entries as fit. Returns null when the file is unreadable or yields nothing.
 */
export function readCondensed(path: string, provider: CodingProvider, budgetChars: number): string | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const entries = provider === 'codex' ? parseCodexLines(raw) : parseClaudeLines(raw)
  if (entries.length === 0) return null
  return packEntries(entries, budgetChars)
}

/** Keep first entry + most recent entries within budget, in original order. */
function packEntries(entries: Entry[], budgetChars: number): string {
  const first = entries[0]
  let used = first.text.length
  const tail: string[] = []
  for (let i = entries.length - 1; i >= 1; i--) {
    const cost = entries[i].text.length + 1
    if (used + cost > budgetChars) break
    used += cost
    tail.unshift(entries[i].text)
  }
  const dropped = entries.length - 1 - tail.length
  const parts = [first.text]
  if (dropped > 0) parts.push(`[... ${dropped} earlier entries omitted ...]`)
  return parts.concat(tail).join('\n')
}

function cap(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}...` : t
}

/** Codex injects wrapper context as user/developer messages — not conversation. */
const CODEX_WRAPPER_PREFIXES = ['<environment_context>', '<user_instructions>', '<permissions', '<apps_instructions>', '<turn_context>']

function isCodexWrapper(text: string): boolean {
  const t = text.trimStart()
  return CODEX_WRAPPER_PREFIXES.some((p) => t.startsWith(p))
}

/**
 * Codex rollout JSONL: {type: 'response_item', payload: {...}} lines carry the
 * canonical conversation; event_msg lines duplicate them and are skipped.
 */
function parseCodexLines(raw: string): Entry[] {
  const entries: Entry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const obj = parseLine(line)
    if (!obj || obj.type !== 'response_item') continue
    const p = obj.payload as Record<string, unknown> | undefined
    if (!p) continue
    if (p.type === 'message') {
      const role = p.role as string
      if (role !== 'user' && role !== 'assistant') continue
      const content = Array.isArray(p.content) ? (p.content as Array<Record<string, unknown>>) : []
      const text = content
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('\n')
        .trim()
      if (!text || (role === 'user' && isCodexWrapper(text))) continue
      entries.push({ text: `${role === 'user' ? 'User' : 'Assistant'}: ${cap(text, MESSAGE_CAP)}` })
    } else if (p.type === 'function_call') {
      const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? '')
      const name = typeof p.name === 'string' ? p.name : 'unknown'
      entries.push({ text: `[Tool: ${name} ${cap(args, TOOL_CAP)}]` })
    } else if (p.type === 'function_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      if (out) entries.push({ text: `[Tool result: ${cap(out, TOOL_CAP)}]` })
    }
  }
  return entries
}

/** Compact hint for a Claude tool_use input: the most descriptive field. */
function toolInputHint(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['description', 'command', 'file_path', 'pattern', 'prompt', 'url']) {
    const v = o[key]
    if (typeof v === 'string' && v) return cap(v, 150)
  }
  return ''
}

/**
 * Claude Code session JSONL: {type: 'user'|'assistant', message: {role, content}}
 * lines carry the conversation; content is a string or an array of typed blocks
 * (text / tool_use / tool_result / thinking).
 */
function parseClaudeLines(raw: string): Entry[] {
  const entries: Entry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const obj = parseLine(line)
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) continue
    if (obj.isMeta) continue
    const message = obj.message as Record<string, unknown> | undefined
    if (!message) continue
    const role = message.role as string
    const content = message.content
    if (typeof content === 'string') {
      const text = content.trim()
      if (text) entries.push({ text: `${role === 'user' ? 'User' : 'Assistant'}: ${cap(text, MESSAGE_CAP)}` })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        entries.push({ text: `${role === 'user' ? 'User' : 'Assistant'}: ${cap(block.text, MESSAGE_CAP)}` })
      } else if (block.type === 'tool_use') {
        const hint = toolInputHint(block.input)
        const name = typeof block.name === 'string' ? block.name : 'unknown'
        entries.push({ text: `[Tool: ${name}${hint ? ` ${hint}` : ''}]` })
      } else if (block.type === 'tool_result') {
        const inner = block.content
        const text =
          typeof inner === 'string'
            ? inner
            : Array.isArray(inner)
              ? (inner as Array<Record<string, unknown>>)
                  .map((b) => (typeof b.text === 'string' ? b.text : ''))
                  .join(' ')
              : ''
        if (text.trim()) entries.push({ text: `[Tool result: ${cap(text, TOOL_CAP)}]` })
      }
      // thinking blocks are internal — never carried across a handoff
    }
  }
  return entries
}
