/**
 * Shared type definitions for the Codekin frontend.
 *
 * Covers repo/session models, WebSocket protocol messages (client↔server),
 * chat UI message types, and plugin/skill configuration.
 */

import type { ThemeId } from './themes/registry'

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
 * Permission modes supported by the Claude CLI `--permission-mode` flag.
 * Controls how tool permissions are handled during a session.
 * Keep in sync with server/types.ts PermissionMode.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dangerouslySkipPermissions'

/**
 * Supported AI coding assistant providers.
 * - 'claude': Claude Code CLI (subprocess, NDJSON on stdin/stdout)
 * - 'opencode': OpenCode server (HTTP REST + SSE)
 * - 'codex': OpenAI Codex CLI (subprocess, `codex app-server` JSON-RPC on stdin/stdout)
 */
export type CodingProvider = 'claude' | 'opencode' | 'codex'

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
]

/** Model option for UI selectors. */
export interface ModelOption { id: string; label: string }

/** Static models for Claude Code CLI. Used as fallback before dynamic discovery completes. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
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
  connectedClients: number
  lastActivity: string
  /** How the session was created: manually by a user, by a GitHub webhook, or by a workflow. */
  source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  /** Which AI provider powers this session. Defaults to 'claude'. */
  provider?: CodingProvider
  /** Model pinned to this session, if one was chosen (shown in the sidebar row's tooltip). */
  model?: string
}

/**
 * Messages sent from the browser client to the WebSocket server.
 *
 * Each variant maps to an action the user or UI can trigger.
 *
 * Typical message flow:
 *   auth → create_session | join_session → start_claude → input* → stop
 *
 * - `auth` must be sent first; the server drops the connection on failure.
 * - `create_session` and `join_session` are mutually exclusive session entry points.
 * - `input` sends user text to Claude; `prompt_response` answers a permission/question prompt.
 * - `ping` is a keepalive; the server replies with `pong`.
 * - `get_diff` / `discard_changes` are REST-over-WebSocket for the diff viewer.
 */
export type WsClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'create_session'; name: string; workingDir: string; model?: string; useWorktree?: boolean; permissionMode?: PermissionMode; allowedTools?: string[]; provider?: CodingProvider }
  | { type: 'join_session'; sessionId: string }
  | { type: 'leave_session' }
  | { type: 'start_claude'; options?: Record<string, unknown> }
  | { type: 'set_model'; model: string }
  | { type: 'set_provider'; provider: CodingProvider; carryContext?: boolean }
  | { type: 'set_permission_mode'; permissionMode: PermissionMode }
  | { type: 'stop' }
  | { type: 'input'; data: string; displayText?: string }
  | { type: 'prompt_response'; value: string | string[]; requestId?: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'get_diff'; scope?: DiffView; requestId?: number }
  /** Choose the ref branch views compare against (null = automatic), then return the diff for `scope`. */
  | { type: 'set_review_base'; base: string | null; scope: DiffView; requestId?: number }
  /** Look up the pull request for the session's branch (cached ~60s unless refresh). */
  | { type: 'get_pr_status'; requestId?: number; refresh?: boolean }
  // Review comments. `relayUser`/`relayRole` are stamped by the relay connector
  // (never trusted from a remote browser); local clients are the owner.
  | { type: 'review_comments_get'; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_add'; path: string; side: 'new' | 'old'; startLine: number; endLine: number; view: DiffView; baseCommit?: string; headCommit?: string; body: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_update'; id: string; body: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_delete'; id: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  /** Send drafts (all, or `ids`) to the agent as one prompt; stale ones only with includeStale. */
  | { type: 'review_feedback_send'; ids?: string[]; includeStale?: boolean; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'discard_changes'; scope: DiffScope; paths?: string[]; statuses?: Record<string, DiffFileStatus> }
  | { type: 'move_to_worktree' }
  | { type: 'retry_worktree' }
  | { type: 'use_existing_checkout' }

/** A tracked task item from Claude's TodoWrite tool. */
export interface TaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous label shown while task is in_progress (e.g. "Running tests"). */
  activeForm?: string
}

