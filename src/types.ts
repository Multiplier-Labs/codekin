/**
 * Shared type definitions for the Codekin frontend.
 *
 * Covers repo/session models, chat UI message types, and plugin/skill
 * configuration. The WebSocket protocol is re-exported from server/protocol.ts.
 */

import type { ThemeId } from './themes/registry'
import type { CanvasItemKind, CodingProvider, JoeMessageTask, JoeMilestone, PermissionMode, TaskItem } from '../server/protocol'

// The WebSocket wire protocol (messages and the types they carry) is defined
// once in server/protocol.ts and shared with the server; re-exported here so
// frontend code keeps importing it from './types'.
export type {
  PermissionMode, CodingProvider, TaskItem, WsServerMessage, WsClientMessage,
  JoeMilestone, JoeMessageTask,
  DiffScope, DiffView, DiffFileStatus, DiffFile, DiffHunk, DiffLine, DiffSummary, DiffReview,
  ReviewAnchor, ReviewComment,
  CanvasItem, CanvasItemKind, CanvasItemMeta, CanvasItemSource, CanvasRevision,
  PrLookupState, PrChecksSummary, PullRequestInfo, PrStatus,
  PromptOption, PromptQuestion,
} from '../server/protocol'

/** A slash-command skill available in a repo (loaded from .claude/skills/). */
export interface Skill {
  id: string
  name: string
  description: string
  /** The slash-command trigger, e.g. "/validate-gemini". */
  command: string
  /** The full skill prompt content (loaded lazily on selection). */
  content?: string
}

/** A context module that can be attached to a message for extra instructions. */
export interface Module {
  id: string
  name: string
  description: string
  content: string
}

/** A git repository available for Claude sessions. */
export interface Repo {
  id: string
  name: string
  /** Absolute path on the server filesystem. */
  path: string
  /** Working directory used when spawning Claude (usually same as path). */
  workingDir: string
  skills: Skill[]
  modules: Module[]
  tags: string[]
}

/**
 * Provider metadata for the UI selector.
 *
 * `label` is the harness's name wherever a session is listed — the sidebar
 * mark, the composer's agent control, the new-session menu. One spelling
 * everywhere; the precise CLI name lives in `description`.
 */
export const PROVIDERS: { id: CodingProvider; label: string; description: string }[] = [
  { id: 'claude', label: 'Claude', description: 'Anthropic Claude Code CLI' },
  { id: 'opencode', label: 'OpenCode', description: 'OpenCode server (multi-provider)' },
  { id: 'codex', label: 'Codex', description: 'OpenAI Codex CLI (ChatGPT subscription)' },
  { id: 'grok', label: 'Grok', description: 'Grok Build CLI (SpaceXAI)' },
]

/**
 * Harnesses that may run unattended — Agent Joe, its delegated sessions, and
 * workflows.
 * Grok is excluded until its unattended behaviour is verified; keep in sync
 * with AGENT_PROVIDERS in server/types.ts.
 */
export type AgentProvider = Exclude<CodingProvider, 'grok'>
export const AGENT_PROVIDER_IDS: readonly CodingProvider[] = ['claude', 'opencode', 'codex'] satisfies AgentProvider[]

/** One reasoning-effort level a model accepts. */
export interface EffortOption { id: string; description?: string }

/** Model option for UI selectors. */
export interface ModelOption {
  id: string
  label: string
  /** Effort levels the model accepts. Absent = the harness has no effort control. */
  efforts?: EffortOption[]
  /** The level the harness uses when no effort is set, when known. */
  defaultEffort?: string
}

/** Effort levels the Claude CLI accepts via `--effort`. */
export const CLAUDE_EFFORTS: EffortOption[] = [
  { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' },
]

const EFFORT_LABELS: Record<string, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
}

/** Human label for an effort id ('xhigh' → 'Extra high'); unknown ids are title-cased. */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Static models for Claude Code CLI. Used as fallback before dynamic discovery completes. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

