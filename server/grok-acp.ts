/**
 * Pure mapping between Grok Build's ACP wire shapes and Codekin's process
 * events. Kept free of I/O so it can be tested against captured fixtures.
 *
 * Shapes verified against grok 1.0.44 (`grok agent --no-leader stdio`); see
 * docs/GROK-BUILD-INTEGRATION-SPEC.md § Spike results.
 */

import type { PermissionMode, SessionUsage, TaskItem } from './types.js'

// ---------------------------------------------------------------------------
// Wire types (subset — only what we consume)
// ---------------------------------------------------------------------------

/** A parsed JSON-RPC 2.0 message from `grok agent stdio`. */
export interface AcpMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

/** Grok's per-tool metadata, carried on `tool_call` and permission requests. */
interface GrokToolMeta {
  name?: string
  kind?: string
  label?: string
  read_only?: boolean
}

/** The fields of a `tool_call` / `tool_call_update` / permission `toolCall` we read. */
export interface AcpToolCall {
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
  content?: unknown
  _meta?: Record<string, unknown>
}

export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind: string
}

// ---------------------------------------------------------------------------
// Tool normalization
// ---------------------------------------------------------------------------

export interface NormalizedTool {
  /** Codekin tool name (Bash, Edit, Write, Read, Grep, …) — matches the approval registry. */
  name: string
  /** Input in the shape Codekin's approval and summary code expects. */
  input: Record<string, unknown>
}

function grokToolMeta(call: AcpToolCall): GrokToolMeta {
  const meta = call._meta?.['x.ai/tool']
  return meta && typeof meta === 'object' ? meta as GrokToolMeta : {}
}

const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined

/**
 * Map a Grok tool call to a Codekin tool name and input.
 *
 * The first `tool_call` carries only the raw tool name (`title`) and
 * `_meta["x.ai/tool"]`; later updates and permission requests carry the ACP
 * `kind` and a `rawInput.variant`. Any of them is enough to classify.
 */
export function normalizeGrokTool(call: AcpToolCall): NormalizedTool {
  const meta = grokToolMeta(call)
  const raw = call.rawInput ?? {}
  const variant = str(raw.variant)
  const kind = call.kind ?? meta.kind
  const grokName = meta.name ?? call.title ?? 'tool'

  const filePath = str(raw.file_path) ?? str(raw.target_file) ?? str(raw.path)

  if (variant === 'Bash' || kind === 'execute') {
    const input: Record<string, unknown> = { command: str(raw.command) ?? '' }
    if (str(raw.description)) input.description = raw.description
    return { name: 'Bash', input }
  }
  if (variant === 'Write' || kind === 'write' || grokName === 'write') {
    return { name: 'Write', input: filePath ? { file_path: filePath } : {} }
  }
  if (variant === 'SearchReplace' || kind === 'edit') {
    const input: Record<string, unknown> = filePath ? { file_path: filePath } : {}
    if (str(raw.old_string) !== undefined) input.old_string = raw.old_string
    if (str(raw.new_string) !== undefined) input.new_string = raw.new_string
    return { name: 'Edit', input }
  }
  if (variant === 'ReadFile' || kind === 'read') {
    return { name: 'Read', input: filePath ? { file_path: filePath } : {} }
  }
  if (kind === 'search') {
    const input: Record<string, unknown> = {}
    if (str(raw.pattern) ?? str(raw.query)) input.pattern = raw.pattern ?? raw.query
    if (filePath) input.path = filePath
    return { name: 'Grep', input }
  }
  if (kind === 'fetch') {
    return { name: 'WebFetch', input: str(raw.url) ? { url: raw.url } : {} }
  }
  // MCP and Grok-specific tools keep Grok's own name; pass the raw input
  // through (minus the variant tag) so the approval prompt can show it.
  const { variant: _variant, ...rest } = raw
  void _variant
  return { name: grokName, input: rest }
}

// ---------------------------------------------------------------------------
// Tool content
// ---------------------------------------------------------------------------

/** Concatenate the text blocks of an ACP tool `content` array. Diffs and other blocks are skipped. */
export function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; content?: { type?: string; text?: unknown } }
    if (b.type === 'content' && b.content?.type === 'text' && typeof b.content.text === 'string') {
      parts.push(b.content.text)
    }
  }
  return parts.join('')
}