/** Cumulative session token/cost usage reported by the coding process. */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

/**
 * Messages sent from the WebSocket server to the browser client.
 *
 * These drive the entire chat UI: streaming text, tool activity indicators,
 * prompt dialogs, session lifecycle events, and background webhook notifications.
 *
 * Canonical message sequence for a typical turn:
 *   connected → session_joined → claude_started
 *     → [output* → tool_active → tool_done]* → result → exit
 *
 * Paired messages:
 * - `tool_active` / `tool_done` always bracket a single tool invocation.
 * - `prompt` / `prompt_dismiss` bracket a permission or question dialog.
 * - `planning_mode { active: true }` / `planning_mode { active: false }` bracket plan mode.
 *
 * Lifecycle events (`session_created`, `session_joined`, `session_left`, `session_deleted`,
 * `claude_started`, `claude_stopped`, `sessions_updated`) can arrive at any point.
 * `webhook_event` and `workflow_event` are broadcast to all clients, not session-scoped.
 */
export type WsServerMessage =
  | { type: 'connected'; connectionId: string; claudeAvailable: boolean; claudeVersion: string; apiKeySet: boolean; codexAvailable?: boolean; codexAuthenticated?: boolean; openCodeAvailable?: boolean }
  | { type: 'session_created'; sessionId: string; sessionName: string; workingDir: string }
  | { type: 'session_joined'; sessionId: string; sessionName: string; workingDir: string; active: boolean; outputBuffer: WsServerMessage[]; model?: string; provider?: CodingProvider; permissionMode?: PermissionMode; planState?: 'idle' | 'planning' | 'reviewing' }
  | { type: 'session_left' }
  | { type: 'session_deleted'; message: string }
  | { type: 'claude_started'; sessionId: string }
  | { type: 'claude_stopped' }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string }
  | { type: 'pong' }
  | { type: 'prompt'; promptType: 'permission' | 'question'; question: string; options: PromptOption[]; multiSelect?: boolean; toolName?: string; toolInput?: Record<string, unknown>; requestId?: string; sessionId?: string; sessionName?: string; questions?: PromptQuestion[]; approvePattern?: string }
  | { type: 'prompt_dismiss'; requestId?: string }
  | { type: 'thinking'; summary: string }
  | { type: 'tool_active'; toolName: string; toolInput?: string }
  | { type: 'tool_done'; toolName: string; summary?: string }
  | { type: 'tool_output'; content: string; isError?: boolean }
  | { type: 'image'; base64: string; mediaType: string }
  | { type: 'system_message'; subtype: 'init' | 'exit' | 'error' | 'restart' | 'notification' | 'info'; text: string; model?: string }
  | { type: 'user_echo'; text: string }
  | { type: 'result' }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'planning_mode'; active: boolean }
  | { type: 'permission_mode_changed'; permissionMode: PermissionMode }
  | { type: 'todo_update'; tasks: TaskItem[] }
  | { type: 'session_name_update'; sessionId: string; name: string }
  | { type: 'webhook_event'; event: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; sessionId?: string }
  | { type: 'workflow_event'; eventType: string; runId: string; kind: string; stepKey?: string; status?: string; payload?: unknown; engine?: 'workflow' | 'loop' | 'agent' }
  | { type: 'worktree_created'; worktreePath: string; workingDir: string }
  | { type: 'sessions_updated' }
  | { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; branch: string; scope: DiffView; requestId?: number; sessionId?: string; review?: DiffReview; incomplete?: string[] }
  | { type: 'diff_error'; message: string; scope?: DiffView; requestId?: number; sessionId?: string }
  | { type: 'pr_status'; status: PrStatus; requestId?: number; sessionId?: string }
  | { type: 'review_comments'; sessionId: string; comments: ReviewComment[] }
  | { type: 'review_error'; message: string; sessionId?: string }

// --- Diff viewer types ---

/** Uncommitted scopes: what discard operates on. */
export type DiffScope = 'staged' | 'unstaged' | 'all'

