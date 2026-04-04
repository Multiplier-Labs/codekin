# Claude Code Stream-JSON Protocol

How Codekin spawns and communicates with Claude Code CLI sessions over the stream-json protocol.

## Spawning

```bash
claude \
  --output-format stream-json \
  --input-format stream-json \
  --permission-mode bypassPermissions \
  --allowedTools "Bash(git:*)" \
  --include-partial-messages \
  --verbose \
  --session-id <UUID> \
  --append-system-prompt "..."
```

**No `-p` flag.** The `-p` (print) flag enables single-shot mode which bypasses all permission checks — no `control_request` events are ever generated. Without `-p`, the stream-json protocol handles multi-turn conversation and permission requests properly.

### Flag Reference

| Flag | Purpose |
|------|---------|
| `--output-format stream-json` | Emit events as newline-delimited JSON on stdout |
| `--input-format stream-json` | Accept structured JSON messages on stdin |
| `--permission-mode bypassPermissions` | Auto-approve all tools (Write, Edit, Bash, etc.) |
| `--allowedTools "Bash(git:*)"` | Whitelist specific tool patterns (here: git commands in Bash) |
| `--include-partial-messages` | Emit streaming deltas for real-time UI |
| `--verbose` | Enable diagnostic output |
| `--session-id <UUID>` | Reuse session context across process restarts |
| `--append-system-prompt` | Add instructions to the system prompt |

### Environment Variables

The spawned process receives these env vars for hook communication:

| Variable | Purpose |
|----------|---------|
| `CODEKIN_SESSION_ID` | The Hub session ID (for hook HTTP callbacks) |
| `CODEKIN_PORT` | The WebSocket server port (default `32352`) |
| `CODEKIN_TOKEN` | Auth token for the tool-approval endpoint |
| `CODEKIN_AUTH_TOKEN` | Auth token for the PermissionRequest hook (same value as TOKEN) |
| `CODEKIN_SESSION_TYPE` | Session source: `manual` or `webhook` (used by hook routing) |
| `ANTHROPIC_API_KEY` | Passed through from the server environment |

### Permission Modes

| Mode | Write/Edit | Bash | Other |
|------|-----------|------|-------|
| `default` | **Denied silently** (no control_request) | Denied silently | Auto-approved |
| `acceptEdits` | Auto-approved | Generates `control_request` | Auto-approved |
| `bypassPermissions` | Auto-approved | Auto-approved | Auto-approved |
| `plan` | Planning tools only | — | — |
| `dangerouslySkipPermissions` | Auto-approved (no hooks) | Auto-approved (no hooks) | Auto-approved (no hooks) |

**Current mode:** `acceptEdits` — Write/Edit are auto-approved, Bash commands trigger the `PermissionRequest` hook (configured in `.claude/settings.local.json`). The hook routes to the server's `/api/hook-decision` endpoint, which prompts the UI for manual sessions or auto-approves for webhook sessions. Git commands are pre-approved via `--allowedTools 'Bash(git:*)'`.

### Additional Flags

| Flag | Purpose |
|------|---------|
| `--allowedTools "Bash(git:*) Edit"` | Whitelist specific tools or tool patterns |
| `--disallowedTools "Bash(rm:*)"` | Blacklist specific tools |
| `--add-dir /path` | Allow tool access to additional directories |
| `-p, --print` | Single-shot mode — **bypasses all permissions, avoid for interactive sessions** |
| `--dangerously-skip-permissions` | Bypass all permission checks (no control_requests generated) |

## Stdout Events

All events are newline-delimited JSON. One JSON object per line.

### system (init)

Emitted once at startup.

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/working/dir",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", ...],
  "model": "claude-opus-4-6"
}
```

The `session_id` may differ from what was passed via `--session-id` if the session couldn't be reused. The Hub captures the model name from this event and emits it via the `system_message` (init) WebSocket message.

### stream_event

Streaming content as it's generated. Three subtypes:

**content_block_start** — begins a text, tool_use, or thinking block:
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "content_block": {
      "type": "tool_use",
      "name": "Write",
      "id": "toolu_01ABC..."
    }
  },
  "session_id": "...",
  "parent_tool_use_id": null
}
```