/** Changed file paths from an ACP tool `content` array (diff blocks). */
export function toolContentPaths(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((b): b is { type: string; path: string } =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'diff' && typeof (b as { path?: unknown }).path === 'string')
    .map(b => b.path)
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Choose the ACP option that answers a permission request.
 *
 * Grok's `allow_always` options are broader than Codekin's per-pattern
 * “Always allow” (for shell commands it means *every* bash command), so
 * Codekin never selects them: `allow_always` answers `allow_once` and
 * Codekin's own approval registry remembers the pattern.
 */
export function pickPermissionOption(
  options: AcpPermissionOption[],
  behavior: 'allow' | 'deny' | 'allow_always',
): string | null {
  const wantKind = behavior === 'deny' ? 'reject_once' : 'allow_once'
  const exact = options.find(o => o.kind === wantKind)
  if (exact) return exact.optionId
  if (behavior === 'deny') {
    // Never widen scope when allowing; a reject of any scope is still a reject.
    return options.find(o => o.kind.startsWith('reject'))?.optionId ?? null
  }
  return null
}

/** Whether a Codekin permission mode maps to Grok's always-approve (`_meta.yoloMode`). */
export function isYoloMode(mode: PermissionMode | undefined): boolean {
  return mode === 'bypassPermissions' || mode === 'dangerouslySkipPermissions'
}

/** The `_meta` sent on `session/new` / `session/load` for a permission mode. */
export function sessionMetaForMode(mode: PermissionMode | undefined): Record<string, unknown> | undefined {
  return isYoloMode(mode) ? { yoloMode: true } : undefined
}

/** The Grok session mode id (`session/set_mode`) for a Codekin permission mode. */
export function grokModeIdFor(mode: PermissionMode | undefined): 'plan' | 'default' {
  return mode === 'plan' ? 'plan' : 'default'
}

// ---------------------------------------------------------------------------
// Turn results
// ---------------------------------------------------------------------------

/**
 * Map a `session/prompt` stop reason to Codekin's `result` event.
 * `cancelled` covers both a user stop and a denied tool — Grok ends the turn
 * when a permission is rejected — so it is reported as a normal (non-error)
 * end of turn.
 */
export function resultForStopReason(stopReason: unknown): { text: string; isError: boolean } {
  switch (stopReason) {
    case 'end_turn':
    case 'cancelled':
      return { text: '', isError: false }
    case 'max_tokens':
      return { text: 'Grok stopped: the response hit the output token limit.', isError: true }
    case 'max_turn_requests':
      return { text: 'Grok stopped: the turn hit its tool-call limit.', isError: true }
    case 'refusal':
      return { text: 'Grok declined to continue this request.', isError: true }
    default:
      return { text: typeof stopReason === 'string' ? `Grok stopped: ${stopReason}` : '', isError: typeof stopReason === 'string' }
  }
}

/** 1 USD = 10^10 cost ticks in Grok's usage reports. */
const USD_TICKS = 1e10

/** Extract per-turn usage from a `session/prompt` result's `_meta.usage`, if present. */
export function usageFromPromptResult(result: unknown): SessionUsage | null {
  const usage = (result as { _meta?: { usage?: Record<string, unknown> } } | null)?._meta?.usage
  if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return null
  const out: SessionUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  if (typeof usage.costUsdTicks === 'number') out.costUsd = usage.costUsdTicks / USD_TICKS
  return out
}

// ---------------------------------------------------------------------------
// Plans and models
// ---------------------------------------------------------------------------

/** Map ACP `plan` entries to Codekin tasks. */
export function planEntriesToTasks(entries: unknown): TaskItem[] | null {
  if (!Array.isArray(entries)) return null
  const tasks: TaskItem[] = []
  entries.forEach((e, i) => {
    const entry = e as { content?: unknown; status?: unknown }
    if (typeof entry?.content !== 'string') return
    const status = entry.status === 'in_progress' ? 'in_progress' : entry.status === 'completed' ? 'completed' : 'pending'
    tasks.push({ id: String(i + 1), subject: entry.content, status })
  })
  return tasks
}

export interface GrokModelInfo {
  id: string
  name: string
  description: string
  isDefault: boolean
  contextTokens?: number
}

/**
 * Read the model list from an ACP `models` state object — the shape found in
 * `initialize`'s `_meta.modelState` and in the `session/new` response.
 */
export function modelsFromState(state: unknown): GrokModelInfo[] {
  const s = state as { currentModelId?: unknown; availableModels?: unknown } | null
  if (!s || !Array.isArray(s.availableModels)) return []
  const current = typeof s.currentModelId === 'string' ? s.currentModelId : undefined
  const models: GrokModelInfo[] = []
  for (const m of s.availableModels) {
    const model = m as { modelId?: unknown; name?: unknown; description?: unknown; _meta?: { totalContextTokens?: unknown } }
    if (typeof model?.modelId !== 'string') continue
    models.push({
      id: model.modelId,
      name: typeof model.name === 'string' ? model.name : model.modelId,
      description: typeof model.description === 'string' ? model.description : '',
      isDefault: model.modelId === current,
      ...(typeof model._meta?.totalContextTokens === 'number' ? { contextTokens: model._meta.totalContextTokens } : {}),
    })
  }
  return models
}

/** Short first-sentence summary of streamed reasoning (same rule as the Codex/OpenCode adapters). */
export function summarizeThought(text: string): string {
  const match = text.match(/^(.+?[.!?\n])/)
  return match && match[1].length <= 120
    ? match[1].replace(/\n/g, ' ').trim()
    : text.slice(0, 80).trim()
}
