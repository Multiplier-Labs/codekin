/**
 * The WebSocket wire protocol between the Codekin server and its browser
 * clients: every message either side sends, and the types those messages
 * carry (permission modes, providers, diffs, review comments, pull request
 * status, prompts).
 *
 * This is the single definition both sides compile against. The server
 * re-exports it from `server/types.ts`, the frontend from `src/types.ts`.
 * Keep it type-only and dependency-free: no imports, no runtime values, and
 * no enums or namespaces (the frontend builds with `erasableSyntaxOnly`).
 */

/** Permission modes supported by the Claude CLI `--permission-mode` flag. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dangerouslySkipPermissions'

/**
 * Supported AI coding assistant providers.
 * - 'claude': Claude Code CLI (subprocess, NDJSON on stdin/stdout)
 * - 'opencode': OpenCode server (HTTP REST + SSE)
 * - 'codex': OpenAI Codex CLI (subprocess, `codex app-server` JSON-RPC on stdin/stdout)
 * - 'grok': Grok Build CLI (subprocess, `grok agent stdio` ACP JSON-RPC on stdin/stdout)
 */
export type CodingProvider = 'claude' | 'opencode' | 'codex' | 'grok'

/** A tracked task item from Claude's TodoWrite tool. */
export interface TaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous label shown while task is in_progress (e.g. "Running tests"). */
  activeForm?: string
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
  | { type: 'create_session'; name: string; workingDir: string; model?: string; effort?: string; useWorktree?: boolean; permissionMode?: PermissionMode; allowedTools?: string[]; provider?: CodingProvider }
  | { type: 'join_session'; sessionId: string }
  | { type: 'leave_session' }
  | { type: 'start_claude'; options?: Record<string, unknown> }
  | { type: 'set_model'; model: string; effort?: string | null }
  | { type: 'set_effort'; effort: string | null }
  | { type: 'set_provider'; provider: CodingProvider; carryContext?: boolean }
  | { type: 'set_permission_mode'; permissionMode: PermissionMode }
  | { type: 'stop' }
  | { type: 'input'; data: string; displayText?: string }
  /** Address Agent Joe in the joined session instead of its coding agent. */
  | { type: 'ask_joe'; text: string }
  | { type: 'prompt_response'; value: string | string[]; requestId?: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  /** `root`: an attached folder to diff instead of the session's own (phase 3). */
  | { type: 'get_diff'; scope?: DiffView; requestId?: number; root?: string }
  /** Choose the ref branch views compare against (null = automatic), then return the diff for `scope`. */
  | { type: 'set_review_base'; base: string | null; scope: DiffView; requestId?: number }
  /** Look up the pull request for the session's branch (cached ~60s unless refresh). */
  | { type: 'get_pr_status'; requestId?: number; refresh?: boolean }
  /** Cheap check of whether the session has anything to review (drives the Changes button). */
  | { type: 'get_change_summary' }
  // Review comments. `relayUser`/`relayRole` are stamped by the relay connector
  // (never trusted from a remote browser); local clients are the owner.
  | { type: 'review_comments_get'; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_add'; path: string; side: 'new' | 'old'; startLine: number; endLine: number; view: DiffView; baseCommit?: string; headCommit?: string; body: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_update'; id: string; body: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'review_comment_delete'; id: string; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  /** Send drafts (all, or `ids`) to the agent as one prompt; stale ones only with includeStale. */
  | { type: 'review_feedback_send'; ids?: string[]; includeStale?: boolean; relayUser?: string; relayRole?: 'owner' | 'grantee' }
  | { type: 'discard_changes'; scope: DiffScope; paths?: string[]; statuses?: Record<string, DiffFileStatus>; root?: string }
  // Canvas (docs/CANVAS-SPEC.md): items beside the chat, scoped to the joined session.
  | { type: 'canvas_list' }
  /** One item's content at `revision` (the latest when omitted). */
  | { type: 'canvas_get'; itemId: string; revision?: number }
  /** Open a file from the session's folder (or an attached `root`) as an item. */
  | { type: 'canvas_open_file'; path: string; root?: string }
  /** Pin an item at a revision so new ones wait; null unpins. */
  | { type: 'canvas_pin'; itemId: string; revision: number | null }
  | { type: 'canvas_delete'; itemId: string }
  | { type: 'move_to_worktree' }
  | { type: 'retry_worktree' }
  | { type: 'use_existing_checkout' }

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
  | { type: 'connected'; connectionId: string; claudeAvailable: boolean; claudeVersion: string; apiKeySet: boolean; codexAvailable?: boolean; codexAuthenticated?: boolean; openCodeAvailable?: boolean; grokAvailable?: boolean; grokAuthenticated?: boolean }
  | { type: 'session_created'; sessionId: string; sessionName: string; workingDir: string; provider?: CodingProvider; model?: string; effort?: string }
  | { type: 'session_joined'; sessionId: string; sessionName: string; workingDir: string; active: boolean; outputBuffer: WsServerMessage[]; model?: string; effort?: string; provider?: CodingProvider; permissionMode?: PermissionMode; planState?: 'idle' | 'planning' | 'reviewing' }
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
  /** A prompt response went nowhere (prompt settled, agent gone); sent only to the client that answered. */
  | { type: 'prompt_response_dropped'; requestId?: string; reason: string; processing: boolean }
  | { type: 'thinking'; summary: string }
  | { type: 'tool_active'; toolName: string; toolInput?: string }
  | { type: 'tool_done'; toolName: string; summary?: string }
  | { type: 'tool_output'; content: string; isError?: boolean }
  | { type: 'image'; base64: string; mediaType: string }
  | { type: 'system_message'; subtype: 'init' | 'exit' | 'error' | 'restart' | 'notification' | 'info'; text: string; model?: string }
  | { type: 'user_echo'; text: string }
  | {
      /** A message to or from Agent Joe inside a repo session (never sent to the coding agent). */
      type: 'joe_message'
      id: string
      role: 'to_joe' | 'joe'
      text: string
      ts: string
      /** The @Joe request this belongs to. */
      requestId?: string
      /** A task milestone posted back to the originating conversation. */
      milestone?: JoeMilestone
      /** Joe's instruction to the coding agent while Joe controls the session. */
      instruction?: boolean
      /** A system notice about Joe (availability, control changes). */
      notice?: boolean
      task?: JoeMessageTask
    }
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
  | { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; branch: string; scope: DiffView; requestId?: number; sessionId?: string; review?: DiffReview; incomplete?: string[]; root?: string }
  | { type: 'diff_error'; message: string; scope?: DiffView; requestId?: number; sessionId?: string; root?: string }
  | { type: 'pr_status'; status: PrStatus; requestId?: number; sessionId?: string }
  | { type: 'review_comments'; sessionId: string; comments: ReviewComment[] }
  /** How much there is to review: files with uncommitted changes, and commits on the branch since its base (null when unknown). */
  | { type: 'change_summary'; sessionId: string; uncommittedFiles: number; branchCommits: number | null }
  | { type: 'review_error'; message: string; sessionId?: string }
  /** The session's Canvas items; sent on request and broadcast after every change. */
  | { type: 'canvas_items'; sessionId: string; items: CanvasItem[] }
  /** One revision of an item. `content` is UTF-8 text, or base64 for images. */
  | { type: 'canvas_item'; sessionId: string; item: CanvasItem; revision: number; content: string; encoding: 'utf8' | 'base64'; meta?: CanvasItemMeta }
  /** Transcript entry for a new item or revision; renders as a chat card. */
  | { type: 'canvas_event'; sessionId: string; itemId: string; kind: CanvasItemKind; title: string; revision: number; action: 'created' | 'updated'; by?: CanvasItemSource['type'] }
  /** A failed request. `itemId`/`revision` are set when it was a canvas_get for that revision. */
  | { type: 'canvas_error'; message: string; sessionId?: string; itemId?: string; revision?: number }

/** Task milestones Joe posts back into the conversation a task came from. */
export type JoeMilestone = 'accepted' | 'decision' | 'blocked' | 'review'

/** Task snapshot attached to a Joe message (the live task is fetched separately). */
export interface JoeMessageTask {
  id: string
  title: string
  status: string
  prUrl: string | null
  decision: { question: string; recommendation: string | null; options: string[] } | null
}

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

/** What a Canvas item shows (docs/CANVAS-SPEC.md §2). */
export type CanvasItemKind = 'markdown' | 'table' | 'diagram' | 'image' | 'chart' | 'html'

/** Who made a Canvas item. */
export type CanvasItemSource =
  | { type: 'agent' }
  /** Opened by the user from a file; `root` is the attached folder it came from, if any. */
  | { type: 'file'; path: string; root?: string }
  | { type: 'mcp'; server: string }

/** One stored revision of a Canvas item. */
export interface CanvasRevision {
  /** 1-based, increasing. Dropped revisions leave gaps. */
  n: number
  createdAt: string
  /** Content size in bytes. */
  size: number
  mediaType: string
}

/** Kind-specific data stored with a revision. */
export interface CanvasItemMeta {
  /** Diagram node id → what the node refers to. */
  nodes?: Record<string, { file?: string; line?: number; description?: string }>
}

/** A Canvas item: a named, revisioned output beside a session's chat. */
export interface CanvasItem {
  id: string
  kind: CanvasItemKind
  title: string
  source: CanvasItemSource
  /** Oldest first. */
  revisions: CanvasRevision[]
  /** Highest revision number. */
  latest: number
  /** Set while pinned: the view stays here and newer revisions wait. */
  pinnedRevision?: number
  createdAt: string
  updatedAt: string
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