The Hub processes `content_block_start` to:
- Emit `tool_active` for tool_use blocks (with the tool name)
- Detect `EnterPlanMode`/`ExitPlanMode` and emit `planning_mode` events
- Begin accumulating `thinkingText` for thinking blocks

**content_block_delta** — streaming data chunks:
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "delta": {
      "type": "text_delta",
      "text": "Here is the "
    }
  }
}
```

Delta types:
- `text_delta` — regular text output (`delta.text`), emitted as `output` to WebSocket
- `input_json_delta` — partial JSON for tool input (`delta.partial_json`), accumulated and parsed on block stop
- `thinking_delta` — internal reasoning (`delta.thinking`), summarized and emitted as `thinking` event

**content_block_stop** — end of block:
```json
{
  "type": "stream_event",
  "event": { "type": "content_block_stop" }
}
```

On block stop, the Hub:
- For thinking blocks: emits a `thinking` summary if not already emitted
- For tool_use blocks: parses the accumulated JSON input, generates a summary via `summarizeToolInput()`, processes task tools (TaskCreate/TaskUpdate/TodoWrite), and emits `tool_done`

### assistant

Full assistant message after completion (contains all content blocks):
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01ABC...",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_01ABC", "name": "Bash", "input": { "command": "ls" } }
    ],
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 100, "output_tokens": 50 }
  },
  "session_id": "...",
  "parent_tool_use_id": null
}
```

### user

Contains tool results after tool execution. These arrive as separate events from the assistant message:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC",
        "content": "file1.ts\nfile2.ts",
        "is_error": false
      }
    ]
  }
}
```

The Hub extracts `tool_result` blocks and emits them as `tool_output` WebSocket messages (content truncated to 2000 chars). Error results are flagged with `isError: true`.

### result

Signals end of turn. Always emitted. Ready for next stdin input.

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "Task completed successfully",
  "session_id": "...",
  "duration_ms": 5000,
  "total_cost_usd": 0.05
}
```

If `is_error` is true, the Hub emits a `system_message` (error) to clients. A `result` WebSocket message is always emitted to signal turn completion.

### control_request

Permission request for a tool that needs approval. **Must respond with `control_response` on stdin.**

```json
{
  "type": "control_request",
  "request_id": "req_01ABC...",
  "request": {
    "type": "tool",
    "tool_name": "Bash",
    "input": { "command": "npm test" },
    "description": "Run npm test"
  },
  "session_id": "..."
}
```

With `acceptEdits` mode + `PermissionRequest` hook, most permission decisions go through the hook system rather than `control_request` events. The `control_request` handler remains as fallback and for `AskUserQuestion`:
1. `AskUserQuestion` — forwarded as a prompt to the UI (user interaction, not permission)
2. `Bash` — forwarded to the session manager for registry check or UI prompt (fallback if hook doesn't fire)
3. All other tools — auto-approved (should not normally fire in `acceptEdits` mode)

### rate_limit_event

Emitted when the API rate limit is hit.

```json
{
  "type": "rate_limit_event"
}
```

## Stdin Messages

All stdin messages are newline-delimited JSON.

### User Message

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Write a hello world script"
  }
}
```

### Control Response

Response to a `control_request`. Uses a nested format with a `response` wrapper.

**Allow** (success):
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_01ABC...",
    "response": {
      "behavior": "allow",
      "updatedInput": {}
    }
  }
}
```