/** Permission mode metadata for the UI selector. */
export const PERMISSION_MODES: { id: PermissionMode; label: string; description: string; icon: string; dangerous?: boolean }[] = [
  { id: 'default', label: 'Ask permissions', description: 'Always ask before making changes', icon: 'shield' },
  { id: 'acceptEdits', label: 'Auto accept edits', description: 'Automatically accept all file edits', icon: 'pencil' },
  { id: 'plan', label: 'Plan mode', description: 'Read-only: proposes changes without applying them', icon: 'map' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Accepts all permissions without asking', icon: 'warning', dangerous: true },
  { id: 'dangerouslySkipPermissions', label: 'Skip permissions', description: 'Skips all permission checks entirely — use only in sandboxed environments', icon: 'warning', dangerous: true },
]

/**
 * Grok enforces modes differently from Claude: in ask mode it runs commands
 * it considers safe (mkdir, git status, …) without asking, and its plan mode
 * blocks edits but not shell commands, which Codekin then asks about.
 */
const GROK_MODE_DESCRIPTIONS: Partial<Record<PermissionMode, string>> = {
  default: 'Asks before risky commands and edits; Grok runs commands it considers safe without asking',
  plan: 'Blocks file edits while planning; asks before shell commands',
}

/**
 * Permission modes a provider can honour, with provider-specific wording.
 * Only Claude has a separate --dangerously-skip-permissions flag; for the
 * others bypassPermissions already covers that case.
 */
export function permissionModesFor(provider: CodingProvider | undefined): typeof PERMISSION_MODES {
  if (provider === 'grok') return GROK_PERMISSION_MODES
  return provider === undefined || provider === 'claude' ? PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES
}

// Precomputed so callers get stable references across renders.
const NON_CLAUDE_PERMISSION_MODES = PERMISSION_MODES.filter(m => m.id !== 'dangerouslySkipPermissions')
const GROK_PERMISSION_MODES = NON_CLAUDE_PERMISSION_MODES.map(m => {
  const description = GROK_MODE_DESCRIPTIONS[m.id]
  return description ? { ...m, description } : m
})

/** Execution controller of a session (server/types.ts SessionController). */
export interface SessionController {
  owner: 'user' | 'joe'
  revision: number
  taskId?: string
  since: string
}

/** Client-side session info (subset of server Session, safe to serialize). */
export interface Session {
  id: string
  name: string
  created: string
  /** Whether a Claude CLI process is currently running for this session. */
  active: boolean
  /** Whether Claude is actively processing a user request in this session. */
  isProcessing?: boolean
  workingDir: string
  /** Optional grouping key for the UI (e.g. webhook sessions group under the original repo). */
  groupDir?: string
  /** Absolute path to the git worktree, if this session uses one. */
  worktreePath?: string
  /** 'isolated' sessions only ever run in their own worktree. */
  executionMode?: 'isolated' | 'existing-checkout'
  /** Readiness of an isolated session's worktree. */
  worktreeState?: 'preparing' | 'ready' | 'failed' | 'missing' | 'removed'
  /** Why the worktree is not ready. */
  worktreeError?: string
  /** Branch checked out in the session's worktree. */
  worktreeBranch?: string
  /** Set while the session is archived (stopped, hidden, worktree kept). */
  archivedAt?: string
  /** Who drives execution; unset = Joe for its children, the user otherwise. */
  controller?: SessionController
  connectedClients: number
  lastActivity: string
  /** When a turn last started or finished; unset for sessions that never ran one. */
  lastTurnAt?: string
  /** How the session was created: manually by a user, by a GitHub webhook, or by a workflow. */
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  /** Which AI provider powers this session. Defaults to 'claude'. */
  provider?: CodingProvider
  /** Model pinned to this session, if one was chosen (shown in the sidebar row's tooltip). */
  model?: string
  /** Canvas summary: item count, and whether a pinned item has a newer revision waiting. */
  canvas?: { items: number; pinnedBehind: boolean }
  /** Where the session runs. Derived by the server from the session's root; absent from older servers. */
  place?: SessionPlace
  /** Folders attached beside the session's own (phase 3), each with its place. */
  attached?: AttachedPlace[]
}

/** A folder attached to a running session, beside the folder it runs in. */
export interface AttachedPlace {
  path: string
  place: SessionPlace
}

/** Kind of place a session runs in. Keep in sync with server/places.ts. */
export type PlaceKind = 'scratch' | 'folder' | 'repo' | 'org'

/** Where a session runs: a scratch folder, a plain folder (git or not), or a repository. */
export interface SessionPlace {
  kind: PlaceKind
  /** The folder is in a git work tree: its own, or an enclosing repository's. */
  git: boolean
  /** The enclosing repository's root, when the folder is inside one rather than its root. */
  inRepo?: string
  /** The GitHub owner, for an org place (a folder directly under the repos root). */
  owner?: string
  /** Scratch only: the folder holds something besides `.git`. */
  hasFiles?: boolean
  /** Scratch only: published (its repository has an `origin` remote). */
  remote?: boolean
}

/** Cumulative session token/cost usage reported by the coding process. */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/**
 * UI-level chat message types rendered in ChatView.
 *
 * These are derived from WsServerMessage events by processMessage() / rebuildFromHistory()
 * in useChatSocket. Each variant maps to a distinct visual component in the chat.
 */
export type ChatMessage =
  | { type: 'assistant'; text: string; complete: boolean; ts?: number; key?: string }
  | { type: 'user'; text: string; ts?: number; key?: string }
  | { type: 'system'; subtype: 'init' | 'exit' | 'error' | 'restart' | 'notification' | 'info' | 'trim'; text: string; model?: string; ts?: number; key?: string }
  | { type: 'tool_group'; tools: Array<{ name: string; summary?: string; active: boolean }>; ts?: number; key?: string }
  | { type: 'tool_output'; content: string; isError?: boolean; ts?: number; key?: string }
  | { type: 'image'; base64: string; mediaType: string; ts?: number; key?: string }
  /** A Canvas item was created or revised (from a canvas_event); renders as a chat card. */
  | { type: 'canvas_card'; itemId: string; kind: CanvasItemKind; title: string; revision: number; action: 'created' | 'updated'; ts?: number; key?: string }
  | { type: 'planning_mode'; active: boolean; ts?: number; key?: string }
  | { type: 'todo_list'; tasks: TaskItem[]; ts?: number; key?: string }
  | { type: 'tentative'; text: string; index: number; ts?: number; key?: string }
  | { type: 'joe'; role: 'to_joe' | 'joe'; text: string; requestId?: string; milestone?: JoeMilestone; instruction?: boolean; notice?: boolean; task?: JoeMessageTask; ts?: number; key?: string }

/** WebSocket connection lifecycle state. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

/** App settings: the auth token (localStorage) and display preferences (server prefs). */
export interface Settings {
  token: string
  fontSize: number
  theme: ThemeId
}

/** Docs picker state passed through LeftSidebar → RepoSection. */
export interface DocsPickerProps {
  open?: boolean
  repoDir?: string | null
  files?: { path: string; pinned: boolean }[]
  loading?: boolean
  starredDocs?: string[]
  onSelect?: (filePath: string) => void
  onClose?: () => void
}

/** Mobile layout props for components that support responsive drawer mode. */
export interface MobileProps {
  isMobile?: boolean
  mobileOpen?: boolean
  onMobileClose?: () => void
}