/**
 * What the Changes panel shows. The uncommitted scopes plus two read-only
 * branch views measured from the merge base with the review base:
 * 'branch' (all task changes: committed + uncommitted + untracked) and
 * 'committed' (merge base → HEAD).
 */
export type DiffView = DiffScope | 'branch' | 'committed'

/** Where a review comment points, captured when it was written. */
export interface ReviewAnchor {
  path: string
  /** 'new' = lines as they are now; 'old' = removed lines, from the base. */
  side: 'new' | 'old'
  startLine: number
  endLine: number
  /** Changes-panel view the lines were selected in. */
  view: DiffView
  /** Content the line numbers refer to. */
  source: 'worktree' | 'index' | 'commit'
  commit?: string
  /** The selected lines, read by the server. */
  excerpt: string[]
  fingerprint: string
}

/** A reviewer's comment on selected lines; drafts are sent to the agent in one batch. */
export interface ReviewComment {
  id: string
  body: string
  anchor: ReviewAnchor
  status: 'draft' | 'sent'
  /** Relay user id of the author, or 'owner' for the machine owner. */
  author: string
  authorRole: 'owner' | 'grantee'
  createdAt: string
  updatedAt?: string
  sentAt?: string
  /** Computed when listed: the anchored lines have changed in the working tree. */
  stale?: boolean
}

/** Outcome of a pull request lookup; everything except 'found' and 'none' means "unknown". */
export type PrLookupState = 'found' | 'none' | 'no_github_remote' | 'gh_missing' | 'unauthenticated' | 'rate_limited' | 'error'

/** CI checks on a pull request's remote head. */
export interface PrChecksSummary {
  total: number
  passed: number
  failed: number
  pending: number
  skipped: number
  /** Names of (up to five) failing checks. */
  failing: string[]
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  baseRefName: string
  headRefName: string
  /** Commit GitHub's checks ran on. */
  headRefOid: string
  /** The head lives in a fork; its base is in another repository. */
  isCrossRepository: boolean
  headOwner?: string
  updatedAt: string
  reviewDecision?: string
  checks: PrChecksSummary
  /** Local commits not on the PR head (not pushed); null when that head is not fetched locally. */
  ahead: number | null
  /** PR head commits missing locally; null when unknown. */
  behind: number | null
}

/** Pull request status for a session's branch. */
export interface PrStatus {
  state: PrLookupState
  message?: string
  branch?: string
  /** Open first, then most recently updated. */
  pulls: PullRequestInfo[]
  /** The working tree has edits no check has seen. */
  dirty: boolean
  fetchedAt: string
  /** Set when a refresh failed and the last good result is shown instead. */
  staleReason?: string
}

/** How a branch view was computed. */
export interface DiffReview {
  /** Ref the branch is compared against, e.g. 'main' or 'origin/main'. */
  baseRef: string
  /** Why this base: the user's choice, the branch's open pull request, the ref the worktree was created from, or the repo default. */
  baseSource: 'user' | 'pr' | 'worktree' | 'default'
  /** Merge-base commit the diff starts from. */
  mergeBase: string
  /** HEAD commit the diff was computed at. */
  head: string
  /** Refs the user can choose as the base. */
  candidates: string[]
}
export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface DiffFile {
  path: string
  status: DiffFileStatus
  oldPath?: string
  isBinary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** Branch view only: the file also has uncommitted changes (staged, unstaged or untracked). */
  uncommitted?: boolean
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

export interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  truncated: boolean
  truncationReason?: string
  /** Branch view only: how many listed files have uncommitted changes. */
  uncommittedFiles?: number
}

/** A selectable option in a permission or question prompt dialog. */
export interface PromptOption {
  label: string
  value: string
  description?: string
}

/** A single question in a multi-question AskUserQuestion prompt. */
export interface PromptQuestion {
  question: string
  header?: string
  options: PromptOption[]
  multiSelect: boolean
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
  | { type: 'planning_mode'; active: boolean; ts?: number; key?: string }
  | { type: 'todo_list'; tasks: TaskItem[]; ts?: number; key?: string }
  | { type: 'tentative'; text: string; index: number; ts?: number; key?: string }

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