**Deny** (error):
```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "req_01ABC...",
    "error": "User denied permission"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `response.request_id` | string | Must match the `control_request.request_id` |
| `response.subtype` | `"success"` or `"error"` | Whether the tool is allowed or denied |
| `response.response.behavior` | `"allow"` | Only present for success responses |
| `response.response.updatedInput` | object | Modified tool input (required for allow; used for AskUserQuestion answers) |
| `response.error` | string | Error message (required for error/deny responses) |

**AskUserQuestion** uses `updatedInput` to pass answers back:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_01ABC...",
    "response": {
      "behavior": "allow",
      "updatedInput": {
        "questions": [...],
        "answers": { "Which approach?": "Option A" }
      }
    }
  }
}
```

## WebSocket Protocol (Hub ↔ Browser)

### Server → Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `connected` | `connectionId`, `claudeAvailable`, `claudeVersion`, `apiKeySet` | Initial handshake |
| `session_created` | `sessionId`, `sessionName`, `workingDir` | New session created |
| `session_joined` | `sessionId`, `sessionName`, `workingDir`, `active`, `outputBuffer` | Joined existing session (includes full history replay) |
| `session_left` | — | Left session |
| `session_deleted` | `message` | Session was deleted |
| `claude_started` | `sessionId` | Claude process spawned |
| `claude_stopped` | — | Claude process stopped |
| `output` | `data` | Streaming text from Claude (consecutive chunks merged in history) |
| `tool_active` | `toolName`, `toolInput?` | Tool execution started |
| `tool_done` | `toolName`, `summary?` | Tool execution completed (summary from `summarizeToolInput`) |
| `tool_output` | `content`, `isError?` | Tool result content (max 2000 chars) |
| `image` | `base64`, `mediaType` | Base64-encoded image from tool output (e.g. screenshots, diagrams) |
| `thinking` | `summary` | Brief summary of Claude's thinking (ephemeral, not persisted) |
| `planning_mode` | `active` | Entered/exited plan mode |
| `todo_update` | `tasks` | Task list changed (array of `{id, subject, status, activeForm?}`) |
| `prompt` | `promptType`, `question`, `options`, `multiSelect?`, `toolName?`, `toolInput?`, `requestId?` | Permission or question prompt |
| `system_message` | `subtype`, `text`, `model?` | System status (init, exit, error, restart, stall) |
| `user_echo` | `text` | Echo of user input (for history) |
| `result` | — | Turn completed, ready for input |
| `error` | `message` | Error from Claude process |
| `exit` | `code`, `signal` | Claude process exited (only when not auto-restarting) |
| `pong` | — | Heartbeat response |
| `diff_result` | `files`, `summary`, `branch`, `scope` | Diff viewer result (array of `DiffFile` objects with hunks/lines, a `DiffSummary`, current branch name, and scope) |
| `diff_error` | `message` | Diff viewer error |
| `sessions_updated` | — | Broadcast when the session list changes (creation, deletion, rename) |
| `session_name_update` | `sessionId`, `name` | Session was renamed (e.g. by auto-naming) |
| `webhook_event` | `event`, `repo`, `branch`, `workflow`, `conclusion`, `status`, `sessionId?` | GitHub webhook received (broadcast to all clients) |
| `workflow_event` | `eventType`, `runId`, `kind`, `stepKey?`, `status?`, `payload?` | Workflow engine lifecycle event (broadcast to all clients) |

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `token` | Authenticate the WebSocket connection (must be sent as first message) |
| `create_session` | `name`, `workingDir` | Create a new session (auto-starts Claude) |
| `join_session` | `sessionId` | Join an existing session (receives history via `outputBuffer`) |
| `leave_session` | — | Leave current session |
| `start_claude` | `options?` | Start Claude process in current session |
| `stop` | — | Stop Claude process |
| `input` | `data` | Send user message (also broadcasts `user_echo`) |
| `prompt_response` | `value`, `requestId?` | Answer a permission/question prompt |
| `resize` | `cols`, `rows` | Terminal resize (no-op in stream-json mode) |
| `ping` | — | Heartbeat |
| `get_diff` | `scope?` | Request diff (scope: `staged`, `unstaged`, or `all`; defaults to `all`) |
| `discard_changes` | `scope`, `paths?`, `statuses?` | Discard file changes by scope, optionally limited to specific paths |
| `set_model` | `model` | Switch the Claude model for the current session |

