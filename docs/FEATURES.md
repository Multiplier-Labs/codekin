# Codekin — Feature Reference

Codekin is a web-based terminal UI for managing multiple Claude Code sessions. It provides real-time streaming, multi-session management, repository browsing, slash-command skills, file uploads, and a rich interactive chat interface — all accessible from a browser.

---

## Table of Contents

- [Multi-Session Management](#multi-session-management)
- [Real-Time Chat Interface](#real-time-chat-interface)
- [Streaming & Message Protocol](#streaming--message-protocol)
- [Tool Activity Display](#tool-activity-display)
- [Task Tracking (Todo Panel)](#task-tracking-todo-panel)
- [Planning Mode](#planning-mode)
- [Permission & Prompt Handling](#permission--prompt-handling)
- [Command Palette](#command-palette)
- [Repository Browser](#repository-browser)
- [Slash-Command Skills](#slash-command-skills)
- [Automated Workflows](#automated-workflows)
- [Modules](#modules)
- [Plugin Presets](#plugin-presets)
- [File Uploads & Attachments](#file-uploads--attachments)
- [Activity Indicators](#activity-indicators)
- [Session Persistence & Recovery](#session-persistence--recovery)
- [Auto-Restart & Stall Detection](#auto-restart--stall-detection)
- [Tool Approval Registry](#tool-approval-registry)
- [Settings & Configuration](#settings--configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Authentication & Security](#authentication--security)
- [Architecture Overview](#architecture-overview)

---

## Multi-Session Management

Codekin supports running multiple Claude Code sessions simultaneously, each bound to a different repository.

- **Session tabs** — A horizontal tab bar at the top of the screen shows all active sessions. Click a tab to switch between them instantly.
- **Session status indicators** — Each tab shows a colored dot: green for active (Claude is running), amber for waiting (pending user input), gray for inactive.
- **Create sessions** — Click the `+` button in the sidebar to create a new session. Choose a repository and optionally provide a custom session name.
- **Delete sessions** — Hover over a session tab to reveal a close button (`×`). Deleting a session kills its Claude process and removes it from the list.
- **Auto-join on reconnect** — When the WebSocket reconnects (e.g., after a network hiccup), Codekin automatically rejoins the last active session and restores its message history.
- **Session name convention** — Sessions auto-created from repos use the `hub:<repo-id>` naming pattern. The `hub:` prefix is stripped in the tab display for cleanliness.
- **Re-use existing sessions** — Opening a repo that already has a session will rejoin the existing session instead of creating a duplicate.

---

## Real-Time Chat Interface

The main content area is a chat view that renders messages from Claude, user input, system events, and tool activity.

- **Markdown rendering** — Assistant messages are rendered as full GitHub Flavored Markdown using `react-markdown` with `remark-gfm`. This supports tables, task lists, strikethrough, autolinks, and more.
- **Syntax highlighting** — Fenced code blocks are highlighted with language-specific coloring via `react-syntax-highlighter` using the VS Code Dark+ theme. The language is detected from the code fence (e.g., ` ```python `).
- **Inline code** — Inline backtick code renders with a subtle background for visual distinction.
- **User messages** — User input appears in a rounded bubble on the left, styled as a distinct message type.
- **System messages** — Color-coded system events show session lifecycle (init, exit, restart, stall, error). Each includes a status dot and optional model name (e.g., "Opus 4.6").
- **Timestamps** — Timestamps are displayed at minute boundaries between user/assistant messages (format: `HH:MM`).
- **Auto-scroll** — The chat automatically scrolls to the bottom as new messages arrive, but only if the user is already near the bottom. If the user has scrolled up to read older messages, auto-scroll is suppressed.
- **Scroll-to-bottom button** — When the user scrolls away from the bottom, a floating arrow button appears. Click it to jump to the latest messages.
- **Message history trim** — When the browser-side message list exceeds 500 entries, older messages are trimmed and a "Older messages trimmed" indicator is shown.
- **Configurable font size** — Text size can be adjusted from 10px to 24px via Settings.

---

## Streaming & Message Protocol

Codekin communicates with the backend over a WebSocket using structured JSON messages. Claude Code itself is spawned with `--output-format stream-json --input-format stream-json`, and the server parses the streaming output in real time.

- **60fps text streaming** — Text deltas from Claude are batched using `requestAnimationFrame` before rendering, delivering smooth ~60fps streaming updates even during fast output.
- **Incremental output merging** — Consecutive small text chunks are merged when under 100KB to reduce the total number of messages stored in history.
- **Structured event types** — The protocol defines distinct message types for: text output, tool invocations, tool completions, tool output, thinking summaries, planning mode, todo updates, permission prompts, question prompts, system events, and more.
- **Bidirectional communication** — The client can send user input, prompt responses, session management commands (create, join, leave), and process control (start, stop) over the same WebSocket connection.
- **Keepalive pings** — 30-second heartbeat pings detect dead connections and trigger automatic reconnection with exponential backoff (up to 30 seconds).

---

## Tool Activity Display

When Claude invokes tools (Read, Write, Edit, Bash, Grep, Glob, Task, etc.), the UI shows a compact, interactive summary.

- **Grouped tool runs** — Consecutive tool invocations and their outputs are grouped into a single collapsible "tool activity" block showing the count and tool names (e.g., "3 tool calls — Read, Edit, Bash").
- **Active tool indicator** — Tools currently in progress show a pulsing gold dot next to their name.
- **Tool summaries** — Each tool shows a one-line summary: Bash shows the command, Read/Write/Edit shows the file path, Glob/Grep shows the search pattern, Task shows the description.
- **Collapsible output** — Tool output longer than 3 lines is collapsed by default with a "▾ N more lines" toggle. Error output is colored red.
- **Auto-expand for active tools** — Tool groups with currently-running tools are automatically expanded so you can see what's happening in real time.
- **Error count badge** — If any tool outputs contain errors, the group header shows an error count (e.g., "(1 error)").

---

## Task Tracking (Todo Panel)

When Claude creates a task list (via `TodoWrite`), a floating panel appears in the bottom-right corner of the chat.

- **Task status icons** — Pending tasks show an empty circle, in-progress tasks show a pulsing gold dot, completed tasks show a green checkmark with strikethrough text.
- **Progress counter** — The panel header shows completion progress (e.g., "3/5").
- **Active form labels** — In-progress tasks can show an active form (e.g., "Running tests..." instead of "Run tests").
- **Collapsible** — Click the header to collapse/expand the task list.
- **Auto-expand on new tasks** — When new tasks are added, the panel automatically re-expands if it was collapsed.
- **Auto-hide on completion** — Once all tasks are completed, the panel hides after 10 seconds. If all tasks were already complete when the session was joined (history restore), it hides immediately.

---

## Planning Mode

When Claude enters plan mode, the UI provides visual feedback.

- **Plan mode banner** — A sticky banner appears at the top of the chat with a pulsing gold dot and "Plan Mode" label, indicating Claude is in planning rather than execution mode.
- **Mode transition messages** — "Entered plan mode" and "Exited plan mode" messages are displayed inline in the chat.

---

## Permission & Prompt Handling

Codekin provides an interactive UI for responding to Claude's permission requests and questions.

- **Permission prompts** — When Claude wants to run a tool that requires approval (like Bash commands), three buttons appear: **Allow** (green), **Always Allow** (blue), and **Deny** (red). The tool name and command are displayed for review.
- **Question prompts** — When Claude asks the user a question (via `AskUserQuestion`), the options appear as clickable buttons with descriptions. A text input is also provided for custom responses.
- **Multi-select prompts** — Some questions support selecting multiple answers. Checkboxes appear next to each option, and a "Confirm" button sends all selections at once.
- **Always Allow registry** — Clicking "Always Allow" saves the tool and command pattern to the session's auto-approval registry. Future identical requests are approved automatically without prompting.
- **Auto-deny on disconnect** — When no clients are connected to a session and a pending tool approval times out, it is automatically denied to prevent hung processes.
- **60-second timeout** — Pending tool approvals time out after 60 seconds to prevent indefinitely stuck processes.

---

## Command Palette

A fuzzy-search command palette accessible via `Ctrl+K` (or `Cmd+K` on macOS).

- **Unified search** — Search across repos, skills, modules, presets, and actions from a single input field.
- **Categorized results** — Results are grouped under headings: Repos, Skills, Modules, Presets, Actions.
- **Fuzzy matching** — Search matches against names, tags, commands, and descriptions.
- **One-click actions** — Select a repo to open it in a new session, a skill to insert its command, a module to send its content, a preset to install its plugins, or Settings to open the settings modal.
- **Visual icons** — Repos show a square icon, skills show a slash (`/`), modules show a diamond, presets show their emoji icon.

---

## Repository Browser

The initial screen (when no session is active) shows a browsable list of repositories.

- **Grouped by owner** — Repositories are organized under their owner/organization name with sticky section headers.
- **Repo metadata** — Each repo shows its name, description, and tags.
- **Clone status** — Cloned repos show a branch icon; remote-only repos show a remote icon.
- **Clone on demand** — Clicking a remote repo triggers cloning with a loading indicator, then opens a session once ready.

---

## Slash-Command Skills

Skills are slash commands that expand into templated prompts sent to Claude.

- **Skill menu** — Click the terminal icon in the input bar to see a dropdown of available skills, grouped by Global and Repo-specific.
- **Skill expansion** — Typing a slash command (e.g., `/validate-gemini fix the bug`) expands the command into the skill's full template content. The `$ARGUMENTS` placeholder is replaced with any text after the command.
- **Display text** — When a skill is expanded, the original short command is shown in the chat as the user message, while the full expansion is sent to Claude behind the scenes.
- **Built-in skills**:
  - `/validate-gemini` — Asks Gemini to critique/validate the current change or solution.
  - `/validate-gpt` — Asks GPT to critique/validate the current change or solution.
- **Repo-specific skills** — Repositories can define their own skills in `.claude/skills/` directories, which appear automatically when that repo's session is active.
- **Discoverable** — Skills appear in the command palette, the skill menu, and the skill browser.

---

## Automated Workflows

Codekin can run scheduled Claude Code sessions against repositories to produce structured reports — code reviews, security audits, coverage assessments, and more.

- **Scheduled runs** — Workflows are triggered by per-repo cron schedules. Each run creates a dedicated Claude session, sends the workflow prompt, waits for output, and saves the result as a dated Markdown file committed to the repo.
- **Built-in workflow types**:
  - `code-review.daily` — Daily review of code quality, bugs, security, and test gaps
  - `security-audit.weekly` — Weekly scan for vulnerabilities, hardcoded secrets, and auth issues
  - `complexity.weekly` — Weekly analysis of large files, complex functions, and coupling problems
  - `coverage.daily` — Daily test coverage assessment with uncovered file list and test proposals
  - `comment-assessment.daily` — Daily audit of comment quality, documentation gaps, and outdated comments
  - `dependency-health.daily` — Daily check for outdated packages, CVEs, and abandoned dependencies
- **Per-repo overrides** — Any workflow's prompt can be customized for a specific repo by placing a `.codekin/workflows/{kind}.md` file in the repo. The override prompt replaces the global one at run time.
- **MD-based definitions** — Workflow types are defined as Markdown files with YAML frontmatter in `server/workflows/`. New workflow types can be added by dropping a `.md` file there — no code changes needed.
- **Staleness check** — Workflows accept a `sinceTimestamp` parameter; if no commits have been made since the last run, the workflow is skipped automatically.
- **Auto-committed reports** — Output is saved to a configurable directory within the repo (e.g. `review logs/`, `security-reports/`) and committed with a configurable message.

See [docs/WORKFLOWS.md](./WORKFLOWS.md) for the full workflow definition format, frontmatter field reference, and instructions for writing per-repo overrides.

---

## Modules

Modules are reusable blocks of context or instructions that can be sent to Claude in one click.

- **Module browser** — Click the book icon in the sidebar to browse available modules.
- **Global and repo-specific** — Modules can be defined globally or per-repository.
- **One-click send** — Click a module to send its full content as a user message wrapped in `[Module: name]` markers.
- **Use cases** — Modules are useful for sending coding guidelines, project context, or recurring instructions without retyping them.

---

## Plugin Presets

Pre-configured bundles of plugins for common development stacks.

- **Available presets**:
  - **TS/React** — TypeScript LSP + GitHub + Commit commands
  - **Python** — Pyright LSP + GitHub + Commit commands
  - **Rust** — rust-analyzer LSP + GitHub + Commit commands
  - **Full Stack** — TypeScript + Python LSPs + GitHub + Commit commands + PR review toolkit
- **One-click install** — Click a preset to send sequential `/plugin install` commands for all its plugins.
- **Preset browser** — Accessible from the packages icon in the sidebar. Shows preset name, description, icon, and plugin count.

---

## File Uploads & Attachments

Files can be attached to messages and sent to Claude for analysis.

- **Drag and drop** — Drag files anywhere onto the chat window. A drop zone overlay appears with an upload icon.
- **Paste from clipboard** — Paste images directly from the clipboard (Ctrl+V / Cmd+V).
- **File picker** — Click the paperclip icon in the input bar to open a native file picker. Multiple files can be selected.
- **Pending file chips** — Selected files appear as removable chips above the input textarea, showing truncated filenames with an `×` button.
- **Upload progress** — A status banner shows "Uploading files..." during upload and "Upload failed: ..." on error.
- **Server-side handling** — Files are uploaded via `/api/upload` on the main server and stored in `~/.codekin/screenshots/` (configurable via `SCREENSHOTS_DIR`). The returned file paths are prepended to the user's message as `[Attached files: /path/to/file]`.

---

## Activity Indicators

The UI provides multiple visual cues about what Claude is doing.

- **Activity label** — A text label above the input bar shows Claude's current activity:
  - "Writing..." — Claude is streaming text output.
  - "Running Bash..." / "Running Read..." — Claude is executing a specific tool.
  - "Thinking: [summary]" — Claude is thinking, with a summary of the thinking content.
  - "Thinking..." — Claude is processing but no summary is available yet.
- **Thinking indicator** — Three bouncing dots with "Thinking..." text appear at the bottom of the chat when Claude is processing between content blocks.
- **Connection status dot** — A colored dot in the bottom of the sidebar shows: green (connected), amber (connecting/reconnecting), red (disconnected).
- **Pulsing dots** — Active tools, waiting sessions, and in-progress tasks all show animated pulsing gold dots.

---

## Session Persistence & Recovery

Sessions survive server restarts and browser refreshes.

- **Disk persistence** — All session metadata (ID, name, working directory, Claude session ID, output history, auto-approved tools) is persisted to `~/.codekin/sessions.json`. Persistence is debounced to avoid excessive I/O.
- **Output history** — Each session stores up to 2000 messages of output history on the server. When a client joins a session, the last 500 messages are sent as an output buffer for immediate replay.
- **Context rebuilding** — When Claude's process needs to restart, the session's output history is converted to a natural language context summary and fed to the new Claude process as a system prompt, allowing it to resume where it left off.
- **Browser persistence** — The active session ID is stored in `localStorage`, so refreshing the page automatically rejoins the last active session.

---

## Auto-Restart & Stall Detection

Codekin includes resilience features to handle process failures and stalls.

- **Auto-restart** — If Claude's process exits unexpectedly, it automatically restarts up to 3 times. After 3 consecutive restarts, a 5-minute cooldown period begins before the restart counter resets.
- **Stall detection** — If no output is received from Claude for 5 minutes, a stall warning system message is displayed to the user.
- **User-initiated stop** — When the user explicitly stops Claude (via Ctrl+C or the stop button), auto-restart is suppressed.
- **Restart notification** — A yellow system message indicates when Claude has been auto-restarted.

---

## Tool Approval Registry

A per-session registry that remembers which tools and commands have been approved.

- **Auto-approved tools** — Tools and Bash command patterns that have been "Always Allowed" are stored per-session.
- **Persistent across restarts** — The registry is saved to disk as part of the session data.
- **Granular control** — Approvals are specific to tool name and command pattern, not blanket approvals.

---

## Settings & Configuration

- **Authentication token** — Enter your cc-web token in the Settings modal. The token is validated in real time with a checkmark (valid) or cross (invalid) indicator.
- **Font size** — Adjustable from 10px to 24px via a slider in Settings.
- **Persistent** — Settings are stored in `localStorage` under the key `codekin-settings`.
- **Auto-open** — The Settings modal opens automatically on first visit when no token is configured.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `Cmd+K` | Open command palette |
| `Enter` | Send message |
| `Shift+Enter` | Insert newline in input |
| `Ctrl+C` | Send interrupt signal (SIGINT) to Claude |
| `Escape` | Close dropdowns, modals, and blur input |

---

## Authentication & Security

- **Token-based auth** — The WebSocket connection and REST API are authenticated using a shared token (generated with `openssl rand -hex 32`).
- **Authelia integration** — The production deployment sits behind Authelia for user authentication at the nginx layer.
- **CORS configuration** — The `CORS_ORIGIN` environment variable controls allowed origins (defaults to `*`).
- **Disabled state** — When no token is configured, the chat area shows an overlay prompting the user to configure their token. Input is disabled.
- **Logout** — A logout button in the sidebar redirects to the Authelia logout endpoint.

---

## Architecture Overview

```
Browser (React SPA)
  ↕ WebSocket + REST
nginx (port 443, HTTPS)
  ├── /      → Static files (web root)
  └── /cc/   → cc-web server (port 32352) — WebSocket + REST + uploads
                    ↕
               Claude Code CLI
               (spawned per-session with stream-json format)
```

### Services

| Service | Port | Role |
|---|---|---|
| nginx | 443 | Reverse proxy, SSL termination, Authelia auth |
| cc-web server | 32352 | Session management, Claude process lifecycle, real-time streaming, file uploads, repository listing |

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, TailwindCSS 4, TypeScript |
| Backend | Node.js, Express, ws (WebSocket) |
| CLI | Claude Code with stream-json protocol |
| Auth | Authelia + token-based |
| Proxy | nginx with SSL (Let's Encrypt) |
| Fonts | Inconsolata (monospace), Lato (sans-serif) |