## Diff Viewer Types

The diff viewer uses these types in `diff_result` messages (defined in `src/types.ts`):

```typescript
type DiffScope = 'staged' | 'unstaged' | 'all'
type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

interface DiffFile {
  path: string
  status: DiffFileStatus
  oldPath?: string          // present when status is 'renamed'
  isBinary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

interface DiffHunk {
  header: string            // e.g. "@@ -10,6 +10,8 @@"
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  truncated: boolean
  truncationReason?: string // present when truncated is true
}
```

## Event Processing Pipeline

```
Claude CLI stdout (newline-delimited JSON)
       │
  ClaudeProcess.handleLine()
       │
       ├── system (init) ──→ emit 'system_init' with model name
       │
       ├── stream_event
       │    ├── content_block_start
       │    │    ├── tool_use ──→ emit 'tool_active' (or 'planning_mode' for plan tools)
       │    │    └── thinking ──→ begin accumulating thinking text
       │    ├── content_block_delta
       │    │    ├── text_delta ──→ emit 'text'
       │    │    ├── input_json_delta ──→ accumulate tool input JSON
       │    │    └── thinking_delta ──→ accumulate, emit 'thinking' summary
       │    └── content_block_stop
       │         ├── thinking block ──→ emit final 'thinking' summary
       │         └── tool_use block ──→ parse input, handle tasks, emit 'tool_done'
       │
       ├── user ──→ extract tool_result blocks ──→ emit 'tool_output'
       │
       ├── result ──→ emit 'result'
       │
       └── control_request
            ├── AskUserQuestion ──→ emit 'prompt' (question) with requestId
            ├── Bash ──→ emit 'control_request' to session manager
            └── other tools ──→ auto-approve via sendControlResponse
```

## Tool Summary Generation

When a tool completes (`content_block_stop`), the Hub generates a concise summary for the UI:

| Tool | Summary format |
|------|---------------|
| `Bash` | `$ <first line of command>` (with `...` if multiline) |
| `Read` | File path |
| `Write` / `Edit` | File path |
| `Glob` | Glob pattern |
| `Grep` | Search pattern |
| `Task` | Task description |
| `EnterPlanMode` | "Entering plan mode" |
| `ExitPlanMode` | "Exiting plan mode" |
| `TaskCreate` | Task subject |
| `TaskUpdate` | `#<id> → <status>` |
| `TaskList` | "Listing tasks" |
| `TaskGet` | `#<id>` |
| `TodoWrite` | `<n> tasks` |
| `TodoRead` | "Reading tasks" |

## Task Tracking

The Hub intercepts task-related tools to maintain a live task list:

- **TaskCreate** — adds a new task with `pending` status
- **TaskUpdate** — updates status/subject/activeForm, or deletes if `status: "deleted"`
- **TodoWrite** — replaces the entire task list (legacy tool)

On any change, a `todo_update` WebSocket message is broadcast with the full task array.

## Permission Flow

```
control_request from Claude CLI
       │
  ClaudeProcess.handleControlRequest()
       │
       ├── AskUserQuestion ──→ Parse questions, emit prompt to UI
       │                        User answers → control_response with updatedInput
       │
       ├── Bash ──→ Forward to SessionManager
       │              │
       │        ┌─────┴──────┐
       │        │  Registry  │  Check autoApprovedTools / autoApprovedCommands
       │        └─────┬──────┘
       │              │
       │        ┌─────┴──────┐
       │        │ Match?     │
       │        ├── Yes ─────→ Auto-approve (sendControlResponse "allow")
       │        │
       │        ├── No clients ──→ Auto-approve (prevent stall while user is away)
       │        │
       │        └── Has clients ──→ Broadcast prompt to WebSocket UI
       │                                  │
       │                            User clicks:
       │                            ├── Allow ──────→ sendControlResponse "allow"
       │                            ├── Always Allow → save to registry + "allow"
       │                            └── Deny ────────→ sendControlResponse "deny"
       │
       └── Other tools ──→ Auto-approve (sendControlResponse "allow")
```

## Auto-Approval Registry

Per-session sets persisted to `~/.codekin/sessions.json`:

- **`autoApprovedTools`** — tool names (e.g., `"Bash"`) approved for all inputs
- **`autoApprovedCommands`** — exact Bash command strings approved forever

When the user clicks "Always Allow":
- For Bash: the exact command string is saved to `autoApprovedCommands`
- For other tools: the tool name is saved to `autoApprovedTools`

The registry is checked before broadcasting a prompt to the UI. Matches are auto-approved without user interaction.

## Session Lifecycle

### Creation & Auto-Start
When a client sends `create_session`, the server creates the session and immediately spawns a Claude process (`startClaude`).

### Server Restart Recovery
On restart, sessions are restored from `~/.codekin/sessions.json` but Claude processes are not restarted. When a user next sends input, the Hub:
1. Detects no running Claude process
2. Spawns a new one
3. Rebuilds conversation context from `outputHistory` (user messages, assistant text, tool activity)
4. Sends the context + new input as a single message

### Auto-Restart on Crash
If a Claude process exits unexpectedly (not user-initiated):
- Up to 3 restart attempts within a 5-minute cooldown window
- 2-second delay between attempts
- `system_message` (restart) broadcast to clients on each attempt
- After 3 failures, `system_message` (error) and `exit` event broadcast

### Stall Detection
A 5-minute inactivity timer resets on every `text`, `tool_output`, `tool_active`, `tool_done`, or `result` event. If no activity occurs:
- `system_message` (stall) broadcast to clients

### Session Persistence
Sessions are saved to disk (debounced at 2 seconds) on:
- Session create/delete
- History updates (output chunks merged for consecutive `output` messages)
- Auto-approval registry changes
- Server shutdown

History is capped at 2000 entries.

## Tool Approval via HTTP (PreToolUse Hook)

The server exposes `POST /api/tool-approval` for external hook integration:

```json
POST /api/tool-approval
{
  "sessionId": "...",
  "toolName": "Bash",
  "toolInput": { "command": "rm -rf /" }
}
```

Response:
```json
{ "allow": true, "always": false }
```

This enables a PreToolUse hook script to call the Hub server and surface permission prompts in the web UI, even when the CLI itself uses `bypassPermissions`.

## Lessons Learned

1. **Never use `-p` for interactive sessions.** It bypasses all permissions and generates zero `control_request` events. Use stream-json flags alone.

2. **`default` permission mode silently denies Write/Edit** without generating `control_request` events. Use `acceptEdits` or `bypassPermissions`.

3. **`/proc/<pid>/cmdline` is unreliable for Node.js processes** — Node overwrites `process.title`, making spawn args invisible. Use logging instead.

4. **The `control_request` protocol only works in non-`-p` mode** with `--input-format stream-json --output-format stream-json`. The `-p` flag takes precedence and disables it entirely.

5. **Session processes inherit flags from spawn time.** Server restarts don't change flags for already-running Claude processes. Users must create new sessions or restart existing ones.

6. **Tool results arrive in `user` events, not `assistant` events.** The `assistant` event contains `tool_use` blocks, but the actual results (`tool_result`) come in subsequent `user` events.

7. **Claude session IDs cannot be reused after server restart.** The CLI rejects them with "already in use". The Hub sets `claudeSessionId: null` on restore to force fresh sessions.

8. **Auto-approve when no clients are connected** to prevent Claude from stalling indefinitely while the user is away. The approval prompt will never be seen, so blocking is worse than allowing.
